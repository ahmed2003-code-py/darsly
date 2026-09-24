import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ExamCreationKind, PaperImport, PaperSourceKind, Prisma } from '@prisma/client';
import { AiJobService } from '../academy-site/jobs/ai-job.service';
import { AuditService } from '../audit/audit.service';
import { assertMagicMatchesMime } from '../common/image.util';
import { CourseScope } from '../courses/courses.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProvider } from '../storage/storage.provider';
import {
  ConfirmImportDto,
  RegenerateQuestionDto,
  RetryImportDto,
  SaveDraftDto,
  SetSpecDto,
} from './dto/paper-import.dto';
import { ContentGenerationService } from './content-generation.service';
import { normalizeSpec, specProblems } from './exam-spec';
import { ExamBuilderService } from './exam-builder.service';
import { DraftQuestion, DraftWarning, ExamDraft } from './extraction.schema';
import { PAPER_IMAGE_MIME, PAPER_PDF_MIME, PagePreparerService } from './page-preparer.service';
import { PaperImportConfig } from './paper-import.config';

/**
 * How many files one session accepts in a single upload.
 *
 * Lives here rather than only in the controller because the screen has to be
 * able to say it before a teacher picks forty files, and the controller's
 * multer ceiling is not something a browser can read.
 */
export const MAX_FILES_PER_SESSION = 30;

/** An uploaded file as the controller hands it over, already size-capped and
 *  type-filtered by multer. Everything past that is checked here. */
export interface UploadedPaper {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

/** Who is asking. Resolved from the academy context, never from the body. */
export interface ImportScope extends CourseScope {
  userId: string;
}

/**
 * The import, from the moment a file arrives to the moment it becomes an exam.
 *
 * The stages are deliberately separate rows and separate calls rather than one
 * service method that does everything: upload and storage happen in the
 * request, reading happens on the queue, review happens in the teacher's own
 * time, and confirmation is a fourth, explicit act. A teacher can close the
 * tab at any point between them and come back to exactly where they were.
 *
 * Authorization is the ordinary academy one — the controller resolves the
 * academy and requires `course.write`, and every read below is filtered by
 * `academyId` *and*, for a teacher who is not an owner, by `tenantId`. There
 * is no path to another teacher's pages.
 */
@Injectable()
export class PaperImportService {
  private readonly logger = new Logger(PaperImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageProvider,
    private readonly preparer: PagePreparerService,
    private readonly config: PaperImportConfig,
    private readonly jobs: AiJobService,
    private readonly builder: ExamBuilderService,
    private readonly audit: AuditService,
    private readonly content: ContentGenerationService,
  ) {}

  /**
   * What a teacher is allowed to upload, so the screen can say so *before*
   * they choose forty files.
   *
   * The numbers live in the config and nowhere else. They used to be spelled
   * out only inside the refusal, which meant the first time anybody learned
   * the ceiling was after hitting it.
   */
  limits() {
    return {
      paper: { maxPages: this.config.maxPages },
      content: { maxPages: this.config.maxContentPages },
      maxImageMb: Math.round(this.config.maxImageBytes / 1024 / 1024),
      maxPdfMb: Math.round(this.config.maxPdfBytes / 1024 / 1024),
      maxFiles: MAX_FILES_PER_SESSION,
    };
  }

  // ── stage 1: upload, validation, storage ─────────────────────────────────

