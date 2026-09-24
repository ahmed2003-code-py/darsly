import { PaperImport, PaperImportPage } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProvider } from '../storage/storage.provider';
import { ContentGenerationService } from './content-generation.service';
import { PaperImportConfig } from './paper-import.config';
import { QuestionGeneratorService, GeneratedQuestion } from './question-generator.service';
import { SourceReaderService } from './source-reader.service';
import { ExamDraft } from './extraction.schema';

const config = new PaperImportConfig();

const chunkRow = (index: number, text: string, page = index + 1) => ({
  index,
  text,
  sourceFile: 'biology.pdf',
  page,
  tokensApprox: 200,
});

/** Distinct subjects, because two questions that differ only by a random
 *  number really ARE duplicates and the service is right to drop them. */
const SUBJECTS = [
  'Which organelle produces ATP inside the plant cell during respiration?',
  'Explain how chloroplasts capture light energy during photosynthesis.',
  'What role does the Golgi body play in packaging cellular proteins?',
  'Describe the function of ribosomes in translating messenger RNA.',
  'How does the nucleus regulate gene expression inside a eukaryotic cell?',
  'What happens to glucose molecules during the Krebs cycle in mitochondria?',
  'Why do stomata close during drought conditions in a leaf?',
  'Compare active transport with passive diffusion across a membrane.',
];
let subject = 0;
const generated = (over: Partial<GeneratedQuestion> = {}): GeneratedQuestion => ({
  type: 'MCQ',
  difficulty: 'MEDIUM',
  text: SUBJECTS[subject++ % SUBJECTS.length],
  options: [
    { label: 'A', text: 'Mitochondrion', correct: true },
    { label: 'B', text: 'Ribosome', correct: false },
    { label: 'C', text: 'Golgi body', correct: false },
    { label: 'D', text: 'Nucleus', correct: false },
  ],
  modelAnswer: '',
  explanation: 'Respiration happens there.',
  marks: 1,
  chunkIndex: 0,
  ...over,
});

const ok = (questions: GeneratedQuestion[], over = {}) => ({
  questions,
  insufficient: false,
  supportable: questions.length,
  model: config.generationModel,
  inputTokens: 4000,
  outputTokens: 900,
  millicents: 1700,
  error: null,
  ...over,
});

/**
 * Writing an exam from lecture material — the session around the run.
 *
 * Nothing here reaches a provider: `generate` is scripted, and the algorithm
 * itself (slots, rounds, budget, profiles) has its own suite in
 * generation-run.spec.ts. What is asserted here is what the teacher ends up
 * with: the draft, the spec, the warnings, the cost, and what a stop does.
 */
