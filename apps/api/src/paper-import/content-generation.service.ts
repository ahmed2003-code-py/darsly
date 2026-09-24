import { Injectable, Logger } from '@nestjs/common';
import { PaperImport, PaperImportPage, Prisma } from '@prisma/client';
import { withAiTrace } from '../academy-site/ai/ai-trace';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProvider } from '../storage/storage.provider';
import { DraftQuestion, DraftWarning, ExamDraft } from './extraction.schema';
import { ExamSpec, normalizeSpec, PlannedQuestion, specFromQuestions } from './exam-spec';
import { gradeQuestions, findDuplicates, GradedQuestion } from './question-quality';
import { QuestionGeneratorService } from './question-generator.service';
import { SourceReaderService } from './source-reader.service';
import { PagePhase } from './ocr/transcriber.service';
import { GenerationProfileName, PaperImportConfig } from './paper-import.config';
import { acceptOne, GenerationReport, GenerationRun } from './generation-run';
import {
  chunkSource,
  normalizePageText,
  selectChunksForQuestion,
  SourceChunk,
  SourcePage,
  stripRunningLines,
} from './source-text';

/**
 * The content path: lecture material in, an exam draft out.
 *
 * Two phases, run as two jobs on the queue that already exists, because a
 * teacher has to speak in between them. Reading the material happens as soon
 * as it is uploaded — it is cheap, mostly free, and it is what tells us
 * whether there is anything here at all. Writing the questions waits until the
 * teacher has said how many and of what kind, because generating first and
 * asking afterwards is a bill for a guess.
 *
 * Both phases write their progress to the session row as they go, so the
 * screen draws what the worker has actually done rather than an animation.
 */
@Injectable()
export class ContentGenerationService {
  private readonly logger = new Logger(ContentGenerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageProvider,
    private readonly reader: SourceReaderService,
    private readonly generator: QuestionGeneratorService,
    private readonly config: PaperImportConfig,
  ) {}

  // ── phase one: read the material ─────────────────────────────────────────

  /**
   * Get the words off every page, then cut them into chunks.
   *
   * A page that arrived with a text layer costs nothing at all — that is most
   * of a lecture exported from slides or a word processor, and it is why this
   * phase is usually free. Only a scan is read by a model.
   */
  async read(record: PaperImport & { pages: PaperImportPage[] }): Promise<{ millicents: number }> {
    const pages = record.pages.filter((p) => p.status === 'PENDING' || p.status === 'FAILED');
    await this.prisma.paperImport.update({
      where: { id: record.id },
      data: {
        stage: 'READING',
        status: 'PROCESSING',
        progressDone: record.pages.length - pages.length,
        progressTotal: record.pages.length,
        error: null,
      },
    });

    let millicents = 0;
    let done = record.pages.length - pages.length;
    const started = Date.now();
    const perPage: { page: number; ms: number; millicents: number }[] = [];
    let stopped = false;

    // Pages are independent — the chunker orders them by page number once
    // they are all in — so a few are read at once instead of one after
    // another. Bounded: each page already reads its crops several at a time.
    const queue = [...pages];
    const worker = async () => {
      for (let page = queue.shift(); page && !stopped; page = queue.shift()) {
        // Put down while reading — stopped or deleted from the drafts list:
        // start no more pages. One already being read finishes, and is paid
        // for; nothing new is started.
        const live = await this.prisma.paperImport.findFirst({
          where: { id: record.id, deletedAt: null, status: { not: 'CANCELED' } },
          select: { id: true },
        });
        if (!live) {
          stopped = true;
          return;
        }
        const t0 = Date.now();
        const result = await this.readOne(record.id, page);
        perPage.push({ page: page.pageNumber, ms: Date.now() - t0, millicents: result.millicents });
        millicents += result.millicents;
        done += 1;
        await this.prisma.paperImport.update({
          where: { id: record.id },
          data: { progressDone: done },
        });
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.max(1, Math.min(this.config.contentReadConcurrency, pages.length)) },
        worker,
      ),
    );

