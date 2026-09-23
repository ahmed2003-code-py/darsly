import { Injectable, Logger } from '@nestjs/common';
import { PaperImport, PaperImportPage, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProvider } from '../storage/storage.provider';
import { DraftQuestion, DraftWarning, ExamDraft } from './extraction.schema';
import {
  ExamSpec,
  normalizeSpec,
  planQuestions,
  PlannedQuestion,
  scaleSpec,
  specFromQuestions,
} from './exam-spec';
import { gradeQuestions, findDuplicates, GradedQuestion } from './question-quality';
import { QuestionGeneratorService, GeneratedQuestion } from './question-generator.service';
import { SourceReaderService } from './source-reader.service';
import { PaperImportConfig } from './paper-import.config';
import {
  chunkSource,
  normalizePageText,
  selectChunksForBatch,
  selectChunksForQuestion,
  supportableQuestions,
  SourceChunk,
  SourcePage,
  stripRunningLines,
} from './source-text';

let counter = 0;
const nextId = (): string =>
  `g${(++counter).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

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

    for (const page of pages) {
      const result = await this.readOne(record.id, page);
      millicents += result.millicents;
      done += 1;
      await this.prisma.paperImport.update({
        where: { id: record.id },
        data: { progressDone: done },
      });
    }

    const chunks = await this.buildChunks(record.id);
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
        inputTokens: { increment: 0 },
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

    const result = await this.reader.readPage({ pageNumber: page.pageNumber, image });
    const usable = !result.error && !result.blank && result.text.trim().length > 0;

    if (usable) {
      const textKey = `paper-imports/${importId}/text/${page.pageNumber}.txt`;
      await this.storage.put(textKey, Buffer.from(result.text, 'utf8'), {
        contentType: 'text/plain; charset=utf-8',
      });
      await this.prisma.paperImportPage.update({
        where: { id: page.id },
        data: {
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
   * Write the exam the teacher asked for, in batches, from the chunks.
   *
   * A batch that fails the deterministic checks is written again — once on the
   * same model, then once on the flagship — and only that batch. A shortfall
   * that survives both is reported rather than padded: a teacher told "this
   * material supports 13 good questions" can upload more or ask for 13, and a
   * teacher handed 20 questions of which 7 are invented cannot do anything at
   * all, because they do not know which 7.
   */
  async generate(record: PaperImport): Promise<{ millicents: number }> {
    const asked = normalizeSpec(record.spec as never);
    const chunks = await this.chunksOf(record.id);

    if (!chunks.length) {
      await this.fail(record.id, 'NO_SOURCE');
      return { millicents: 0 };
    }

    // Work out what the material can carry BEFORE spending anything on it.
    // Asking one page for twenty questions used to mean three batches over the
    // same paragraph, each repeating the last, every repeat thrown away as a
    // duplicate, the shortfall read as a model failure and all three batches
    // escalated to the flagship. Six calls and ten minutes for thirteen
    // questions one call could have written.
    const ceiling = supportableQuestions(chunks);
    const spec = scaleSpec(asked, ceiling);
    const plan = planQuestions(spec);

    await this.prisma.paperImport.update({
      where: { id: record.id },
      data: {
        stage: 'GENERATING',
        status: 'PROCESSING',
        progressDone: 0,
        progressTotal: plan.length,
        error: null,
        generationBatches: 0,
        escalatedChunks: 0,
      },
    });

    const batchCount = this.generator.batchCount(plan.length);
    const accepted: GradedQuestion[] = [];
    const warnings: DraftWarning[] = [];
    let millicents = 0;
    let batches = 0;
    let escalatedChunks = 0;
    let supportable: number | null = null;

    for (let b = 0; b < batchCount; b++) {
      const batchPlan = this.generator.batchOf(plan, b);
      if (!batchPlan.length) continue;
      const material = selectChunksForBatch(
        chunks,
        b,
        batchCount,
        this.config.generationSourceTokens,
      );

      let kept: GradedQuestion[] = [];
      let exhausted = false;
      for (let attempt = 0; attempt < this.config.generationMaxAttempts; attempt++) {
        const stronger = attempt > 0;
        const result = await this.generator.generateBatch({
          plan: batchPlan,
          chunks: material,
          language: spec.language,
          avoid: accepted.map((q) => q.text),
          stronger,
        });
        batches += 1;
        millicents += result.millicents;
        if (stronger) escalatedChunks += 1;

        if (result.insufficient && result.supportable >= 0) {
          supportable = Math.max(
            supportable ?? 0,
            accepted.length + Math.min(result.supportable, batchPlan.length),
          );
        }

        kept = this.acceptable(result.questions, batchPlan, material, accepted);

        // Every question asked for came back usable. Done.
        if (kept.length >= batchPlan.length) break;

        // Short, but nothing that came back was *wrong*: the model wrote what
        // the paragraph supports. A bigger model reading the same paragraph
        // does not lengthen it, and this is the case that used to cost three
        // flagship calls per import. Stop asking.
        const rejected = result.questions.length - kept.length;
        if (result.insufficient || rejected === 0) {
          exhausted = true;
          break;
        }
        // Something came back broken. That IS worth a better reader.
      }

      accepted.push(...kept);
      // The material has given what it has. The remaining batches would be
      // handed the same chunks and would repeat these questions.
      if (exhausted && kept.length < batchPlan.length) {
        await this.prisma.paperImport.update({
          where: { id: record.id },
          data: { progressDone: accepted.length, generationBatches: batches },
        });
        break;
      }
      await this.prisma.paperImport.update({
        where: { id: record.id },
        data: { progressDone: accepted.length, generationBatches: batches },
      });
    }

    // ── filling the count ─────────────────────────────────────────────────
    //
    // The material has given what it has. What the teacher asked for is still
    // what the teacher asked for, so the remaining slots are written by
    // varying the questions that did come out of it — different numbers, the
    // other end of the same relationship, a different facet of the same idea.
    // Nothing new is claimed: a variant is grounded in a chunk like everything
    // else and faces the same duplicate check, which is what stops this from
    // becoming the same question twenty times.
    const variants = await this.fillWithVariants({
      importId: record.id,
      asked,
      accepted,
      chunks,
      language: spec.language,
    });
    millicents += variants.millicents;
    batches += variants.calls;

    // ── the deterministic gate ────────────────────────────────────────────
    await this.prisma.paperImport.update({
      where: { id: record.id },
      data: { stage: 'VALIDATING' },
    });

    const numbered = accepted.map((q, i) => ({ ...q, number: i + 1 }));
    const findings = gradeQuestions(numbered, plan, { requireGrounding: true });

    // What the teacher asked for, reconciled with what the material gave.
    //
    // The spec is rewritten to match the exam that actually exists. It used to
    // keep saying "20 questions, 10 multiple choice" over a draft of 13, so
    // "change the settings" opened a form the teacher had to correct by hand
    // before it would save — a number they never chose, asking them to fix it.
    // Now the stored spec is the exam, and the warning explains the difference.
    const finalSpec: ExamSpec =
      numbered.length < asked.questionCount ? specFromQuestions(asked, numbered) : asked;

    // The exam is the length that was ordered, and part of it came from a
    // second look at the same material. That is a thing the teacher has to be
    // told — not because it went wrong, but because "which of these are
    // variants" is a question they are entitled to the answer to before they
    // set the paper.
    if (variants.made > 0) {
      warnings.push({
        code: 'COMPLETED_WITH_VARIANTS',
        params: {
          variants: variants.made,
          fromMaterial: numbered.length - variants.made,
          wanted: asked.questionCount,
        },
        detail:
          `The material supported ${numbered.length - variants.made} distinct questions; ` +
          `${variants.made} more were written as variants of them to reach ${asked.questionCount}.`,
      });
    }

    if (numbered.length < asked.questionCount) {
      warnings.push({
        code: 'NOT_ENOUGH_CONTENT',
        params: {
          got: numbered.length,
          wanted: asked.questionCount,
          supportable: supportable ?? numbered.length,
          mcq: finalSpec.types.MCQ,
          trueFalse: finalSpec.types.TRUE_FALSE,
          written: finalSpec.types.SHORT_ANSWER,
        },
        detail: `The uploaded material supports ${numbered.length} of the ${asked.questionCount} questions requested.`,
      });
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

    await this.prisma.paperImport.update({
      where: { id: record.id },
      data: {
        status: numbered.length ? 'REVIEW' : 'FAILED',
        stage: 'READY',
        error: numbered.length ? null : 'No questions could be written from this material',
        title: draft.title,
        draft: draft as unknown as Prisma.InputJsonValue,
        // The spec now describes the exam that exists, so confirming works and
        // "change the settings" opens the real numbers.
        spec: finalSpec as unknown as Prisma.InputJsonValue,
        warnings: warnings as unknown as Prisma.InputJsonValue,
        generationBatches: batches,
        escalatedChunks,
        costCents: { increment: Math.ceil(millicents / 1000) },
        progressDone: numbered.length,
        progressTotal: Math.max(numbered.length, plan.length),
      },
    });

    this.logger.log(
      `Import ${record.id}: ${numbered.length}/${plan.length} question(s) in ${batches} batch(es), ` +
        `${escalatedChunks} escalated, ${(millicents / 1000).toFixed(2)}¢`,
    );
    return { millicents };
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

    const [graded] = this.acceptable([written], [planned], material, []);
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
   * Keep the questions from a batch that are actually usable.
   *
   * Per question, not per batch: seven good questions and one broken one is
   * seven questions kept and one asked for again, rather than eight thrown
   * away and eight paid for twice.
   */
  /**
   * Reach the number that was asked for, without inventing content.
   *
   * Runs only when the ordinary generation came up short, and only for as many
   * rounds as the config allows. Each round asks for exactly what is still
   * missing and hands the model the questions the material did support, so a
   * variant has something concrete to vary.
   *
   * Everything a variant produces goes through `acceptable` unchanged — the
   * same grounding check, the same duplicate check at the same threshold. That
   * is deliberate and is the only reason this is safe: a "variant" that is its
   * source reworded scores above the duplicate threshold and is dropped, so
   * the failure mode this invites cannot reach a teacher. It costs a call to
   * find that out, which is why the rounds are capped at two.
   *
   * `accepted` is mutated, because it is the exam being assembled and the
   * caller carries on using it.
   */
  private async fillWithVariants(opts: {
    importId: string;
    asked: ExamSpec;
    accepted: GradedQuestion[];
    chunks: SourceChunk[];
    language: ExamSpec['language'];
  }): Promise<{ made: number; millicents: number; calls: number }> {
    const { asked, accepted, chunks } = opts;
    const rounds = this.config.generationVariantRounds;
    let millicents = 0;
    let calls = 0;
    let made = 0;

    if (!rounds || !accepted.length || accepted.length >= asked.questionCount) {
      return { made, millicents, calls };
    }

    // The slots still to fill, taken from the plan for what was actually
    // asked for rather than from the scaled-down one — the type mix a teacher
    // chose is part of the request, not a casualty of the material being thin.
    const fullPlan = planQuestions(asked);

    for (let round = 0; round < rounds && accepted.length < asked.questionCount; round++) {
      const slots = fullPlan.slice(accepted.length, asked.questionCount);
      if (!slots.length) break;

      const material = selectChunksForBatch(chunks, 0, 1, this.config.generationSourceTokens);
      const result = await this.generator.generateVariants({
        plan: slots,
        chunks: material,
        language: opts.language,
        // The questions the material did support, which is what there is to
        // vary. Capped: a long list crowds out the material itself.
        source: accepted.slice(0, 20).map((q) => ({ text: q.text, modelAnswer: q.modelAnswer })),
        avoid: accepted.map((q) => q.text),
        // A second round on the same material got the same answer often
        // enough to be worth paying for a better reader once.
        stronger: round > 0,
      });
      calls += 1;
      millicents += result.millicents;

      const kept = this.acceptable(result.questions, slots, material, accepted).map((q) => ({
        ...q,
        variant: true,
      }));
      if (!kept.length) break; // nothing usable came back; another round will not help
      accepted.push(...kept);
      made += kept.length;

      await this.prisma.paperImport.update({
        where: { id: opts.importId },
        data: { progressDone: accepted.length },
      });
    }

    this.logger.log(
      `Import ${opts.importId}: ${made} variant question(s) in ${calls} call(s) ` +
        `to reach ${accepted.length}/${asked.questionCount}`,
    );
    return { made, millicents, calls };
  }

  private acceptable(
    written: GeneratedQuestion[],
    plan: PlannedQuestion[],
    material: SourceChunk[],
    already: GradedQuestion[],
  ): GradedQuestion[] {
    const valid = new Set(material.map((c) => c.index));
    const out: GradedQuestion[] = [];

    written.forEach((w, i) => {
      const wanted = plan[i] ?? plan[plan.length - 1];
      const chunk = material.find((c) => c.index === w.chunkIndex);
      const question: GradedQuestion = {
        id: nextId(),
        number: 0,
        type: (w.type ?? wanted.type) as DraftQuestion['type'],
        text: (w.text ?? '').trim(),
        options: (w.options ?? [])
          .filter((o) => (o?.text ?? '').trim())
          .map((o) => ({
            id: nextId(),
            label: (o.label ?? '').trim(),
            text: o.text.trim(),
            correct: !!o.correct,
          })),
        modelAnswer: (w.modelAnswer ?? '').trim(),
        marks: Number.isFinite(w.marks) ? w.marks : wanted.marks,
        // The page of the uploaded material this came off, so the review
        // screen can say "biology.pdf — page 8" and mean it.
        sourcePages: chunk?.page ? [chunk.page] : [],
        sourceFile: chunk?.sourceFile ?? '',
        unsupportedKind: '',
        needsReview: false,
        chunkIndex: valid.has(w.chunkIndex) ? w.chunkIndex : null,
      };
      // One question at a time through the same gate the whole exam faces.
      const findings = gradeQuestions([{ ...question, number: 1 }], undefined, {
        requireGrounding: true,
      });
      if (findings.length) return;
      // And not a repeat of anything already accepted.
      if (
        findDuplicates(
          [...already, ...out, question].map((q) => ({ id: q.id, text: q.text })),
        ).some((d) => d.id === question.id)
      ) {
        return;
      }
      out.push(question);
    });

    return out;
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
