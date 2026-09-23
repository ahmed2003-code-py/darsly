import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PaperImport, PaperSourceKind, Prisma } from '@prisma/client';
import { AiJobService } from '../academy-site/jobs/ai-job.service';
import { AuditService } from '../audit/audit.service';
import { assertMagicMatchesMime } from '../common/image.util';
import { CourseScope } from '../courses/courses.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProvider } from '../storage/storage.provider';
import { ConfirmImportDto, SaveDraftDto } from './dto/paper-import.dto';
import { ExamBuilderService } from './exam-builder.service';
import { DraftWarning, ExamDraft } from './extraction.schema';
import { PAPER_IMAGE_MIME, PAPER_PDF_MIME, PagePreparerService } from './page-preparer.service';
import { PaperImportConfig } from './paper-import.config';

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
  ) {}

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
  async create(scope: ImportScope, files: UploadedPaper[]): Promise<PaperImport> {
    if (!files?.length) {
      throw new BadRequestException({ message: 'Upload at least one page', code: 'NO_FILES' });
    }
    const pdf = files.find((f) => f.mimetype === PAPER_PDF_MIME);
    if (pdf && files.length > 1) {
      throw new BadRequestException({
        message: 'Upload either one PDF or a set of images, not both',
        code: 'MIXED_SOURCES',
      });
    }
    const kind: PaperSourceKind = pdf ? 'PDF' : 'IMAGES';

    for (const f of files) {
      if (f.mimetype === PAPER_PDF_MIME) {
        if (f.size > this.config.maxPdfBytes) {
          throw new BadRequestException({
            message: `That PDF is larger than ${Math.round(this.config.maxPdfBytes / 1024 / 1024)}MB`,
            code: 'PAPER_FILE_TOO_LARGE',
          });
        }
        // The declared type is a string the client chose; this is the bytes.
        if (f.buffer.subarray(0, 4).toString('latin1') !== '%PDF') {
          throw new BadRequestException({
            message: 'That file is not the PDF it claims to be',
            code: 'PAPER_CONTENT_MISMATCH',
          });
        }
      } else if (PAPER_IMAGE_MIME.test(f.mimetype)) {
        if (f.size > this.config.maxImageBytes) {
          throw new BadRequestException({
            message: `"${f.originalname}" is larger than ${Math.round(this.config.maxImageBytes / 1024 / 1024)}MB`,
            code: 'PAPER_FILE_TOO_LARGE',
          });
        }
        assertMagicMatchesMime(f.mimetype, f.buffer);
      } else {
        throw new BadRequestException({
          message: 'Pages must be PNG, JPEG or WebP images, or a single PDF',
          code: 'PAPER_UNSUPPORTED_TYPE',
        });
      }
    }

    if (kind === 'IMAGES' && files.length > this.config.maxPages) {
      throw new BadRequestException({
        message: `An import can hold ${this.config.maxPages} pages`,
        code: 'PAPER_TOO_MANY_PAGES',
      });
    }

    const record = await this.prisma.paperImport.create({
      data: {
        academyId: scope.academyId,
        tenantId: scope.authorTenantId!,
        createdBy: scope.userId,
        sourceKind: kind,
        status: 'UPLOADING',
      },
    });

    try {
      if (kind === 'PDF') {
        await this.storePdf(record.id, pdf!);
      } else {
        await this.storeImages(record.id, files);
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

    const job = await this.jobs.enqueue(
      scope.academyId,
      'PAPER_IMPORT',
      { importId: record.id },
      // Only another import blocks an import. A teacher scanning an exam and
      // an academy regenerating its site have nothing to do with each other.
      { conflictsWith: ['PAPER_IMPORT'] },
    );

    await this.audit.log({
      actorUserId: scope.userId,
      academyId: scope.academyId,
      action: 'paper-import.create',
      entity: 'PaperImport',
      entityId: record.id,
      meta: { sourceKind: kind, files: files.length },
    });

    return this.prisma.paperImport.update({
      where: { id: record.id },
      data: { status: 'PROCESSING', jobId: job.id },
    });
  }

  /** A PDF: kept whole as the original, then split into one page each. */
  private async storePdf(importId: string, file: UploadedPaper): Promise<void> {
    const sourceKey = `${this.prefix(importId)}/source.pdf`;
    await this.storage.put(sourceKey, file.buffer, { contentType: PAPER_PDF_MIME });

    await this.preparer.withPdf(file.buffer, async (handle) => {
      const count = await handle.pageCount();
      if (count > this.config.maxPages) {
        throw new BadRequestException({
          message: `That PDF has ${count} pages; an import can hold ${this.config.maxPages}`,
          code: 'PAPER_TOO_MANY_PAGES',
        });
      }
      for (let page = 1; page <= count; page++) {
        // Free first: a PDF that already carries its text costs no image
        // tokens at all, and most PDFs a teacher exports from Word do.
        const text = await handle.text(page);
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
              originalMime: PAPER_PDF_MIME,
              bytes: file.size,
              textKey,
            },
          });
          continue;
        }
        const rendered = await handle.render(page);
        const renderKey = `${this.prefix(importId)}/page/${page}.jpg`;
        await this.storage.put(renderKey, rendered.data, { contentType: rendered.mimeType });
        await this.prisma.paperImportPage.create({
          data: {
            importId,
            pageNumber: page,
            originalKey: sourceKey,
            originalMime: PAPER_PDF_MIME,
            bytes: file.size,
            renderKey,
            width: rendered.width,
            height: rendered.height,
          },
        });
      }
    });
  }

  /** Photographs: each is its own page, original kept beside the normalised
   *  copy that is actually sent. */
  private async storeImages(importId: string, files: UploadedPaper[]): Promise<void> {
    let page = 0;
    for (const file of files) {
      page += 1;
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
          originalMime: file.mimetype,
          bytes: file.size,
          renderKey,
          width: prepared.width,
          height: prepared.height,
        },
      });
    }
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
        status: true,
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
          },
        },
      },
    });
    if (!record) throw new NotFoundException('Import not found');

    const done = record.pages.filter((p) => p.status !== 'PENDING').length;
    const { pages, draft, warnings, ...rest } = record;
    return {
      ...rest,
      pages,
      draft: draft as unknown as ExamDraft,
      warnings: warnings as unknown as DraftWarning[],
      progress: { done, total: pages.length },
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
   * Read the pages that failed, again — and only those.
   *
   * The successful pages keep their answers, so a retry after one bad photo
   * costs one page, not the stack. A retry with nothing to retry is refused
   * rather than silently spending nothing and looking like it worked.
   */
  async retry(scope: ImportScope, id: string) {
    const record = await this.requireEditable(scope, id, ['REVIEW', 'FAILED', 'PROCESSING']);
    const failed = await this.prisma.paperImportPage.count({
      where: { importId: record.id, status: { in: ['FAILED', 'PENDING'] } },
    });
    if (!failed) {
      throw new ConflictException({
        message: 'Every page was read successfully — there is nothing to retry',
        code: 'NOTHING_TO_RETRY',
      });
    }
    const job = await this.jobs.enqueue(
      scope.academyId,
      'PAPER_IMPORT',
      { importId: record.id },
      { conflictsWith: ['PAPER_IMPORT'] },
    );
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

    const built = await this.builder.build(scope, draft, dto);

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
