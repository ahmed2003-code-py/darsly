import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AiJobService } from '../academy-site/jobs/ai-job.service';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProvider } from '../storage/storage.provider';
import { ContentGenerationService } from './content-generation.service';
import { ExamBuilderService } from './exam-builder.service';
import { PagePreparerService } from './page-preparer.service';
import { PaperImportConfig } from './paper-import.config';
import { ImportScope, PaperImportService, UploadedPaper } from './paper-import.service';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(64)]);

const file = (over: Partial<UploadedPaper> = {}): UploadedPaper => ({
  buffer: PNG,
  mimetype: 'image/png',
  originalname: 'page-1.png',
  size: PNG.length,
  ...over,
});

const scope: ImportScope = {
  academyId: 'acad1',
  authorTenantId: 'teacher1',
  manageAll: false,
  userId: 'user1',
};

/**
 * Upload validation, tenancy, and the states an import may be moved between.
 *
 * Everything an upload is trusted about is checked here, because everything an
 * upload says about itself is a string it chose. Nothing in this file reaches
 * a provider, a database or a disk.
 */
describe('accepting a stack of paper', () => {
  let prisma: any;
  let storage: any;
  let preparer: any;
  let jobs: any;
  let builder: any;
  let audit: any;
  let service: PaperImportService;

  beforeEach(() => {
    prisma = {
      paperImport: {
        create: jest.fn().mockResolvedValue({ id: 'imp1' }),
        update: jest.fn().mockResolvedValue({ id: 'imp1', status: 'PROCESSING' }),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      paperImportPage: { create: jest.fn().mockResolvedValue({}), count: jest.fn() },
      aiJob: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    storage = {
      put: jest.fn().mockResolvedValue(undefined),
      deletePrefix: jest.fn().mockResolvedValue(undefined),
      exists: jest.fn().mockResolvedValue(true),
      getStream: jest.fn(),
    };
    preparer = {
      normalizeImage: jest
        .fn()
        .mockResolvedValue({ data: PNG, mimeType: 'image/jpeg', width: 1200, height: 1600 }),
      withPdf: jest.fn(),
    };
    jobs = { enqueue: jest.fn().mockResolvedValue({ id: 'job1' }) };
    builder = { build: jest.fn() };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    service = new PaperImportService(
      prisma as PrismaService,
      storage as StorageProvider,
      preparer as PagePreparerService,
      new PaperImportConfig(),
      jobs as AiJobService,
      builder as ExamBuilderService,
      audit as AuditService,
      { regenerateOne: jest.fn() } as unknown as ContentGenerationService,
    );
  });

  it('stores the original beside the copy it will actually send', async () => {
    await service.create(scope, [file()]);

    const keys = storage.put.mock.calls.map((c: string[]) => c[0]);
    expect(keys).toContain('paper-imports/imp1/original/1.png');
    expect(keys).toContain('paper-imports/imp1/page/1.jpg');
    // Both are recorded, so a re-read has something to re-read from.
    expect(prisma.paperImportPage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          originalKey: 'paper-imports/imp1/original/1.png',
          renderKey: 'paper-imports/imp1/page/1.jpg',
        }),
      }),
    );
  });

  it('refuses a file whose bytes are not the type it claims to be', async () => {
    const lying = file({ buffer: Buffer.from('GIF89a not a png'), mimetype: 'image/png' });
    await expect(service.create(scope, [lying])).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('refuses a PDF that is not a PDF', async () => {
    const lying = file({ buffer: Buffer.from('<?php ?>'), mimetype: 'application/pdf' });
    await expect(service.create(scope, [lying])).rejects.toMatchObject({
      response: { code: 'PAPER_CONTENT_MISMATCH' },
    });
  });

  it('refuses a type nobody asked for, and names the file', async () => {
    const zip = file({ mimetype: 'application/zip', originalname: 'exam.zip' });
    await expect(service.create(scope, [zip])).rejects.toMatchObject({
      response: { code: 'PAPER_UNSUPPORTED_TYPE', params: { name: 'exam.zip' } },
    });
  });

  it('refuses a PDF whose bytes are not a PDF even in a mixed upload', async () => {
    await expect(
      service.create(scope, [
        file(),
        file({ mimetype: 'application/pdf', buffer: Buffer.from('<?php ?>') }),
      ]),
    ).rejects.toMatchObject({ response: { code: 'PAPER_CONTENT_MISMATCH' } });
    // Refused before a single byte is stored.
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('refuses an image past the size ceiling, and says by how much', async () => {
    // "Too large" makes a teacher guess how much smaller. The numbers travel
    // so the screen can write the sentence in their language.
    const huge = file({ originalname: 'scan.png', size: 200 * 1024 * 1024 });
    await expect(service.create(scope, [huge])).rejects.toMatchObject({
      response: {
        code: 'PAPER_FILE_TOO_LARGE',
        params: { name: 'scan.png', mb: 200, limit: 15 },
      },
    });
  });

  it('says how many pages are allowed when a PDF has too many', async () => {
    const handle = {
      pageCount: jest.fn().mockResolvedValue(80),
      text: jest.fn(),
      render: jest.fn(),
    };
    preparer.withPdf.mockImplementation((_b: Buffer, fn: (h: unknown) => Promise<void>) =>
      fn(handle),
    );

    await expect(
      service.create(scope, [
        file({ originalname: 'book.pdf', mimetype: 'application/pdf', buffer: PDF }),
      ]),
    ).rejects.toMatchObject({
      response: { code: 'PAPER_TOO_MANY_PAGES', params: { got: 80, limit: 25 } },
    });
  });

  it('publishes the ceilings so a screen can say them before they are hit', () => {
    const limits = service.limits();
    expect(limits.paper.maxPages).toBeGreaterThan(0);
    // A lecture is allowed to be longer than an exam, because it is.
    expect(limits.content.maxPages).toBeGreaterThan(limits.paper.maxPages);
    expect(limits.maxPdfMb).toBeGreaterThan(limits.maxImageMb);
    expect(limits.maxFiles).toBeGreaterThan(1);
  });

  it('refuses more pages than an import is allowed to hold', async () => {
    const many = Array.from({ length: 40 }, (_, i) => file({ originalname: `p${i}.png` }));
    await expect(service.create(scope, many)).rejects.toMatchObject({
      response: { code: 'PAPER_TOO_MANY_PAGES' },
    });
  });

  it('takes a PDF and loose photographs as one exam, numbered in the order sent', async () => {
    // Three photographs and the printed cover sheet are one exam, not two
    // imports — this used to be refused outright.
    const handle = {
      pageCount: jest.fn().mockResolvedValue(2),
      text: jest.fn().mockResolvedValue(null),
      render: jest
        .fn()
        .mockResolvedValue({ data: PNG, mimeType: 'image/jpeg', width: 1200, height: 1600 }),
    };
    preparer.withPdf.mockImplementation((_b: Buffer, fn: (h: unknown) => Promise<void>) =>
      fn(handle),
    );

    await service.create(scope, [
      file({ originalname: 'cover.pdf', mimetype: 'application/pdf', buffer: PDF }),
      file({ originalname: 'page-3.png' }),
    ]);

    const numbers = prisma.paperImportPage.create.mock.calls.map(
      (c: [{ data: { pageNumber: number } }]) => c[0].data.pageNumber,
    );
    expect(numbers).toEqual([1, 2, 3]);
    expect(prisma.paperImport.create.mock.calls[0][0].data.sourceKind).toBe('MIXED');
  });

  it('keeps the teacher\u2019s own file name, so a source reference means something', async () => {
    await service.create(scope, [file({ originalname: 'biology-page-1.png' })]);
    expect(prisma.paperImportPage.create.mock.calls[0][0].data.originalName).toBe(
      'biology-page-1.png',
    );
  });

  it('refuses an empty upload', async () => {
    await expect(service.create(scope, [])).rejects.toMatchObject({
      response: { code: 'NO_FILES' },
    });
  });

  it('leaves nothing half-stored when a page fails to prepare', async () => {
    preparer.normalizeImage.mockRejectedValueOnce(new Error('sharp said no'));

    await expect(service.create(scope, [file()])).rejects.toThrow('sharp said no');

    expect(prisma.paperImport.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
    expect(storage.deletePrefix).toHaveBeenCalledWith('paper-imports/imp1');
  });

  it('lets an import queue behind another import, but not behind a site generation', async () => {
    await service.create(scope, [file()]);
    expect(jobs.enqueue).toHaveBeenCalledWith(
      'acad1',
      'PAPER_IMPORT',
      { importId: 'imp1' },
      { conflictsWith: ['PAPER_IMPORT'] },
    );
  });

  it('while this teacher’s other exam is being read: refuses before storing anything, and says where it is', async () => {
    prisma.aiJob.findFirst.mockResolvedValue({ input: { importId: 'running' } });
    prisma.paperImport.findFirst.mockResolvedValue({
      id: 'running',
      courseId: 'c9',
      createdBy: 'user1',
    });
    const err = await service.create(scope, [file()]).catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({
      code: 'IMPORT_IN_PROGRESS',
      params: { importId: 'running', courseId: 'c9' },
    });
    // Nothing half-made is left behind to show up as a draft.
    expect(prisma.paperImport.create).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('another teacher’s session blocks too, but is not named', async () => {
    prisma.aiJob.findFirst.mockResolvedValue({ input: { importId: 'theirs' } });
    prisma.paperImport.findFirst.mockResolvedValue({
      id: 'theirs',
      courseId: null,
      createdBy: 'someone-else',
    });
    const err = await service.create(scope, [file()]).catch((e) => e);
    expect(err.getResponse()).toEqual({
      message: expect.any(String),
      code: 'IMPORT_IN_PROGRESS_OTHER',
    });
  });

  it('a start that loses the race is closed, not left as unfinished work', async () => {
    jobs.enqueue.mockRejectedValue(new ConflictException('busy'));
    await expect(service.create(scope, [file()])).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.paperImport.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELED' }) }),
    );
    expect(storage.deletePrefix).toHaveBeenCalledWith('paper-imports/imp1');
  });

  it('records who uploaded what', async () => {
    await service.create(scope, [file()]);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user1',
        academyId: 'acad1',
        action: 'paper-import.create',
      }),
    );
  });

  it('reads a PDF page as text when the PDF already carries it, and never renders it', async () => {
    const handle = {
      pageCount: jest.fn().mockResolvedValue(1),
      text: jest.fn().mockResolvedValue('Question 1: state Newton’s first law of motion.'),
      render: jest.fn(),
    };
    preparer.withPdf.mockImplementation((_b: Buffer, fn: (h: unknown) => Promise<void>) =>
      fn(handle),
    );

    await service.create(scope, [file({ mimetype: 'application/pdf', buffer: PDF })]);

    expect(handle.render).not.toHaveBeenCalled();
    const written = prisma.paperImportPage.create.mock.calls[0][0].data;
    expect(written.textKey).toBe('paper-imports/imp1/text/1.txt');
    // No picture was stored, so the page costs no image tokens at all.
    expect(written.renderKey).toBeUndefined();
  });

  it('renders a scanned PDF page, because there is no text to read', async () => {
    const handle = {
      pageCount: jest.fn().mockResolvedValue(1),
      text: jest.fn().mockResolvedValue(null),
      render: jest
        .fn()
        .mockResolvedValue({ data: PNG, mimeType: 'image/jpeg', width: 1200, height: 1600 }),
    };
    preparer.withPdf.mockImplementation((_b: Buffer, fn: (h: unknown) => Promise<void>) =>
      fn(handle),
    );

    await service.create(scope, [file({ mimetype: 'application/pdf', buffer: PDF })]);

    expect(handle.render).toHaveBeenCalledWith(1);
    expect(prisma.paperImportPage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ renderKey: 'paper-imports/imp1/page/1.jpg' }),
      }),
    );
  });
});