  /**
   * Take the files, keep the originals, prepare the pages, queue the reading.
   *
   * The originals are stored before anything is asked of them and are never
   * overwritten or deleted while the import lives. They are the evidence
   * behind every extracted question — the thing a teacher checks a suspicious
   * question against, and the thing a re-run reads from. Losing them to a
   * failed extraction would make every failure permanent.
   */
  async create(
    scope: ImportScope,
    files: UploadedPaper[],
    opts: { kind?: ExamCreationKind } = {},
  ): Promise<PaperImport> {
    if (!files?.length) {
      throw new BadRequestException({ message: 'Upload at least one page', code: 'NO_FILES' });
    }
    const kind: ExamCreationKind = opts.kind ?? 'PAPER';
    for (const file of files) this.assertAcceptable(file);
    // Before anything is stored. This used to be found out at the very end,
    // after the pages were uploaded and a session row created — so the refusal
    // left that row behind, stuck in UPLOADING, and said only "conflict".
    await this.assertNotBusy(scope);

    const hasPdf = files.some((f) => f.mimetype === PAPER_PDF_MIME);
    const hasImage = files.some((f) => f.mimetype !== PAPER_PDF_MIME);
    const sourceKind: PaperSourceKind = hasPdf && hasImage ? 'MIXED' : hasPdf ? 'PDF' : 'IMAGES';

    const record = await this.prisma.paperImport.create({
      data: {
        academyId: scope.academyId,
        tenantId: scope.authorTenantId!,
        createdBy: scope.userId,
        sourceKind,
        kind,
        status: 'UPLOADING',
        stage: 'UPLOADED',
      },
    });

    let pageCount = 0;
    try {
      // One session, whatever the files were. Three photographs and a PDF are
      // one exam, and the page numbers run across all of them in the order the
      // teacher sent them — which is the order they meant.
      for (const file of files) {
        pageCount =
          file.mimetype === PAPER_PDF_MIME
            ? await this.storePdf(record.id, file, pageCount, kind)
            : await this.storeImage(record.id, file, pageCount, kind);
      }
      if (!pageCount) {
        throw new BadRequestException({
          message: 'Nothing readable was found in those files',
          code: 'PAPER_NO_PAGES',
        });
      }
    } catch (e) {
      // Nothing half-stored is left listed: the row is marked failed with the
      // reason, and the objects already written are cleaned up.
      await this.prisma.paperImport.update({
        where: { id: record.id },
        data: { status: 'FAILED', error: (e as Error).message.slice(0, 500) },
      });
      await this.storage.deletePrefix(this.prefix(record.id)).catch(() => undefined);
      throw e;
    }

    let job;
    try {
      job = await this.enqueue(
        scope,
        // The content path reads the material now and writes the questions
        // later, once the teacher has said what exam they want out of it.
        { importId: record.id, ...(kind === 'CONTENT' ? { phase: 'READ' } : {}) },
      );
    } catch (e) {
      // Another session started between the check above and here. This one
      // never ran, so it is not unfinished work: it is closed and its pages
      // removed, rather than left on the drafts list as something to resume.
      await this.prisma.paperImport.update({
        where: { id: record.id },
        data: { status: 'CANCELED', error: (e as Error).message.slice(0, 500) },
      });
      await this.storage.deletePrefix(this.prefix(record.id)).catch(() => undefined);
      throw e;
    }

    await this.audit.log({
      actorUserId: scope.userId,
      academyId: scope.academyId,
      action: 'paper-import.create',
      entity: 'PaperImport',
      entityId: record.id,
      meta: { kind, sourceKind, files: files.length, pages: pageCount },
    });

    return this.prisma.paperImport.update({
      where: { id: record.id },
      data: { status: 'PROCESSING', stage: 'READING', jobId: job.id, progressTotal: pageCount },
    });
  }

  /**
   * Queue a session's work. Only another session blocks a session — a teacher
   * scanning an exam and an academy regenerating its site have nothing to do
   * with each other — and when one does, the refusal says which.
   */
  private async enqueue(scope: ImportScope, input: Prisma.InputJsonValue) {
    await this.assertNotBusy(scope);
    try {
      return await this.jobs.enqueue(scope.academyId, 'PAPER_IMPORT', input, {
        conflictsWith: ['PAPER_IMPORT'],
      });
    } catch (e) {
      // Lost a race with a session that started a moment ago: same answer.
      if (e instanceof ConflictException) await this.assertNotBusy(scope);
      throw e;
    }
  }