    const summary = {
      importId: record.id,
      pages: perPage.sort((x, y) => x.page - y.page),
      durationMs: Date.now() - started,
      millicents,
      concurrency: this.config.contentReadConcurrency,
    };
    if (stopped) {
      // What was read before the stop was still paid for.
      await this.prisma.paperImport.update({
        where: { id: record.id },
        data: { costCents: { increment: Math.ceil(millicents / 1000) } },
      });
      this.logger.log(`READ_SUMMARY ${JSON.stringify({ ...summary, stopped: true })}`);
      this.logger.log(`Import ${record.id}: stopped by its owner after ${done} page(s)`);
      return { millicents };
    }

    const chunks = await this.buildChunks(record.id);
    this.logger.log(`READ_SUMMARY ${JSON.stringify({ ...summary, chunks })}`);
    this.logger.log(
      `Import ${record.id}: read ${record.pages.length} page(s) into ${chunks} chunk(s), ` +
        `${(millicents / 1000).toFixed(2)}¢`,
    );

    await this.prisma.paperImport.update({
      where: { id: record.id },
      data: {
        // The teacher's turn: nothing is generated until they say what they
        // want. `READY` here means "the reading stage is done", not "the exam
        // is done" — the status is what says which.
        status: chunks ? 'CONFIGURING' : 'FAILED',
        stage: 'READY',
        error: chunks ? null : 'No readable teaching material was found in the uploaded files',
        // Reading is part of what the exam cost. It was left out of the
        // session's total, which then said 13¢ for an exam that cost 25¢.
        costCents: { increment: Math.ceil(millicents / 1000) },
      },
    });
    return { millicents };
  }

  private async readOne(importId: string, page: PaperImportPage): Promise<{ millicents: number }> {
    // Free first: a text layer was extracted at upload time and costs nothing.
    if (page.textKey) {
      try {
        const text = (await this.storage.getBuffer(page.textKey)).toString('utf8');
        await this.prisma.paperImportPage.update({
          where: { id: page.id },
          data: { status: 'EXTRACTED', error: null, attempts: { increment: 1 } },
        });
        return { millicents: text.trim() ? 0 : 0 };
      } catch {
        // Fall through to reading the picture.
      }
    }

    if (!page.renderKey) {
      await this.prisma.paperImportPage.update({
        where: { id: page.id },
        data: { status: 'FAILED', error: 'Page has no stored content', attempts: { increment: 1 } },
      });
      return { millicents: 0 };
    }

    let image: Buffer;
    try {
      image = await this.storage.getBuffer(page.renderKey);
    } catch (e) {
      await this.prisma.paperImportPage.update({
        where: { id: page.id },
        data: {
          status: 'FAILED',
          error: `Stored page could not be read: ${(e as Error).message}`.slice(0, 500),
          attempts: { increment: 1 },
        },
      });
      return { millicents: 0 };
    }

    // What is happening to this page, as it happens — the progress screen
    // shows it. Chained so writes land in order, never awaited by the reading.
    let reported: Promise<unknown> = Promise.resolve();
    const onPhase = (p: PagePhase) => {
      reported = reported
        .then(() =>
          this.prisma.paperImportPage.update({
            where: { id: page.id },
            data: {
              phase: p.phase,
              phaseDone: 'done' in p ? p.done : null,
              phaseTotal: 'total' in p ? p.total : null,
            },
          }),
        )
        .catch(() => undefined);
    };
    const result = await withAiTrace({ pageNumber: page.pageNumber }, () =>
      this.reader.readPage({ pageNumber: page.pageNumber, image, onPhase }),
    );
    await reported;
    const usable = !result.error && !result.blank && result.text.trim().length > 0;

    if (usable) {
      const textKey = `paper-imports/${importId}/text/${page.pageNumber}.txt`;
      await this.storage.put(textKey, Buffer.from(result.text, 'utf8'), {
        contentType: 'text/plain; charset=utf-8',
      });
      await this.prisma.paperImportPage.update({
        where: { id: page.id },
        data: {
          phase: null,
          status: result.escalated ? 'ESCALATED' : 'EXTRACTED',
          textKey,
          model: result.model,
          escalationReason: result.escalated ? 'LOW_CONFIDENCE' : null,
          attempts: { increment: 1 },
          error: null,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costMillicents: result.millicents,
        },
      });
    } else {
      await this.prisma.paperImportPage.update({
        where: { id: page.id },
        data: {
          // A blank page is not a failure — a cover sheet is a legitimate
          // thing to upload and there is simply nothing on it.
          status: result.blank ? 'SKIPPED' : 'FAILED',
          phase: null,
          model: result.model,
          attempts: { increment: 1 },
          error: result.error,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costMillicents: result.millicents,
        },
      });
    }
    return { millicents: result.millicents };
  }

  /** Clean the pages, drop the running header, cut into chunks, store them. */
  private async buildChunks(importId: string): Promise<number> {
    const rows = await this.prisma.paperImportPage.findMany({
      where: { importId, textKey: { not: null } },
      orderBy: { pageNumber: 'asc' },
    });

    const pages: SourcePage[] = [];
    for (const row of rows) {
      try {
        const raw = (await this.storage.getBuffer(row.textKey!)).toString('utf8');
        pages.push({
          // The teacher's own file name, so a source reference reads
          // "biology.pdf — page 8" rather than "3.jpg — page 8".
          file: row.originalName || row.originalKey.split('/').pop() || 'source',
          page: row.pageNumber,
          text: normalizePageText(raw),
        });
      } catch {
        // A page whose text vanished is a page we generate without.
      }
    }

    const chunks = chunkSource(stripRunningLines(pages));
    await this.prisma.$transaction([
      this.prisma.examSourceChunk.deleteMany({ where: { importId } }),
      ...chunks.map((c) =>
        this.prisma.examSourceChunk.create({
          data: {
            importId,
            index: c.index,
            text: c.text,
            sourceFile: c.sourceFile,
            page: c.page,
            tokensApprox: c.tokensApprox,
          },
        }),
      ),
    ]);
    return chunks.length;
  }

  // ── phase two: write the questions ───────────────────────────────────────

  /**
   * Write the exam the teacher asked for, from the chunks.
   *
   * The work is GenerationRun's — slots, bounded rounds, a budget, luna and
   * sol only. What is here is the session: whether it is still wanted, what
   * the teacher is shown while it runs, and what is written when it ends.
   *
   * An exam that comes out short is saved as what it is — the questions that
   * passed, a spec that matches them, and a warning that says how many of
   * which type are missing and why. It is never presented as the exam that
   * was ordered.
   */
  async generate(
    record: PaperImport,
    opts: { profile?: GenerationProfileName; budgetCents?: number } = {},
  ): Promise<{ millicents: number; report?: GenerationReport }> {
    const asked = normalizeSpec(record.spec as never);
    const generationStarted = new Date();
    const chunks = await this.chunksOf(record.id);

    if (!chunks.length) {
      await this.fail(record.id, 'NO_SOURCE');
      return { millicents: 0 };
    }

    const profile = this.config.generationProfileOf(opts.profile);
    await this.prisma.paperImport.update({
      where: { id: record.id },
      data: {
        stage: 'GENERATING',
        status: 'PROCESSING',
        progressDone: 0,
        progressTotal: asked.questionCount,
        error: null,
        generationBatches: 0,
        escalatedChunks: 0,
      },
    });

    // Stopped from the screen: `cancel` moves the session back to its
    // settings form (or deletes it), and nothing after that may be started.
    const isLive = async () =>
      !!(await this.prisma.paperImport.findFirst({
        where: { id: record.id, deletedAt: null, status: 'PROCESSING', stage: 'GENERATING' },
        select: { id: true },
      }));

    const { questions, report } = await withAiTrace({ phase: 'GENERATE' }, () =>
      new GenerationRun(this.generator, this.config).run({
        importId: record.id,
        asked,
        chunks,
        profile,
        budgetMillicents: (opts.budgetCents ?? this.config.generationBudgetCents) * 1000,
        isLive,
        onProgress: async (done, calls) => {
          await this.prisma.paperImport.updateMany({
            where: { id: record.id, status: 'PROCESSING' },
            data: { progressDone: done, generationBatches: calls },
          });
        },
      }),
    );
    const millicents = report.millicents;
    const costCents = Math.ceil(millicents / 1000);

    if (report.stopReason === 'CANCELED') {
      // What was spent is still spent; the session is left as its owner left it.
      await this.prisma.paperImport.update({
        where: { id: record.id },
        data: { costCents: { increment: costCents } },
      });
      this.logger.log(`Import ${record.id}: generation stopped by its owner`);
      return { millicents, report };
    }

    // ── the deterministic gate ────────────────────────────────────────────
    const numbered = questions.map((q, i) => ({ ...q, number: i + 1 }));
    const findings = gradeQuestions(numbered, undefined, { requireGrounding: true });
    const warnings: DraftWarning[] = [];

    // The spec is rewritten to match the exam that actually exists, so
    // "change the settings" opens the real numbers; the warning below says
    // what was ordered and what is missing.
    const finalSpec: ExamSpec =
      numbered.length < asked.questionCount ? specFromQuestions(asked, numbered) : asked;

    if (report.variants > 0) {
      warnings.push({
        code: 'COMPLETED_WITH_VARIANTS',
        params: {
          variants: report.variants,
          fromMaterial: report.distinct,
          wanted: asked.questionCount,
        },
        detail:
          `The material supported ${report.distinct} distinct questions; ` +
          `${report.variants} more were written as variants of them.`,
      });
    }

    if (!report.complete) {
      const shortfall = {
        got: numbered.length,
        wanted: asked.questionCount,
        mcq: finalSpec.types.MCQ,
        trueFalse: finalSpec.types.TRUE_FALSE,
        written: finalSpec.types.SHORT_ANSWER,
        missingMcq: report.missingByType.MCQ ?? 0,
        missingTrueFalse: report.missingByType.TRUE_FALSE ?? 0,
        missingWritten: report.missingByType.SHORT_ANSWER ?? 0,
      };
      // The material is the limit only when it is: a run that stopped on its
      // budget or its round limit must not tell the teacher to upload more.
      warnings.push(
        report.stopReason === 'MATERIAL'
          ? {
              code: 'NOT_ENOUGH_CONTENT',
              params: { ...shortfall, supportable: numbered.length },
              detail: `The uploaded material supports ${numbered.length} of the ${asked.questionCount} questions requested.`,
            }
          : {
              code: 'GENERATION_INCOMPLETE',
              params: { ...shortfall, reason: report.stopReason ?? 'ROUNDS' },
              detail:
                `${numbered.length} of ${asked.questionCount} questions were written ` +
                `(stopped: ${report.stopReason}); missing ` +
                `${shortfall.missingMcq} multiple choice, ${shortfall.missingTrueFalse} true/false, ` +
                `${shortfall.missingWritten} written.`,
            },
      );
    }
    for (const dup of findDuplicates(numbered)) {
      const q = numbered.find((x) => x.id === dup.id);
      if (q) q.needsReview = true;
      warnings.push({
        code: 'DUPLICATE_QUESTION',
        params: { number: q?.number ?? 0 },
        detail: `Question ${q?.number} repeats an earlier one.`,
      });
    }
    for (const finding of findings) {
      if (finding.problem === 'DUPLICATE' || finding.problem === 'COUNT_SHORT') continue;
      const q = numbered.find((x) => x.number === finding.number);
      if (q) q.needsReview = true;
    }

    const draft: ExamDraft = {
      title: asked.title || '',
      instructions: asked.instructions,
      sections: [{ title: '', questions: numbered.map(stripGrading) }],
    };

    // Guarded: a stop that landed after the last call must still win.
    const written = await this.prisma.paperImport.updateMany({
      where: { id: record.id, status: 'PROCESSING', deletedAt: null },
      data: {
        status: numbered.length ? 'REVIEW' : 'FAILED',
        stage: 'READY',
        error: numbered.length
          ? null
          : report.stopReason === 'BUDGET'
            ? 'The generation budget ran out before any question was written'
            : 'No questions could be written from this material',
        title: draft.title,
        draft: draft as unknown as Prisma.InputJsonValue,
        spec: finalSpec as unknown as Prisma.InputJsonValue,
        warnings: warnings as unknown as Prisma.InputJsonValue,
        generationBatches: report.calls,
        // Slots written on the fallback model — the number that says whether
        // the cheap-first profile is holding up.
        escalatedChunks: report.callLog.filter((c) => c.model !== profile.primary.model).length,
        costCents: { increment: costCents },
        progressDone: numbered.length,
        progressTotal: asked.questionCount,
      },
    });
    if (!written.count) {
      await this.prisma.paperImport.update({
        where: { id: record.id },
        data: { costCents: { increment: costCents } },
      });
    }

    await this.logExamSummary(record, report, generationStarted);
    this.logger.log(
      `Import ${record.id}: ${numbered.length}/${asked.questionCount} question(s) in ` +
        `${report.calls} call(s) on ${profile.name}, ${(millicents / 1000).toFixed(2)}¢` +
        (report.complete ? '' : ` — PARTIAL (${report.stopReason})`),
    );
    return { millicents, report };
  }

  /**
   * Rewrite one question.
   *
   * Small enough to answer in the request that asked for it: one question,
   * one call, a few seconds. Queuing it would mean a teacher watching a
   * spinner for a job that finishes before the poll does.
   */
  async regenerateOne(
    record: PaperImport,
    questionId: string,
    reason?: string,
  ): Promise<{ question: DraftQuestion | null; millicents: number; error: string | null }> {
    const spec = normalizeSpec(record.spec as never);
    const draft = record.draft as unknown as ExamDraft;
    const all = (draft?.sections ?? []).flatMap((s) => s.questions);
    const existing = all.find((q) => q.id === questionId);
    if (!existing) return { question: null, millicents: 0, error: 'NOT_FOUND' };

    const chunks = await this.chunksOf(record.id);
    const material = selectChunksForQuestionOf(chunks, existing);
    const planned: PlannedQuestion = {
      index: existing.number,
      type: (existing.type === 'UNSUPPORTED' ? 'SHORT_ANSWER' : existing.type) as never,
      difficulty: 'MEDIUM',
      marks: existing.marks ?? 1,
    };

    const result = await this.generator.regenerateOne({
      planned,
      chunks: material,
      language: spec.language,
      // Every other question, so the rewrite is not a copy of one of them.
      avoid: all.filter((q) => q.id !== questionId).map((q) => q.text),
      reason,
    });
    const written = result.questions[0];
    if (!written) {
      return { question: null, millicents: result.millicents, error: result.error ?? 'EMPTY' };
    }

    const { question: graded } = acceptOne(
      written,
      planned,
      material,
      all.filter((q) => q.id !== questionId),
      spec.language === 'AUTO',
    );
    if (!graded) {
      return { question: null, millicents: result.millicents, error: 'REJECTED' };
    }
    return {
      question: { ...stripGrading(graded), id: existing.id, number: existing.number },
      millicents: result.millicents,
      error: null,
    };
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * One line that says what this exam cost and how long each part took.
   *
   * Everything in it is measured: OCR cost from the pages' own records, OCR
   * time from the recorded calls (first start to last finish), generation from
   * the run itself. The gap between reading and writing is the teacher filling
   * in the settings, and is reported as that rather than as system time.
   * Costs are the application's (provider-reported tokens at configured
   * prices), not the invoice.
   */
  private async logExamSummary(
    record: PaperImport,
    report: GenerationReport,
    generationStarted: Date,
  ): Promise<void> {
    try {
      const pages =
        (await this.prisma.paperImportPage.findMany({
          where: { importId: record.id },
          select: { costMillicents: true },
        })) ?? [];
      const reads =
        ((await (this.prisma as any).aiCallLog
          ?.findMany({
            where: { importId: record.id, phase: 'READ' },
            select: { startedAt: true, latencyMs: true, model: true },
          })
          .catch(() => [])) as { startedAt: Date; latencyMs: number; model: string }[]) ?? [];
      const ocrMillicents = pages.reduce((n, p) => n + (p.costMillicents ?? 0), 0);
      const first = reads.length ? Math.min(...reads.map((r) => +r.startedAt)) : null;
      const last = reads.length ? Math.max(...reads.map((r) => +r.startedAt + r.latencyMs)) : null;
      const ocrMs = first != null && last != null ? last - first : null;
      const byModel: Record<string, number> = { ...report.callsByModel };
      for (const r of reads) byModel[r.model] = (byModel[r.model] ?? 0) + 1;
      const created = record.createdAt ? +new Date(record.createdAt) : null;
      const summary = {
        importId: record.id,
        profile: report.profile,
        ocr: { millicents: ocrMillicents, durationMs: ocrMs, calls: reads.length },
        generation: {
          millicents: report.millicents,
          durationMs: report.durationMs,
          calls: report.calls,
          rounds: report.rounds,
        },
        total: {
          millicents: ocrMillicents + report.millicents,
          // Time the system spent working, excluding the teacher's turn.
          systemMs: (ocrMs ?? 0) + report.durationMs,
        },
        waits: {
          uploadToFirstReadMs: created != null && first != null ? first - created : null,
          teacherConfiguringMs: last != null ? +generationStarted - last : null,
          wallSinceUploadMs: created != null ? Date.now() - created : null,
        },
        questions: {
          requested: report.requested,
          accepted: report.accepted,
          variants: report.variants,
          missingByType: report.missingByType,
          stopReason: report.stopReason,
        },
        callsByModel: byModel,
        rejections: report.rejections,
        source: { capacity: report.sourceCapacity, sufficient: report.sourceSufficient },
      };
      this.logger.log(`EXAM_SUMMARY ${JSON.stringify(summary)}`);
    } catch (e) {
      this.logger.warn(`Could not summarise import ${record.id}: ${(e as Error).message}`);
    }
  }

  private async chunksOf(importId: string): Promise<SourceChunk[]> {
    const rows = await this.prisma.examSourceChunk.findMany({
      where: { importId },
      orderBy: { index: 'asc' },
    });
    return rows.map((r) => ({
      index: r.index,
      text: r.text,
      sourceFile: r.sourceFile,
      page: r.page,
      tokensApprox: r.tokensApprox,
    }));
  }

  private async fail(importId: string, reason: string): Promise<void> {
    await this.prisma.paperImport.update({
      where: { id: importId },
      data: { status: 'FAILED', stage: 'READY', error: reason },
    });
  }
}

/** The draft carries no grading metadata — `chunkIndex` is ours, not the
 *  teacher's, and it stays on the row rather than in the exam. */
function stripGrading(q: GradedQuestion): DraftQuestion {
  const { chunkIndex, ...rest } = q;
  return { ...rest, sourceChunk: chunkIndex ?? null } as DraftQuestion;
}

function selectChunksForQuestionOf(chunks: SourceChunk[], question: DraftQuestion): SourceChunk[] {
  return selectChunksForQuestion(chunks, {
    text: question.text,
    chunkIndex: question.sourceChunk ?? null,
  });
}