describe('who may touch an import', () => {
  let prisma: any;
  let service: PaperImportService;

  beforeEach(() => {
    prisma = {
      paperImport: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn() },
      paperImportPage: { findFirst: jest.fn().mockResolvedValue(null), count: jest.fn() },
      aiJob: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    service = new PaperImportService(
      prisma as PrismaService,
      {} as StorageProvider,
      {} as PagePreparerService,
      new PaperImportConfig(),
      {} as AiJobService,
      {} as ExamBuilderService,
      {} as AuditService,
      {} as ContentGenerationService,
    );
  });

  it('scopes every read to the academy and to the teacher who owns it', async () => {
    await expect(service.get(scope, 'imp1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.paperImport.findFirst.mock.calls[0][0].where).toMatchObject({
      academyId: 'acad1',
      tenantId: 'teacher1',
      deletedAt: null,
      id: 'imp1',
    });
  });

  it("lets a Center owner see their Center's, the same rule courses follow", async () => {
    await expect(service.get({ ...scope, manageAll: true }, 'imp1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const where = prisma.paperImport.findFirst.mock.calls[0][0].where;
    expect(where.academyId).toBe('acad1');
    expect(where.tenantId).toBeUndefined();
  });

  it('answers "not found" for another academy\'s import, not "forbidden"', async () => {
    await expect(service.openPage(scope, 'imp1', 'page1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.paperImportPage.findFirst.mock.calls[0][0].where.import).toMatchObject({
      academyId: 'acad1',
      tenantId: 'teacher1',
    });
  });

  it('refuses to make a second exam out of an import that already made one', async () => {
    prisma.paperImport.findFirst.mockResolvedValue({
      id: 'imp1',
      status: 'COMPLETED',
      lessonId: 'lesson1',
      courseId: 'course1',
    });
    await expect(service.confirm(scope, 'imp1', { target: 'NEW_COURSE' })).rejects.toMatchObject({
      response: { code: 'ALREADY_CONFIRMED', lessonId: 'lesson1' },
    });
  });

  it('refuses to confirm an import whose pages have not been read yet', async () => {
    prisma.paperImport.findFirst.mockResolvedValue({ id: 'imp1', status: 'PROCESSING', draft: {} });
    await expect(service.confirm(scope, 'imp1', { target: 'NEW_COURSE' })).rejects.toMatchObject({
      response: { code: 'NO_DRAFT' },
    });
  });

  describe('confirming carries the settings chosen in the Studio', () => {
    const ready = (over: Record<string, unknown>) => ({
      id: 'imp1',
      status: 'REVIEW',
      draft: { title: 't', instructions: [], sections: [{ title: '', questions: [{}] }] },
      ...over,
    });

    it('an exam written from material gets the time, shuffle and answer settings the teacher set', async () => {
      prisma.paperImport.findFirst.mockResolvedValue(
        ready({ kind: 'CONTENT', spec: { timeLimitMin: 30, shuffle: true, showAnswers: false } }),
      );
      builder.build.mockResolvedValue({ courseId: 'c1', lessonId: 'l1', questionCount: 1 });
      await service.confirm(scope, 'imp1', { target: 'NEW_COURSE' }).catch(() => undefined);
      expect(builder.build.mock.calls[0][3]).toMatchObject({
        timeLimitMin: 30,
        shuffle: true,
        showAnswers: false,
      });
    });

    it('a paper import was never asked, so nothing is imposed on it — not even the form defaults', async () => {
      prisma.paperImport.findFirst.mockResolvedValue(ready({ kind: 'PAPER', spec: null }));
      builder.build.mockResolvedValue({ courseId: 'c1', lessonId: 'l1', questionCount: 1 });
      await service.confirm(scope, 'imp1', { target: 'NEW_COURSE' }).catch(() => undefined);
      expect(builder.build.mock.calls[0][3]).toBeUndefined();
    });
  });

  it('refuses to edit the draft while the pages are still being read', async () => {
    prisma.paperImport.findFirst.mockResolvedValue({ id: 'imp1', status: 'PROCESSING' });
    await expect(
      service.saveDraft(scope, 'imp1', { title: 't', instructions: [], sections: [] }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses a retry when every page was read successfully', async () => {
    prisma.paperImport.findFirst.mockResolvedValue({ id: 'imp1', status: 'REVIEW' });
    prisma.paperImportPage.count.mockResolvedValue(0);
    await expect(service.retry(scope, 'imp1')).rejects.toMatchObject({
      response: { code: 'NOTHING_TO_RETRY' },
    });
  });

  it('re-reads the whole paper on the flagship when the teacher asks for it', async () => {
    // Not a retry of failures: the pages that "succeeded" are exactly the ones
    // the teacher is rejecting, so every one of them goes back on the queue.
    prisma.paperImport.findFirst.mockResolvedValue({ id: 'imp1', status: 'REVIEW' });
    prisma.paperImportPage.count.mockResolvedValue(0);
    prisma.paperImportPage.updateMany = jest.fn().mockResolvedValue({ count: 3 });
    prisma.paperImport.update = jest.fn().mockResolvedValue({ id: 'imp1' });
    (service as unknown as { jobs: { enqueue: jest.Mock } }).jobs = {
      enqueue: jest.fn().mockResolvedValue({ id: 'job9' }),
    };
    (service as unknown as { audit: { log: jest.Mock } }).audit = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    await service.retry(scope, 'imp1', { escalate: true });

    expect(prisma.paperImportPage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PENDING' }) }),
    );
    const enqueue = (service as unknown as { jobs: { enqueue: jest.Mock } }).jobs.enqueue;
    expect(enqueue.mock.calls[0][2]).toEqual({ importId: 'imp1', tier: 'STRONG' });
  });

  it('does not mark an ordinary retry as the expensive one', async () => {
    prisma.paperImport.findFirst.mockResolvedValue({ id: 'imp1', status: 'REVIEW' });
    prisma.paperImportPage.count.mockResolvedValue(2);
    prisma.paperImport.update = jest.fn().mockResolvedValue({ id: 'imp1' });
    (service as unknown as { jobs: { enqueue: jest.Mock } }).jobs = {
      enqueue: jest.fn().mockResolvedValue({ id: 'job9' }),
    };
    (service as unknown as { audit: { log: jest.Mock } }).audit = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    await service.retry(scope, 'imp1');

    const enqueue = (service as unknown as { jobs: { enqueue: jest.Mock } }).jobs.enqueue;
    expect(enqueue.mock.calls[0][2]).toEqual({ importId: 'imp1' });
  });
});
