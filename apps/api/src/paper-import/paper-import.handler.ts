import { Injectable, Logger } from '@nestjs/common';
import { AiJob, AiJobType, PaperImportPage, Prisma } from '@prisma/client';
import { AiJobError } from '../academy-site/ai/ai-job.error';
import { AiJobHandler, AiJobResult } from '../academy-site/jobs/ai-job.handler';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProvider } from '../storage/storage.provider';
import { aggregatePages, PageExtraction, PageInput } from './extraction.schema';
import { ContentGenerationService } from './content-generation.service';
import { ExtractionTier, PaperExtractionService } from './paper-extraction.service';

/**
 * Which half of the content path a job is for.
 *
 * The teacher speaks between them — the material is read as soon as it is
 * uploaded, and the questions are not written until they have said what exam
 * they want — so they cannot be one job.
 */
export type ContentPhase = 'READ' | 'GENERATE';

/**
 * Reads a stack of already-stored pages and leaves a draft behind.
 *
 * Runs on the queue that already exists — same claim, same lease, same retry
 * policy, same budget ceiling as site generation. Nothing about it is
 * synchronous: a twenty-page import is minutes of provider time, and a
 * teacher's browser is not a thing to hold open for minutes.
 *
 * **Every page is independent.** A page that fails is marked failed and the
 * next one is read; the import ends in REVIEW with a warning about it rather
 * than failing whole. That is also what makes a retry cheap — only the failed
 * pages are re-read, because the successful ones already hold their answer.
 */
@Injectable()
export class PaperImportHandler implements AiJobHandler {
  readonly type: AiJobType = 'PAPER_IMPORT';
  private readonly logger = new Logger(PaperImportHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageProvider,
    private readonly extraction: PaperExtractionService,
    private readonly content: ContentGenerationService,
  ) {}

  async handle(job: AiJob): Promise<AiJobResult | void> {
    const input = job.input as {
      importId?: string;
      tier?: ExtractionTier;
      phase?: ContentPhase;
    };
    const importId = input?.importId;
    if (!importId) throw new AiJobError('No importId on job', 'TERMINAL');
    // Set only by a teacher pressing "read it again more carefully".
    const tier: ExtractionTier = input.tier === 'STRONG' ? 'STRONG' : 'AUTO';

    const record = await this.prisma.paperImport.findFirst({
      where: { id: importId, deletedAt: null },
      include: { pages: { orderBy: { pageNumber: 'asc' } } },
    });
    if (!record) throw new AiJobError('That import no longer exists', 'TERMINAL');
    // A teacher who already confirmed does not get their draft overwritten by
    // a job that was still in the queue.
    if (record.status === 'COMPLETED' || record.status === 'CANCELED') return;

    // The content path: reading lecture material, or writing questions from
    // what was read. Both live in their own service; this handler is the one
    // registration on the one queue, and dispatches.
    if (record.kind === 'CONTENT') {
      const started = Date.now();
      const result =
        input.phase === 'GENERATE'
          ? await this.content.generate(record)
          : await this.content.read(record);
      await this.prisma.paperImport.update({
        where: { id: importId },
        data: { durationMs: Date.now() - started, highAccuracy: false },
      });
      return { costCents: Math.ceil(result.millicents / 1000) };
    }

    const started = Date.now();
    // Only what has not been read yet. On a retry that is the failed pages
    // alone; on a first run it is all of them.
    const todo = record.pages.filter((p) => p.status === 'PENDING' || p.status === 'FAILED');
    const alreadyDone = record.pages.length - todo.length;

    await this.prisma.paperImport.update({
      where: { id: importId },
      data: {
        status: 'PROCESSING',
        stage: 'READING',
        error: null,
        progressDone: alreadyDone,
        progressTotal: record.pages.length,
        highAccuracy: tier === 'STRONG',
      },
    });

    let index = 0;
    for (const page of todo) {
      index += 1;
      await this.prisma.aiJob
        .update({
          where: { id: job.id },
          data: { stage: `reading ${index}/${todo.length}` },
        })
        .catch(() => undefined);
      await this.readPage(importId, page, tier);
      // Real progress: written after the page actually came back, so a
      // teacher reading "8 of 12" is reading the worker's own count.
      await this.prisma.paperImport.update({
        where: { id: importId },
        data: { progressDone: alreadyDone + index },
      });
    }

    await this.prisma.aiJob
      .update({ where: { id: job.id }, data: { stage: 'validating' } })
      .catch(() => undefined);
    await this.prisma.paperImport.update({
      where: { id: importId },
      data: { stage: 'VALIDATING' },
    });

    const summary = await this.assemble(importId, Date.now() - started);
    this.logger.log(
      `Import ${importId}: ${summary.pages} page(s), ${summary.escalated} escalated, ` +
        `${summary.inputTokens}+${summary.outputTokens} tokens, ${(summary.millicents / 1000).toFixed(2)}¢`,
    );
    return { costCents: Math.ceil(summary.millicents / 1000) };
  }