describe('writing an exam from uploaded lecture material', () => {
  let prisma: any;
  let generator: QuestionGeneratorService;
  let generate: jest.SpyInstance;
  let service: ContentGenerationService;

  const LECTURE =
    'Mitochondria produce ATP through cellular respiration in the plant cell. Chloroplasts capture ' +
    'light energy during photosynthesis. The Golgi body plays a role packaging cellular proteins. ' +
    'Ribosomes function translating messenger RNA. The nucleus regulate gene expression inside a ' +
    'eukaryotic cell. Glucose molecules in the Krebs cycle in mitochondria. Stomata close during ' +
    'drought conditions in a leaf. Compare active transport with passive diffusion across a membrane.';

  const spec = {
    questionCount: 4,
    difficulty: 'MIXED',
    mix: { EASY: 25, MEDIUM: 50, HARD: 25 },
    types: { MCQ: 4, TRUE_FALSE: 0, SHORT_ANSWER: 0 },
    title: 'امتحان الأحياء',
    instructions: [],
    marksPerQuestion: null,
    timeLimitMin: 60,
    language: 'AUTO',
    shuffle: false,
    showAnswers: true,
  };

  const record = (over: Partial<PaperImport> = {}) =>
    ({
      id: 'imp1',
      kind: 'CONTENT',
      spec,
      draft: {},
      status: 'CONFIGURING',
      ...over,
    }) as PaperImport;

  /** Answer every request with what it asked for, one good question a slot. */
  const fine = (req: {
    plan: { type: string; difficulty: string }[];
    chunks: { index: number }[];
  }) =>
    ok(
      req.plan.map((p) =>
        generated({
          type: p.type as never,
          difficulty: p.difficulty as never,
          chunkIndex: req.chunks[0].index,
          ...(p.type === 'SHORT_ANSWER'
            ? { options: [], modelAnswer: 'Cellular respiration.' }
            : {}),
        }),
      ),
    );

  beforeEach(() => {
    subject = 0;
    generator = new QuestionGeneratorService({} as never, config);
    generate = jest.spyOn(generator, 'generate').mockImplementation(async (req) => fine(req));
    prisma = {
      paperImport: {
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        // Still running, unless a test says otherwise.
        findFirst: jest.fn().mockResolvedValue({ id: 'imp1' }),
      },
      paperImportPage: {
        update: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
      examSourceChunk: {
        findMany: jest.fn().mockResolvedValue([chunkRow(0, LECTURE), chunkRow(1, LECTURE)]),
        deleteMany: jest.fn(),
        create: jest.fn(),
      },
      $transaction: jest.fn().mockResolvedValue([]),
    };
    service = new ContentGenerationService(
      prisma as PrismaService,
      {} as StorageProvider,
      {} as SourceReaderService,
      generator,
      config,
    );
  });

  /** The final write: the guarded updateMany carrying the draft. */
  const finalWrite = () =>
    prisma.paperImport.updateMany.mock.calls
      .map((c: [{ data: Record<string, any> }]) => c[0].data)
      .filter((d: Record<string, any>) => d.draft)
      .pop();
  const savedDraft = (): ExamDraft => finalWrite().draft;
  const lastWarnings = (): { code: string; params?: Record<string, any> }[] =>
    finalWrite().warnings;

  it('writes the exam in batches, not one call per question', async () => {
    await service.generate(record());
    expect(generate).toHaveBeenCalledTimes(1);
    expect(savedDraft().sections[0].questions).toHaveLength(4);
  });

  it('writes on the configured profile, never the flagship', async () => {
    await service.generate(record());
    const models = generate.mock.calls.map((c) => c[0].tier.model);
    expect(models).not.toContain(config.strongModel);
    expect(models.every((m: string) => m === config.generationProfileOf().primary.model)).toBe(
      true,
    );
  });

  it('can be run on the other profile without changing the default', async () => {
    await service.generate(record(), { profile: 'LUNA_FIRST' });
    expect(generate.mock.calls[0][0].tier.model).toBe('gpt-6-luna');
    expect(config.generationProfile).toBe('SOL_FIRST');
  });

  it('keeps the good questions from a batch and asks again only for the rest', async () => {
    generate
      .mockImplementationOnce(async (req) => {
        const res = fine(req);
        res.questions[3] = generated({ text: '[unclear]', options: [] });
        return res;
      })
      .mockImplementation(async (req) => fine(req));

    await service.generate(record());

    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][0].plan).toHaveLength(1);
    expect(savedDraft().sections[0].questions).toHaveLength(4);
  });

  it('records where every question came from, by file and page', async () => {
    generate.mockImplementation(async (req) => {
      const res = fine(req);
      res.questions[0] = { ...res.questions[0], chunkIndex: 1 };
      return res;
    });
    await service.generate(record());
    const q = savedDraft().sections[0].questions.find((x) => x.sourceChunk === 1)!;
    expect(q.sourceFile).toBe('biology.pdf');
    expect(q.sourcePages).toEqual([2]);
  });

  it('records what the writing cost and how many calls it took', async () => {
    await service.generate(record());
    const final = finalWrite();
    expect(final.generationBatches).toBe(1);
    expect(final.costCents).toEqual({ increment: 2 });
  });

  it('marks variants and says how many there are', async () => {
    // Two small chunks carry fewer than twenty questions; the rest are owed
    // as variants, and only as many as are missing.
    prisma.examSourceChunk.findMany.mockResolvedValue([
      { ...chunkRow(0, LECTURE), tokensApprox: 150 },
      { ...chunkRow(1, LECTURE), tokensApprox: 150 },
    ]);
    await service.generate(
      record({
        spec: { ...spec, questionCount: 8, types: { MCQ: 8, TRUE_FALSE: 0, SHORT_ANSWER: 0 } },
      } as never),
    );
    const questions = savedDraft().sections[0].questions;
    expect(questions).toHaveLength(8);
    const told = lastWarnings().find((w) => w.code === 'COMPLETED_WITH_VARIANTS');
    expect(told?.params?.variants).toBe(questions.filter((q) => q.variant).length);
    expect(told?.params?.variants).toBeGreaterThan(0);
  });

  it('says the material is short only when the material is why', async () => {
    const off = Object.assign(new PaperImportConfig(), { generationVariantRounds: 0 });
    service = new ContentGenerationService(
      prisma as PrismaService,
      {} as StorageProvider,
      {} as SourceReaderService,
      generator,
      off,
    );
    prisma.examSourceChunk.findMany.mockResolvedValue([
      { ...chunkRow(0, LECTURE), tokensApprox: 150 },
    ]);
    await service.generate(record());
    const short = lastWarnings().find((w) => w.code === 'NOT_ENOUGH_CONTENT');
    expect(short?.params).toMatchObject({ got: 2, wanted: 4, missingMcq: 2 });
    expect(lastWarnings().some((w) => w.code === 'GENERATION_INCOMPLETE')).toBe(false);
  });

  it('reports a budget stop as incomplete, with the missing types — never as a finished exam', async () => {
    await service.generate(
      record({
        spec: { ...spec, questionCount: 4, types: { MCQ: 2, TRUE_FALSE: 1, SHORT_ANSWER: 1 } },
      } as never),
      { budgetCents: 0.3 },
    );
    const final = finalWrite();
    expect(generate).not.toHaveBeenCalled();
    expect(final.status).toBe('FAILED');
    expect(final.error).toMatch(/budget/);
    const told = lastWarnings().find((w) => w.code === 'GENERATION_INCOMPLETE');
    expect(told?.params).toMatchObject({
      got: 0,
      wanted: 4,
      reason: 'BUDGET',
      missingMcq: 2,
      missingTrueFalse: 1,
      missingWritten: 1,
    });
  });

  it('rewrites the stored specification to match the exam that exists', async () => {
    // Two good, then nothing that passes however often it is asked.
    generate
      .mockImplementationOnce(async (req) => {
        const res = fine(req);
        res.questions = res.questions.map((x, i) => (i < 2 ? x : { ...x, chunkIndex: 99 }));
        return res;
      })
      .mockImplementation(async (req) => {
        const res = fine(req);
        res.questions = res.questions.map((x) => ({ ...x, chunkIndex: 99 }));
        return res;
      });
    await service.generate(record());
    const saved = finalWrite().spec;
    expect(saved.questionCount).toBe(2);
    expect(saved.types.MCQ).toBe(saved.questionCount);
  });

  it('writes nothing over a session that was stopped, but still counts what it spent', async () => {
    prisma.paperImport.findFirst.mockResolvedValue(null);
    await service.generate(record());
    expect(finalWrite()).toBeUndefined();
    expect(prisma.paperImport.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { costCents: { increment: 0 } } }),
    );
  });

  it('does not overwrite a stop that lands after the last call', async () => {
    prisma.paperImport.updateMany.mockResolvedValue({ count: 0 });
    await service.generate(record());
    expect(prisma.paperImport.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { costCents: { increment: 2 } } }),
    );
  });

  it('fails honestly when the material produced nothing', async () => {
    generate.mockImplementation(async () => ok([]));
    await service.generate(record());
    expect(finalWrite().status).toBe('FAILED');
  });

  it('refuses to generate from a session with no material at all', async () => {
    prisma.examSourceChunk.findMany.mockResolvedValue([]);
    await service.generate(record());
    expect(generate).not.toHaveBeenCalled();
    expect(prisma.paperImport.update.mock.calls.pop()[0].data.status).toBe('FAILED');
  });
});