  /**
   * One session is read at a time per academy. When another is running, say
   * so — and, when it is this teacher's own, where it is, so "conflict with
   * existing data" becomes "your other exam is still being read: open it".
   * Another teacher's session is named only as existing; its id is theirs.
   */
  private async assertNotBusy(scope: ImportScope): Promise<void> {
    const job = await this.prisma.aiJob.findFirst({
      where: {
        academyId: scope.academyId,
        type: 'PAPER_IMPORT',
        status: { in: ['QUEUED', 'RUNNING'] },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, input: true },
    });
    if (!job) return;
    const importId = (job.input as { importId?: unknown } | null)?.importId;
    const running =
      typeof importId === 'string'
        ? await this.prisma.paperImport.findFirst({
            where: { id: importId, academyId: scope.academyId },
            select: { id: true, courseId: true, createdBy: true, status: true, deletedAt: true },
          })
        : null;
    // A job still marked live for a session that was stopped, deleted or
    // finished is not work in progress — it is a leftover (a job stopped
    // before `stop` existed, or one whose worker died). It must not block the
    // teacher, and must not be offered to them as "the exam that is running".
    if (
      running &&
      (running.deletedAt || ['CANCELED', 'COMPLETED', 'FAILED'].includes(running.status))
    ) {
      await this.jobs.stop(scope.academyId, job.id).catch(() => undefined);
      return;
    }
    if (running && running.createdBy === scope.userId) {
      throw new ConflictException({
        message: 'Your other exam is still being prepared',
        code: 'IMPORT_IN_PROGRESS',
        params: { importId: running.id, courseId: running.courseId },
      });
    }
    throw new ConflictException({
      message: 'Another exam is being prepared in this academy right now',
      code: 'IMPORT_IN_PROGRESS_OTHER',
    });
  }

  /** Everything an upload is trusted about is checked here, because
   *  everything an upload says about itself is a string it chose. */
  private assertAcceptable(file: UploadedPaper): void {
    if (file.mimetype === PAPER_PDF_MIME) {
      if (file.size > this.config.maxPdfBytes) {
        throw new BadRequestException({
          message: `"${file.originalname}" is larger than ${Math.round(this.config.maxPdfBytes / 1024 / 1024)}MB`,
          code: 'PAPER_FILE_TOO_LARGE',
          // The numbers travel so the screen can write the sentence in the
          // reader's language. A refusal that says only "too large" makes the
          // teacher guess at how much smaller.
          params: {
            name: file.originalname,
            mb: Math.round(file.size / 1024 / 1024),
            limit: Math.round(this.config.maxPdfBytes / 1024 / 1024),
          },
        });
      }
      // The declared type is a string the client chose; this is the bytes.
      if (file.buffer.subarray(0, 4).toString('latin1') !== '%PDF') {
        throw new BadRequestException({
          message: 'That file is not the PDF it claims to be',
          code: 'PAPER_CONTENT_MISMATCH',
          params: { name: file.originalname },
        });
      }
      return;
    }
    if (!PAPER_IMAGE_MIME.test(file.mimetype)) {
      throw new BadRequestException({
        message: 'Pages must be PNG, JPEG or WebP images, or PDFs',
        code: 'PAPER_UNSUPPORTED_TYPE',
        params: { name: file.originalname },
      });
    }
    if (file.size > this.config.maxImageBytes) {
      throw new BadRequestException({
        message: `"${file.originalname}" is larger than ${Math.round(this.config.maxImageBytes / 1024 / 1024)}MB`,
        code: 'PAPER_FILE_TOO_LARGE',
        params: {
          name: file.originalname,
          mb: Math.round(file.size / 1024 / 1024),
          limit: Math.round(this.config.maxImageBytes / 1024 / 1024),
        },
      });
    }
    assertMagicMatchesMime(file.mimetype, file.buffer);
  }

  /** How many pages a session of this kind may hold. A lecture is allowed to
   *  be longer than an exam, because it is. */
  private pageCap(kind: ExamCreationKind): number {
    return kind === 'CONTENT' ? this.config.maxContentPages : this.config.maxPages;
  }

