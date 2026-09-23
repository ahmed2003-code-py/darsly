import { AiJob } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProvider } from '../storage/storage.provider';
import { PaperExtractionService } from './paper-extraction.service';
import { PaperImportHandler } from './paper-import.handler';
import { PageExtraction } from './extraction.schema';

const extraction: PageExtraction = {
  examTitle: 'Chemistry',
  instructions: [],
  sectionTitle: '',
  blank: false,
  questions: [
    {
      number: 1,
      type: 'SHORT_ANSWER',
      text: 'Define an exothermic reaction.',
      options: [],
      modelAnswer: '',
      marks: 3,
      unsupportedKind: '',
      continuedFromPrevious: false,
      lowConfidence: false,
    },
  ],
};

const page = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  pageNumber: 1,
  status: 'PENDING',
  renderKey: 'paper-imports/imp1/page/1.jpg',
  textKey: null,
  inputTokens: 0,
  outputTokens: 0,
  costMillicents: 0,
  extracted: null,
  ...over,
});

const job = { id: 'job1', input: { importId: 'imp1' } } as unknown as AiJob;

/**
 * The worker stage: which pages get read, and what is left behind.
 *
 * The behaviour worth pinning down is the one that costs money — a retry must
 * re-read the pages that failed and nothing else, because the successful ones
 * already hold their answers and re-reading them is a second bill for work
 * that was already done correctly.
 */