describe('reading lecture material', () => {
  it('stops between pages when the session is stopped, instead of paying for the rest', async () => {
    const prisma = {
      paperImport: {
        update: jest.fn().mockResolvedValue({}),
        // Stopped before the first page is read.
        findFirst: jest.fn().mockResolvedValue(null),
      },
      paperImportPage: { update: jest.fn() },
    };
    const reader = { readPage: jest.fn() };
    const service = new ContentGenerationService(
      prisma as unknown as PrismaService,
      { getBuffer: jest.fn() } as unknown as StorageProvider,
      reader as unknown as SourceReaderService,
      {} as QuestionGeneratorService,
      new PaperImportConfig(),
    );
    const page = (n: number) => ({
      id: `p${n}`,
      pageNumber: n,
      status: 'PENDING',
      textKey: null,
      renderKey: `r${n}`,
    });
    await service.read({ id: 'imp1', pages: [page(1), page(2), page(3)] } as never);
    expect(reader.readPage).not.toHaveBeenCalled();
    // The session is left as its owner left it — not moved on to CONFIGURING.
    expect(prisma.paperImport.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CONFIGURING' }) }),
    );
  });
});

describe('reading lecture material, several pages at once', () => {
  const page = (n: number) => ({
    id: `p${n}`,
    pageNumber: n,
    status: 'PENDING',
    textKey: null,
    renderKey: `r${n}`,
  });

  const setup = (live: () => boolean = () => true) => {
    let inflight = 0;
    let peak = 0;
    const started: number[] = [];
    const prisma = {
      paperImport: {
        update: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn(async () => (live() ? { id: 'imp1' } : null)),
      },
      paperImportPage: {
        update: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
      examSourceChunk: { deleteMany: jest.fn(), create: jest.fn() },
      $transaction: jest.fn().mockResolvedValue([]),
    };
    const reader = {
      readPage: jest.fn(async (input: { pageNumber: number; onPhase?: (p: any) => void }) => {
        started.push(input.pageNumber);
        inflight += 1;
        peak = Math.max(peak, inflight);
        input.onPhase?.({ phase: 'READING' });
        await new Promise((r) => setTimeout(r, 20));
        inflight -= 1;
        return {
          text: `page ${input.pageNumber}`,
          blank: false,
          model: 'gpt-6-luna',
          escalated: false,
          inputTokens: 100,
          outputTokens: 50,
          millicents: 1500,
          error: null,
        };
      }),
    };
    const service = new ContentGenerationService(
      prisma as unknown as PrismaService,
      {
        getBuffer: jest.fn().mockResolvedValue(Buffer.from('img')),
        put: jest.fn().mockResolvedValue(undefined),
      } as unknown as StorageProvider,
      reader as unknown as SourceReaderService,
      {} as QuestionGeneratorService,
      Object.assign(new PaperImportConfig(), { contentReadConcurrency: 2 }),
    );
    return { service, prisma, reader, started, peak: () => peak };
  };

  it('reads two pages at a time, never more', async () => {
    const t = setup();
    await t.service.read({ id: 'imp1', pages: [page(1), page(2), page(3), page(4)] } as never);
    expect(t.reader.readPage).toHaveBeenCalledTimes(4);
    expect(t.peak()).toBe(2);
  });

  it('starts no new page once stopped', async () => {
    let checks = 0;
    // Live for the first two pages to start, stopped after.
    const t = setup(() => ++checks <= 2);
    await t.service.read({ id: 'imp1', pages: [page(1), page(2), page(3), page(4)] } as never);
    expect(t.reader.readPage).toHaveBeenCalledTimes(2);
    // What was read is still paid for, and the session is not moved on.
    expect(t.prisma.paperImport.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { costCents: { increment: 3 } } }),
    );
    expect(t.prisma.paperImport.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CONFIGURING' }) }),
    );
  });

  it('counts reading in what the exam cost', async () => {
    const t = setup();
    await t.service.read({ id: 'imp1', pages: [page(1), page(2)] } as never);
    const last = t.prisma.paperImport.update.mock.calls.pop()![0].data;
    expect(last.costCents).toEqual({ increment: 3 });
  });

  it('says what it is doing to each page while it does it', async () => {
    const t = setup();
    await t.service.read({ id: 'imp1', pages: [page(1)] } as never);
    const phases = t.prisma.paperImportPage.update.mock.calls.map((c: any) => c[0].data.phase);
    expect(phases).toContain('READING');
    // And clears it when the page is done.
    expect(phases[phases.length - 1]).toBeNull();
  });
});