  /** A PDF: kept whole as the original, then split into one page each.
   *  Returns the running page number after this file. */
  private async storePdf(
    importId: string,
    file: UploadedPaper,
    from: number,
    kind: ExamCreationKind,
  ): Promise<number> {
    const sourceKey = `${this.prefix(importId)}/source/${from + 1}.pdf`;
    await this.storage.put(sourceKey, file.buffer, { contentType: PAPER_PDF_MIME });

    let page = from;
    await this.preparer.withPdf(file.buffer, async (handle) => {
      const count = await handle.pageCount();
      if (from + count > this.pageCap(kind)) {
        throw new BadRequestException({
          message: `That is ${from + count} pages; a session can hold ${this.pageCap(kind)}`,
          code: 'PAPER_TOO_MANY_PAGES',
          params: { name: file.originalname, got: from + count, limit: this.pageCap(kind) },
        });
      }
      for (let n = 1; n <= count; n++) {
        page += 1;
        // Free first: a PDF that already carries its text costs no image
        // tokens at all, and most PDFs a teacher exports from Word do.
        const text = await handle.text(n);
        if (text) {
          const textKey = `${this.prefix(importId)}/text/${page}.txt`;
          await this.storage.put(textKey, Buffer.from(text, 'utf8'), {
            contentType: 'text/plain; charset=utf-8',
          });
          await this.prisma.paperImportPage.create({
            data: {
              importId,
              pageNumber: page,
              originalKey: sourceKey,
              originalName: file.originalname,
              originalMime: PAPER_PDF_MIME,
              bytes: file.size,
              textKey,
            },
          });
          continue;
        }
        const rendered = await handle.render(n);
        const renderKey = `${this.prefix(importId)}/page/${page}.jpg`;
        await this.storage.put(renderKey, rendered.data, { contentType: rendered.mimeType });
        await this.prisma.paperImportPage.create({
          data: {
            importId,
            pageNumber: page,
            originalKey: sourceKey,
            originalName: file.originalname,
            originalMime: PAPER_PDF_MIME,
            bytes: file.size,
            renderKey,
            width: rendered.width,
            height: rendered.height,
          },
        });
      }
    });
    return page;
  }

  /** One photograph: the original kept beside the normalised copy that is
   *  actually sent. Returns the running page number after this file. */
  private async storeImage(
    importId: string,
    file: UploadedPaper,
    from: number,
    kind: ExamCreationKind,
  ): Promise<number> {
    const page = from + 1;
    if (page > this.pageCap(kind)) {
      throw new BadRequestException({
        message: `A session can hold ${this.pageCap(kind)} pages`,
        code: 'PAPER_TOO_MANY_PAGES',
        params: { name: file.originalname, got: page, limit: this.pageCap(kind) },
      });
    }
    const ext =
      file.mimetype === 'image/png' ? 'png' : file.mimetype === 'image/webp' ? 'webp' : 'jpg';
    const originalKey = `${this.prefix(importId)}/original/${page}.${ext}`;
    await this.storage.put(originalKey, file.buffer, { contentType: file.mimetype });

    const prepared = await this.preparer.normalizeImage(file.buffer);
    const renderKey = `${this.prefix(importId)}/page/${page}.jpg`;
    await this.storage.put(renderKey, prepared.data, { contentType: prepared.mimeType });

    await this.prisma.paperImportPage.create({
      data: {
        importId,
        pageNumber: page,
        originalKey,
        originalName: file.originalname,
        originalMime: file.mimetype,
        bytes: file.size,
        renderKey,
        width: prepared.width,
        height: prepared.height,
      },
    });
    return page;
  }

  private prefix(importId: string): string {
    return `paper-imports/${importId}`;
  }

  // ── stage 2: progress and review ─────────────────────────────────────────

  async list(scope: ImportScope) {
    return this.prisma.paperImport.findMany({
      where: this.where(scope),
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        kind: true,
        status: true,
        stage: true,
        title: true,
        sourceKind: true,
        costCents: true,
        escalatedPages: true,
        lessonId: true,
        courseId: true,
        createdAt: true,
        _count: { select: { pages: true } },
      },
    });
  }

  /**
   * One import, with everything the screen needs to say what is happening.
   *
   * Progress is counted from the page rows, never invented: "4 of 9" means
   * four pages have actually come back. A spinner that moves on a timer is a
   * lie about work that may not be happening.
   */
  async get(scope: ImportScope, id: string) {
    const record = await this.prisma.paperImport.findFirst({
      where: { ...this.where(scope), id },
      include: {
        pages: {
          orderBy: { pageNumber: 'asc' },
          select: {
            id: true,
            pageNumber: true,
            status: true,
            model: true,
            escalationReason: true,
            error: true,
            width: true,
            height: true,
            phase: true,
            phaseDone: true,
            phaseTotal: true,
          },
        },
      },
    });
    if (!record) throw new NotFoundException('Import not found');

    const { pages, draft, warnings, spec, ...rest } = record;
    return {
      ...rest,
      pages,
      draft: draft as unknown as ExamDraft,
      warnings: warnings as unknown as DraftWarning[],
      spec: normalizeSpec(spec as never),
      // The worker's own count of the work it has finished, not a count of
      // rows in a state — so generation, where the units are questions rather
      // than pages, reports through the same two numbers.
      progress: {
        done: rest.progressDone,
        total: rest.progressTotal || pages.length,
      },
    };
  }