  /** One page, start to finish, with its own cost recorded on its own row. */
  private async readPage(
    importId: string,
    page: PaperImportPage,
    tier: ExtractionTier,
  ): Promise<void> {
    let image: Buffer | undefined;
    let text: string | null = null;
    try {
      if (page.textKey) {
        text = (await this.storage.getBuffer(page.textKey)).toString('utf8');
      } else if (page.renderKey) {
        image = await this.storage.getBuffer(page.renderKey);
      }
    } catch (e) {
      // The bytes are gone from storage. Nothing to re-read, and no amount of
      // retrying brings them back.
      await this.prisma.paperImportPage.update({
        where: { id: page.id },
        data: {
          status: 'FAILED',
          attempts: { increment: 1 },
          error: `Stored page could not be read: ${(e as Error).message}`.slice(0, 500),
        },
      });
      return;
    }
    if (!image && !text) {
      await this.prisma.paperImportPage.update({
        where: { id: page.id },
        data: { status: 'FAILED', attempts: { increment: 1 }, error: 'Page has no stored content' },
      });
      return;
    }

    const result = await this.extraction.extractPage({
      pageNumber: page.pageNumber,
      image,
      text,
      tier,
    });

    const failed = !result.extraction;
    await this.prisma.paperImportPage.update({
      where: { id: page.id },
      data: {
        status: failed ? 'FAILED' : result.escalated ? 'ESCALATED' : 'EXTRACTED',
        model: result.model,
        escalationReason: result.escalationReason,
        attempts: { increment: 1 },
        error: result.error,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costMillicents: result.millicents,
        extracted: (result.extraction ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Stitch every page's answer into the draft the teacher reviews.
   *
   * Re-read from the database rather than accumulated in memory, so a retry
   * that only touched page 7 still produces a draft containing pages 1–20.
   */
  private async assemble(importId: string, durationMs: number) {
    const pages = await this.prisma.paperImportPage.findMany({
      where: { importId },
      orderBy: { pageNumber: 'asc' },
    });

    const inputs: PageInput[] = pages.map((p) => ({
      pageNumber: p.pageNumber,
      extraction: (p.extracted as PageExtraction | null) ?? null,
      failed: p.status === 'FAILED',
    }));
    const { draft, warnings } = aggregatePages(inputs);

    const inputTokens = pages.reduce((n, p) => n + p.inputTokens, 0);
    const outputTokens = pages.reduce((n, p) => n + p.outputTokens, 0);
    const millicents = pages.reduce((n, p) => n + p.costMillicents, 0);
    const escalated = pages.filter((p) => p.status === 'ESCALATED').length;
    const allFailed = pages.length > 0 && pages.every((p) => p.status === 'FAILED');

    await this.prisma.paperImport.update({
      where: { id: importId },
      data: {
        // A stack where nothing at all could be read is a failure the teacher
        // has to be told about; anything partial is a review with warnings on
        // it, because a draft missing one page is still worth editing.
        status: allFailed ? 'FAILED' : 'REVIEW',
        stage: 'READY',
        highAccuracy: false,
        error: allFailed ? 'None of the uploaded pages could be read' : null,
        title: draft.title,
        draft: draft as unknown as Prisma.InputJsonValue,
        warnings: warnings as unknown as Prisma.InputJsonValue,
        inputTokens,
        outputTokens,
        costCents: Math.ceil(millicents / 1000),
        escalatedPages: escalated,
        durationMs,
      },
    });

    return { pages: pages.length, escalated, inputTokens, outputTokens, millicents };
  }
}