describe('writing one question again', () => {
  let prisma: any;
  let generator: { regenerateOne: jest.Mock };
  let service: ContentGenerationService;

  const draft: ExamDraft = {
    title: 'امتحان',
    instructions: [],
    sections: [
      {
        title: '',
        questions: [
          {
            id: 'q1',
            number: 1,
            type: 'MCQ',
            text: 'A question the teacher did not like at all here',
            options: [
              { id: 'o1', label: 'A', text: 'One', correct: true },
              { id: 'o2', label: 'B', text: 'Two', correct: false },
            ],
            modelAnswer: '',
            marks: 2,
            sourcePages: [1],
            sourceChunk: 0,
            unsupportedKind: '',
            needsReview: true,
          },
          {
            id: 'q2',
            number: 2,
            type: 'MCQ',
            text: 'A perfectly good question about chloroplasts and light energy',
            options: [
              { id: 'o3', label: 'A', text: 'Yes', correct: true },
              { id: 'o4', label: 'B', text: 'No', correct: false },
            ],
            modelAnswer: '',
            marks: 2,
            sourcePages: [2],
            sourceChunk: 1,
            unsupportedKind: '',
            needsReview: false,
          },
        ],
      },
    ],
  };

  beforeEach(() => {
    generator = { regenerateOne: jest.fn() };
    prisma = {
      examSourceChunk: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            chunkRow(0, 'Mitochondria produce ATP through cellular respiration in the cell.'),
            chunkRow(1, 'Chloroplasts capture light energy during photosynthesis in plants.'),
          ]),
      },
      paperImport: { update: jest.fn() },
    };
    service = new ContentGenerationService(
      prisma as PrismaService,
      {} as StorageProvider,
      {} as SourceReaderService,
      generator as unknown as QuestionGeneratorService,
      config,
    );
  });

  it('rewrites the one question, from the material that one came from', async () => {
    generator.regenerateOne.mockResolvedValue(ok([generated({ chunkIndex: 0 })]));

    const out = await service.regenerateOne(
      { id: 'imp1', spec: {}, draft } as never,
      'q1',
      'too easy',
    );

    expect(generator.regenerateOne).toHaveBeenCalledTimes(1);
    // Its own chunk is the first material it is given.
    expect(generator.regenerateOne.mock.calls[0][0].chunks[0].index).toBe(0);
    expect(out.question?.id).toBe('q1');
    expect(out.question?.number).toBe(1);
  });

  it('tells the model every other question, so the rewrite is not one of them', async () => {
    generator.regenerateOne.mockResolvedValue(ok([generated()]));
    await service.regenerateOne({ id: 'imp1', spec: {}, draft } as never, 'q1');
    const avoid = generator.regenerateOne.mock.calls[0][0].avoid;
    expect(avoid).toContain('A perfectly good question about chloroplasts and light energy');
    expect(avoid).not.toContain('A question the teacher did not like at all here');
  });

  it('passes on why the teacher rejected it', async () => {
    generator.regenerateOne.mockResolvedValue(ok([generated()]));
    await service.regenerateOne({ id: 'imp1', spec: {}, draft } as never, 'q1', 'too easy');
    expect(generator.regenerateOne.mock.calls[0][0].reason).toBe('too easy');
  });

  it('refuses a rewrite that would fail the same checks as the original', async () => {
    generator.regenerateOne.mockResolvedValue(ok([generated({ text: '[unclear]', options: [] })]));
    const out = await service.regenerateOne({ id: 'imp1', spec: {}, draft } as never, 'q1');
    expect(out.question).toBeNull();
    expect(out.error).toBe('REJECTED');
  });

  it('says so for a question that is not in the draft', async () => {
    const out = await service.regenerateOne({ id: 'imp1', spec: {}, draft } as never, 'nope');
    expect(out.error).toBe('NOT_FOUND');
    expect(generator.regenerateOne).not.toHaveBeenCalled();
  });
});
