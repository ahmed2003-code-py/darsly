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
 * Writing an exam from lecture material.
 *
 * Nothing here reaches a provider — the generator is a mock, so the suite runs
 * offline and no test can spend money. What is asserted is the shape of the
 * decisions: how many calls, on which model, from which material, and what
 * happens to a batch that comes back wrong.
 */
describe('writing an exam from uploaded lecture material', () => {
  let prisma: any;
  let generator: {
    generateBatch: jest.Mock;
    regenerateOne: jest.Mock;
    batchCount: jest.Mock;
    batchOf: jest.Mock;
  };
  let service: ContentGenerationService;

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

  beforeEach(() => {
    subject = 0;
    const real = new QuestionGeneratorService({} as never, config);
    generator = {
      generateBatch: jest.fn(),
      regenerateOne: jest.fn(),
      batchCount: jest.fn((n: number) => real.batchCount(n)),
      batchOf: jest.fn((plan: never[], i: number) => real.batchOf(plan, i)),
    };
    prisma = {
      paperImport: { update: jest.fn().mockResolvedValue({}) },
      paperImportPage: {
        update: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
      examSourceChunk: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            chunkRow(0, 'Mitochondria produce ATP through cellular respiration in the cell.'),
            chunkRow(1, 'Chloroplasts capture light energy during photosynthesis in plants.'),
          ]),
        deleteMany: jest.fn(),
        create: jest.fn(),
      },
      $transaction: jest.fn().mockResolvedValue([]),
    };
    service = new ContentGenerationService(
      prisma as PrismaService,
      {} as StorageProvider,
      {} as SourceReaderService,
      generator as unknown as QuestionGeneratorService,
      config,
    );
  });

  const savedDraft = (): ExamDraft =>
    prisma.paperImport.update.mock.calls
      .map((c: [{ data: { draft?: ExamDraft } }]) => c[0].data.draft)
      .filter(Boolean)
      .pop() as ExamDraft;

  it('writes the exam in batches, not one call per question', async () => {
    generator.generateBatch.mockResolvedValue(
      ok([generated(), generated(), generated(), generated()]),
    );

    await service.generate(record());

    // Four questions, one call — not four.
    expect(generator.generateBatch).toHaveBeenCalledTimes(1);
    expect(savedDraft().sections[0].questions).toHaveLength(4);
  });

  it('writes on the affordable model, never the flagship, when all goes well', async () => {
    generator.generateBatch.mockResolvedValue(
      ok([generated(), generated(), generated(), generated()]),
    );
    await service.generate(record());
    expect(generator.generateBatch.mock.calls[0][0].stronger).toBeFalsy();
  });

  it('keeps the good questions from a batch and asks again only for the rest', async () => {
    // Seven good, one broken: the seven are kept, not thrown away and paid
    // for a second time.
    const broken = generated({ text: '[unclear]', options: [] });
    generator.generateBatch
      .mockResolvedValueOnce(ok([generated(), generated(), generated(), broken]))
      .mockResolvedValueOnce(ok([generated(), generated(), generated(), generated()]));

    await service.generate(record());

    expect(generator.generateBatch).toHaveBeenCalledTimes(2);
    // The second attempt is the escalation, on the stronger model.
    expect(generator.generateBatch.mock.calls[1][0].stronger).toBe(true);
  });

  it('stops asking after the configured number of attempts', async () => {
    generator.generateBatch.mockResolvedValue(ok([generated({ text: '[unclear]', options: [] })]));
    await service.generate(record());
    expect(generator.generateBatch).toHaveBeenCalledTimes(config.generationMaxAttempts);
  });

  it('tells the teacher the material is short rather than inventing the difference', async () => {
    generator.generateBatch.mockResolvedValue(
      ok([generated(), generated()], { insufficient: true, supportable: 2 }),
    );

    await service.generate(record());

    const warnings = prisma.paperImport.update.mock.calls
      .map(
        (c: [{ data: { warnings?: { code: string; params?: Record<string, number> }[] } }]) =>
          c[0].data.warnings,
      )
      .filter(Boolean)
      .pop();
    const short = warnings.find((w: { code: string }) => w.code === 'NOT_ENOUGH_CONTENT');
    expect(short).toBeTruthy();
    expect(short.params).toMatchObject({ got: 2, wanted: 4 });
    expect(savedDraft().sections[0].questions).toHaveLength(2);
  });

  it('does not ask a better model to re-read a paragraph that is simply short', async () => {
    generator.generateBatch.mockResolvedValue(
      ok([generated()], { insufficient: true, supportable: 1 }),
    );
    await service.generate(record());
    // One attempt: the material is the limit, and a stronger model does not
    // lengthen it.
    expect(generator.generateBatch).toHaveBeenCalledTimes(1);
  });

  it('refuses a question it cannot attach to the material it was given', async () => {
    generator.generateBatch.mockResolvedValue(
      ok([generated(), generated({ chunkIndex: 99 }), generated(), generated()]),
    );
    await service.generate(record());
    const texts = savedDraft().sections[0].questions.map((q) => q.text);
    expect(texts).toHaveLength(3);
  });

  it('records where every question came from, by file and page', async () => {
    generator.generateBatch.mockResolvedValue(
      ok([generated({ chunkIndex: 1 }), generated(), generated(), generated()]),
    );
    await service.generate(record());
    const q = savedDraft().sections[0].questions.find((x) => x.sourceChunk === 1)!;
    expect(q.sourceFile).toBe('biology.pdf');
    expect(q.sourcePages).toEqual([2]);
  });

  it('drops a question that repeats one already written', async () => {
    const same = 'Which organelle produces ATP inside the plant cell during respiration?';
    generator.generateBatch.mockResolvedValue(
      ok([generated({ text: same }), generated({ text: same }), generated(), generated()]),
    );
    await service.generate(record());
    const texts = savedDraft().sections[0].questions.map((q) => q.text);
    expect(texts.filter((t) => t === same)).toHaveLength(1);
  });

  it('counts its own progress as questions land, for the screen to read', async () => {
    generator.generateBatch.mockResolvedValue(
      ok([generated(), generated(), generated(), generated()]),
    );
    await service.generate(record());
    const progress = prisma.paperImport.update.mock.calls
      .map((c: [{ data: { progressDone?: number } }]) => c[0].data.progressDone)
      .filter((n: number | undefined) => n != null);
    expect(progress).toContain(4);
  });

  it('records what the writing cost and how many calls it took', async () => {
    generator.generateBatch.mockResolvedValue(
      ok([generated(), generated(), generated(), generated()]),
    );
    await service.generate(record());
    const final = prisma.paperImport.update.mock.calls.pop()[0].data;
    expect(final.generationBatches).toBe(1);
    expect(final.costCents).toEqual({ increment: 2 });
  });

  it('never escalates to the flagship because the material was simply short', async () => {
    // The ten-minute bug: one page, twenty questions asked for, three batches
    // over the same paragraph, every repeat dropped as a duplicate, the
    // shortfall read as a model failure, all three batches escalated. Six
    // flagship calls to produce what one call had already produced.
    generator.generateBatch.mockResolvedValue(ok([generated(), generated()]));

    await service.generate(record());

    // Nothing came back broken, so nothing is worth a better reader.
    expect(generator.generateBatch.mock.calls.every((c) => !c[0].stronger)).toBe(true);
  });

  it('stops asking once the material has given what it has', async () => {
    generator.generateBatch.mockResolvedValue(ok([generated()]));

    await service.generate(
      record({
        spec: { ...spec, questionCount: 16, types: { MCQ: 16, TRUE_FALSE: 0, SHORT_ANSWER: 0 } },
      } as never),
    );

    // One short batch ends it: the next batch would be handed the same chunks.
    expect(generator.generateBatch).toHaveBeenCalledTimes(1);
  });

  it('still escalates when a batch comes back broken rather than short', async () => {
    const broken = generated({ text: '[unclear]', options: [] });
    generator.generateBatch
      .mockResolvedValueOnce(ok([generated(), generated(), generated(), broken]))
      .mockResolvedValueOnce(ok([generated(), generated(), generated(), generated()]));

    await service.generate(record());

    expect(generator.generateBatch).toHaveBeenCalledTimes(2);
    expect(generator.generateBatch.mock.calls[1][0].stronger).toBe(true);
  });

  it('cuts the plan to what the material can carry before spending anything', async () => {
    // Two 200-token chunks cannot carry fifty questions, and finding that out
    // by generating seven batches is the expensive way to learn it.
    generator.generateBatch.mockResolvedValue(ok([generated(), generated()]));

    await service.generate(
      record({
        spec: { ...spec, questionCount: 50, types: { MCQ: 50, TRUE_FALSE: 0, SHORT_ANSWER: 0 } },
      } as never),
    );

    const askedFor = generator.generateBatch.mock.calls[0][0].plan.length;
    expect(askedFor).toBeLessThanOrEqual(8);
    expect(generator.generateBatch.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('rewrites the stored specification to match the exam that exists', async () => {
    // Otherwise the settings form keeps asking for 20 over a draft of 13, and
    // the teacher has to correct a number they never chose before it will save.
    generator.generateBatch.mockResolvedValue(ok([generated(), generated()]));

    await service.generate(record());

    const saved = prisma.paperImport.update.mock.calls
      .map(
        (c: [{ data: { spec?: { questionCount: number; types: Record<string, number> } } }]) =>
          c[0].data.spec,
      )
      .filter(Boolean)
      .pop();
    expect(saved.questionCount).toBe(2);
    expect(saved.types.MCQ).toBe(2);
  });

  it('tells the teacher the new breakdown, not just the shortfall', async () => {
    generator.generateBatch.mockResolvedValue(ok([generated(), generated()]));

    await service.generate(record());

    const warnings = prisma.paperImport.update.mock.calls
      .map(
        (c: [{ data: { warnings?: { code: string; params?: Record<string, number> }[] } }]) =>
          c[0].data.warnings,
      )
      .filter(Boolean)
      .pop();
    const short = warnings.find((w: { code: string }) => w.code === 'NOT_ENOUGH_CONTENT');
    expect(short.params).toMatchObject({ got: 2, wanted: 4, mcq: 2, trueFalse: 0, written: 0 });
  });

  it('fails honestly when the material produced nothing', async () => {
    generator.generateBatch.mockResolvedValue(ok([]));
    await service.generate(record());
    expect(prisma.paperImport.update.mock.calls.pop()[0].data.status).toBe('FAILED');
  });

  it('refuses to generate from a session with no material at all', async () => {
    prisma.examSourceChunk.findMany.mockResolvedValue([]);
    await service.generate(record());
    expect(generator.generateBatch).not.toHaveBeenCalled();
    expect(prisma.paperImport.update.mock.calls.pop()[0].data.status).toBe('FAILED');
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