describe('reading a stack on the queue', () => {
  let prisma: any;
  let storage: any;
  let extract: jest.Mock;
  let handler: PaperImportHandler;

  beforeEach(() => {
    extract = jest.fn().mockResolvedValue({
      extraction,
      model: 'gpt-6-luna',
      escalationReason: null,
      escalated: false,
      inputTokens: 1500,
      outputTokens: 300,
      millicents: 165,
      error: null,
    });
    prisma = {
      paperImport: { findFirst: jest.fn(), update: jest.fn().mockResolvedValue({}) },
      paperImportPage: {
        update: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
      aiJob: { update: jest.fn().mockResolvedValue({}) },
    };
    storage = { getBuffer: jest.fn().mockResolvedValue(Buffer.from('jpeg')) };
    handler = new PaperImportHandler(
      prisma as PrismaService,
      storage as StorageProvider,
      { extractPage: extract } as unknown as PaperExtractionService,
    );
  });

  it('reads every page of a fresh import', async () => {
    prisma.paperImport.findFirst.mockResolvedValue({
      id: 'imp1',
      status: 'PROCESSING',
      pages: [page(), page({ id: 'p2', pageNumber: 2 })],
    });

    await handler.handle(job);

    expect(extract).toHaveBeenCalledTimes(2);
  });

  it('re-reads only the pages that failed', async () => {
    prisma.paperImport.findFirst.mockResolvedValue({
      id: 'imp1',
      status: 'REVIEW',
      pages: [
        page({ status: 'EXTRACTED', extracted: extraction }),
        page({ id: 'p2', pageNumber: 2, status: 'FAILED' }),
        page({ id: 'p3', pageNumber: 3, status: 'ESCALATED', extracted: extraction }),
      ],
    });

    await handler.handle(job);

    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract.mock.calls[0][0].pageNumber).toBe(2);
  });

  it('does not touch a draft the teacher has already confirmed', async () => {
    prisma.paperImport.findFirst.mockResolvedValue({ id: 'imp1', status: 'COMPLETED', pages: [] });

    await handler.handle(job);

    expect(extract).not.toHaveBeenCalled();
    expect(prisma.paperImport.update).not.toHaveBeenCalled();
  });

  it('sends the stored text instead of the picture when the page has one', async () => {
    prisma.paperImport.findFirst.mockResolvedValue({
      id: 'imp1',
      status: 'PROCESSING',
      pages: [page({ renderKey: null, textKey: 'paper-imports/imp1/text/1.txt' })],
    });
    storage.getBuffer.mockResolvedValue(Buffer.from('Question 1: define an exothermic reaction.'));

    await handler.handle(job);

    expect(extract.mock.calls[0][0].text).toContain('exothermic');
    expect(extract.mock.calls[0][0].image).toBeUndefined();
  });

  it('marks a page failed when its bytes are gone, without failing the import', async () => {
    prisma.paperImport.findFirst.mockResolvedValue({
      id: 'imp1',
      status: 'PROCESSING',
      pages: [page()],
    });
    storage.getBuffer.mockRejectedValue(new Error('NoSuchKey'));

    await handler.handle(job);

    expect(extract).not.toHaveBeenCalled();
    expect(prisma.paperImportPage.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
  });

  it('leaves the import in review with a warning when one page of several failed', async () => {
    prisma.paperImport.findFirst.mockResolvedValue({
      id: 'imp1',
      status: 'PROCESSING',
      pages: [page()],
    });
    prisma.paperImportPage.findMany.mockResolvedValue([
      page({
        status: 'EXTRACTED',
        extracted: extraction,
        inputTokens: 1500,
        outputTokens: 300,
        costMillicents: 165,
      }),
      page({ id: 'p2', pageNumber: 2, status: 'FAILED' }),
    ]);

    await handler.handle(job);

    const saved = prisma.paperImport.update.mock.calls.at(-1)[0].data;
    expect(saved.status).toBe('REVIEW');
    expect(saved.warnings.some((w: { code: string }) => w.code === 'PAGE_FAILED')).toBe(true);
  });

  it('fails the import only when nothing at all could be read', async () => {
    prisma.paperImport.findFirst.mockResolvedValue({
      id: 'imp1',
      status: 'PROCESSING',
      pages: [page()],
    });
    prisma.paperImportPage.findMany.mockResolvedValue([page({ status: 'FAILED' })]);

    await handler.handle(job);

    expect(prisma.paperImport.update.mock.calls.at(-1)[0].data.status).toBe('FAILED');
  });

  it("adds up what the stack cost, in the pages' own fractions of a cent", async () => {
    prisma.paperImport.findFirst.mockResolvedValue({
      id: 'imp1',
      status: 'PROCESSING',
      pages: [page()],
    });
    prisma.paperImportPage.findMany.mockResolvedValue([
      page({
        status: 'EXTRACTED',
        extracted: extraction,
        inputTokens: 1500,
        outputTokens: 300,
        costMillicents: 165,
      }),
      page({
        id: 'p2',
        pageNumber: 2,
        status: 'ESCALATED',
        extracted: extraction,
        inputTokens: 3000,
        outputTokens: 600,
        costMillicents: 1200,
      }),
    ]);

    const result = await handler.handle(job);

    const saved = prisma.paperImport.update.mock.calls.at(-1)[0].data;
    expect(saved.inputTokens).toBe(4500);
    expect(saved.outputTokens).toBe(900);
    expect(saved.escalatedPages).toBe(1);
    // 1.365¢ of work, reported as 2¢ on the job — rounded once, at the end.
    expect(saved.costCents).toBe(2);
    expect(result).toEqual({ costCents: 2 });
  });

  it('records which model read each page and why it escalated', async () => {
    extract.mockResolvedValue({
      extraction,
      model: 'gpt-6-sol',
      escalationReason: 'LOW_CONFIDENCE',
      escalated: true,
      inputTokens: 3000,
      outputTokens: 600,
      millicents: 1200,
      error: null,
    });
    prisma.paperImport.findFirst.mockResolvedValue({
      id: 'imp1',
      status: 'PROCESSING',
      pages: [page()],
    });

    await handler.handle(job);

    expect(prisma.paperImportPage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'ESCALATED',
          model: 'gpt-6-sol',
          escalationReason: 'LOW_CONFIDENCE',
          costMillicents: 1200,
        }),
      }),
    );
  });

  it('passes the teacher-chosen tier through to the reader', async () => {
    prisma.paperImport.findFirst.mockResolvedValue({
      id: 'imp1',
      status: 'REVIEW',
      pages: [page()],
    });

    await handler.handle({ id: 'job1', input: { importId: 'imp1', tier: 'STRONG' } } as never);

    expect(extract.mock.calls[0][0].tier).toBe('STRONG');
  });

  it('reads on the ordinary ladder when no tier was asked for', async () => {
    prisma.paperImport.findFirst.mockResolvedValue({
      id: 'imp1',
      status: 'PROCESSING',
      pages: [page()],
    });

    await handler.handle(job);

    expect(extract.mock.calls[0][0].tier).toBe('AUTO');
  });

  it('refuses a job that names no import', async () => {
    await expect(handler.handle({ id: 'job1', input: {} } as unknown as AiJob)).rejects.toThrow();
  });
});