  /** The original page, streamed to the teacher who owns it. Used by the
   *  review screen to show a question beside the paper it came off. */
  async openPage(scope: ImportScope, id: string, pageId: string) {
    const page = await this.prisma.paperImportPage.findFirst({
      where: { id: pageId, importId: id, import: this.where(scope) },
    });
    if (!page) throw new NotFoundException('Page not found');
    // The normalised copy where there is one: it is the upright, readable
    // version and a fraction of the size. The original is what it was made
    // from and is still on file.
    const key = page.renderKey ?? page.originalKey;
    if (!(await this.storage.exists(key))) throw new NotFoundException('Page file is missing');
    return { page, object: await this.storage.getStream(key) };
  }

  /** Save the teacher's edits. The draft is replaced whole — the review screen
   *  owns the list, the same way the quiz builder owns its question set. */
  async saveDraft(scope: ImportScope, id: string, dto: SaveDraftDto) {
    const record = await this.requireEditable(scope, id);
    return this.prisma.paperImport.update({
      where: { id: record.id },
      data: { title: dto.title, draft: dto as unknown as Prisma.InputJsonValue },
      select: { id: true, status: true, title: true, updatedAt: true },
    });
  }

  /**
   * Read the pages again.
   *
   * By default only the ones that failed: the successful pages already hold
   * their answers, so a retry after one bad photograph costs one page rather
   * than the stack, and a retry with nothing to retry is refused instead of
   * spending nothing and looking like it worked.
   *
   * `escalate` is the other request — the whole paper, on the flagship model,
   * because the cheap read was structurally valid and still wrong. It replaces
   * the draft, edits included, which is what a teacher asking for it wants:
   * the draft they are discarding is the one they could not use.
   */
  async retry(scope: ImportScope, id: string, dto: RetryImportDto = {}) {
    const record = await this.requireEditable(scope, id, ['REVIEW', 'FAILED', 'PROCESSING']);

    if (dto.escalate) {
      // The whole paper goes back on the queue, to be read by the flagship.
      // Every page, not just the failed ones: a teacher asks for this when the
      // result was structurally fine and simply wrong, and the pages that
      // "succeeded" are exactly the ones that were wrong.
      await this.prisma.paperImportPage.updateMany({
        where: { importId: record.id },
        data: { status: 'PENDING', error: null },
      });
    } else {
      const failed = await this.prisma.paperImportPage.count({
        where: { importId: record.id, status: { in: ['FAILED', 'PENDING'] } },
      });
      if (!failed) {
        throw new ConflictException({
          message: 'Every page was read successfully — there is nothing to retry',
          code: 'NOTHING_TO_RETRY',
        });
      }
    }

    const job = await this.enqueue(scope, {
      importId: record.id,
      ...(dto.escalate ? { tier: 'STRONG' } : {}),
    });
    await this.audit.log({
      actorUserId: scope.userId,
      academyId: scope.academyId,
      action: dto.escalate ? 'paper-import.reread-strong' : 'paper-import.retry',
      entity: 'PaperImport',
      entityId: record.id,
    });
    return this.prisma.paperImport.update({
      where: { id: record.id },
      data: { status: 'PROCESSING', jobId: job.id, error: null },
      select: { id: true, status: true, jobId: true },
    });
  }

  // ── stage 3: confirmation ────────────────────────────────────────────────

  /**
   * The teacher says yes. From here on it is an ordinary exam.
   *
   * Idempotent by refusal rather than by repetition: confirming twice would
   * make two exams out of one paper, so a second confirm is told where the
   * first one went instead.
   */
  async confirm(scope: ImportScope, id: string, dto: ConfirmImportDto) {
    const record = await this.prisma.paperImport.findFirst({
      where: { ...this.where(scope), id },
    });
    if (!record) throw new NotFoundException('Import not found');
    if (record.status === 'COMPLETED') {
      throw new ConflictException({
        message: 'This import has already been turned into an exam',
        code: 'ALREADY_CONFIRMED',
        lessonId: record.lessonId,
        courseId: record.courseId,
      });
    }
    const draft = record.draft as unknown as ExamDraft;
    if (!draft?.sections?.length) {
      throw new BadRequestException({
        message: 'There is nothing to confirm yet',
        code: 'NO_DRAFT',
      });
    }

    // Only an exam generated from material has settings the teacher chose;
    // a paper import was never asked, and the spec's defaults (a 60-minute
    // limit among them) are not choices to impose on it.
    const built = await this.builder.build(
      scope,
      draft,
      dto,
      record.kind === 'CONTENT' ? normalizeSpec(record.spec as never) : undefined,
    );

    await this.prisma.paperImport.update({
      where: { id: record.id },
      data: {
        status: 'COMPLETED',
        lessonId: built.lessonId,
        courseId: built.courseId,
      },
    });
    await this.audit.log({
      actorUserId: scope.userId,
      academyId: scope.academyId,
      action: 'paper-import.confirm',
      entity: 'PaperImport',
      entityId: record.id,
      meta: {
        lessonId: built.lessonId,
        courseId: built.courseId,
        questions: built.questionCount,
        dropped: built.droppedUnsupported,
        costCents: record.costCents,
      },
    });
    return built;
  }

  /** Remove an import the teacher has given up on. Soft, like everything else
   *  here: the pages stay in storage until the row is really purged, because
   *  "I deleted the wrong one" is a thing that happens. */
  async remove(scope: ImportScope, id: string) {
    const record = await this.prisma.paperImport.findFirst({ where: { ...this.where(scope), id } });
    if (!record) throw new NotFoundException('Import not found');
    await this.prisma.paperImport.update({
      where: { id: record.id },
      data: { deletedAt: new Date(), status: 'CANCELED' },
    });
    return { id: record.id, deleted: true };
  }

  // ── content path ─────────────────────────────────────────────────────────

  /**
   * The teacher says what exam they want, and generation starts.
   *
   * Separate from the upload on purpose. The material is read as soon as it
   * arrives because that is cheap and tells us whether there is anything here;
   * the questions wait, because writing twenty of them before asking how many
   * were wanted is a bill for a guess.
   */
  async setSpec(scope: ImportScope, id: string, dto: SetSpecDto) {
    const record = await this.prisma.paperImport.findFirst({
      where: { ...this.where(scope), id },
    });
    if (!record) throw new NotFoundException('Session not found');
    if (record.kind !== 'CONTENT') {
      throw new ConflictException({
        message: 'This session is an imported paper, not generated content',
        code: 'WRONG_KIND',
      });
    }
    if (!['CONFIGURING', 'REVIEW', 'FAILED'].includes(record.status)) {
      throw new ConflictException({
        message: 'The material is still being read',
        code: 'IMPORT_NOT_EDITABLE',
        status: record.status,
      });
    }

    const spec = normalizeSpec(dto as never);
    const problems = specProblems(spec);
    if (problems.length) {
      throw new BadRequestException({
        message: 'That exam cannot be built as described',
        code: 'BAD_SPEC',
        problems,
      });
    }

    const job = await this.enqueue(scope, { importId: record.id, phase: 'GENERATE' });
    return this.prisma.paperImport.update({
      where: { id: record.id },
      data: {
        spec: spec as unknown as Prisma.InputJsonValue,
        title: spec.title || record.title,
        status: 'PROCESSING',
        stage: 'GENERATING',
        jobId: job.id,
        error: null,
        progressDone: 0,
        progressTotal: spec.questionCount,
        // A second generation on the same material is a retry of the whole
        // thing, and worth counting as one.
        retryCount: record.status === 'REVIEW' ? { increment: 1 } : undefined,
      },
      select: { id: true, status: true, stage: true, jobId: true },
    });
  }

  /**
   * Rewrite one question, and only that one.
   *
   * Answered in the request that asked for it: one question is one small
   * model call, and queueing it would mean a teacher watching a spinner for
   * work that finishes before the next poll. The draft is re-read and
   * rewritten here rather than in the worker, so the teacher's other edits
   * are not lost to a job that started before them.
   */
  async regenerateQuestion(
    scope: ImportScope,
    id: string,
    questionId: string,
    dto: RegenerateQuestionDto = {},
  ) {
    const record = await this.requireEditable(scope, id, ['REVIEW']);
    if (record.kind !== 'CONTENT') {
      throw new ConflictException({
        message: 'Only a generated question can be written again',
        code: 'WRONG_KIND',
      });
    }

    const result = await this.content.regenerateOne(record, questionId, dto.reason);
    if (!result.question) {
      throw new ConflictException({
        message: 'A better question could not be written from this material',
        code: 'REGENERATE_FAILED',
        reason: result.error,
      });
    }

    // Replace it in place, so the teacher's ordering and their other edits
    // survive. Everything else about the draft is left exactly as it was.
    const draft = record.draft as unknown as ExamDraft;
    const sections = (draft.sections ?? []).map((section) => ({
      ...section,
      questions: section.questions.map((q: DraftQuestion) =>
        q.id === questionId ? { ...result.question!, id: q.id, number: q.number } : q,
      ),
    }));
    const updated: ExamDraft = { ...draft, sections };

    await this.prisma.paperImport.update({
      where: { id: record.id },
      data: {
        draft: updated as unknown as Prisma.InputJsonValue,
        costCents: { increment: Math.ceil(result.millicents / 1000) },
        generationBatches: { increment: 1 },
        retryCount: { increment: 1 },
      },
    });
    return { question: result.question };
  }

  /**
   * Stop the work that has not happened yet.
   *
   * The uploads stay. A teacher cancelling a generation has not decided the
   * lecture was a mistake — they have decided this exam was — and throwing
   * away the material would mean uploading it again to try different
   * settings, which is the commonest reason to cancel in the first place.
   */
  async cancel(scope: ImportScope, id: string) {
    const record = await this.prisma.paperImport.findFirst({
      where: { ...this.where(scope), id },
    });
    if (!record) throw new NotFoundException('Session not found');
    if (record.status === 'COMPLETED') {
      throw new ConflictException({
        message: 'This has already been turned into an exam',
        code: 'ALREADY_CONFIRMED',
      });
    }
    // Stopped whether queued or running, so the academy's lock is released
    // now rather than when the call in flight happens to return. The status
    // below is what stops that call's result being written.
    if (record.jobId) {
      await this.jobs.stop(scope.academyId, record.jobId).catch(() => undefined);
    }
    return this.prisma.paperImport.update({
      where: { id: record.id },
      data: {
        // Back to where the teacher can act: a content session returns to its
        // settings form, a paper one to whatever draft it had.
        status:
          record.kind === 'CONTENT' && record.stage === 'GENERATING' ? 'CONFIGURING' : 'CANCELED',
        stage: 'READY',
        highAccuracy: false,
        error: null,
      },
      select: { id: true, status: true, stage: true },
    });
  }

  // ── scoping ──────────────────────────────────────────────────────────────

  /**
   * Whose imports these are.
   *
   * The academy first, always — that is the tenancy boundary the rest of the
   * platform is built on. Inside a Center, an owner sees every teacher's
   * imports (they own the catalogue) and a teacher sees only their own, which
   * is exactly how `CourseScope.manageAll` works for courses.
   */
  private where(scope: ImportScope): Prisma.PaperImportWhereInput {
    return {
      academyId: scope.academyId,
      deletedAt: null,
      ...(scope.manageAll ? {} : { tenantId: scope.authorTenantId ?? '__none__' }),
    };
  }

  private async requireEditable(
    scope: ImportScope,
    id: string,
    allowed: string[] = ['REVIEW', 'FAILED'],
  ) {
    const record = await this.prisma.paperImport.findFirst({ where: { ...this.where(scope), id } });
    if (!record) throw new NotFoundException('Import not found');
    if (!allowed.includes(record.status)) {
      throw new ConflictException({
        message:
          record.status === 'COMPLETED'
            ? 'This import has already been turned into an exam'
            : 'The pages are still being read',
        code: 'IMPORT_NOT_EDITABLE',
        status: record.status,
      });
    }
    return record;
  }
}
