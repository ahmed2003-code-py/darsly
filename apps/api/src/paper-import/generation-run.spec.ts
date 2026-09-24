import { AiJobError } from '../academy-site/ai/ai-job.error';
import { ExamSpec, normalizeSpec } from './exam-spec';
import { GenerationBudget } from './generation-budget';
import { GenerationRun } from './generation-run';
import { PaperImportConfig } from './paper-import.config';
import {
  GeneratedQuestion,
  GenerationRequest,
  GenerationResult,
  QuestionGeneratorService,
} from './question-generator.service';
import { GradedQuestion, questionProblem } from './question-quality';
import { SourceChunk, supportableQuestions } from './source-text';

/**
 * The generation algorithm, with no provider anywhere near it.
 *
 * The generator's `generate` is scripted per test; its prompt building and
 * worst-case pricing are the real ones, so the budget is exercised against
 * the numbers production would reserve.
 */

const LECTURE =
  'The mitochondria produce ATP through cellular respiration inside the plant cell. ' +
  'Chloroplasts capture light energy during photosynthesis. The Golgi body packages cellular proteins. ' +
  'Ribosomes translate messenger RNA. The nucleus regulates gene expression in a eukaryotic cell. ' +
  'Glucose molecules are broken down during the Krebs cycle. Stomata close during drought conditions. ' +
  'Active transport differs from passive diffusion across a membrane. Enzymes lower activation energy. ' +
  'Osmosis moves water across a membrane. Photosynthesis releases oxygen. Mitosis produces two cells. ' +
  'Meiosis produces gametes. Chlorophyll absorbs light. Diffusion needs no energy. Proteins fold.';

const chunk = (index: number, tokens = 200): SourceChunk => ({
  index,
  text: LECTURE,
  sourceFile: 'biology.pdf',
  page: index + 1,
  tokensApprox: tokens,
});

const TOPICS = [
  'Which organelle produces ATP inside the plant cell during respiration?',
  'Explain how chloroplasts capture light energy during photosynthesis.',
  'What role does the Golgi body play in packaging cellular proteins?',
  'Describe the function of ribosomes in translating messenger RNA.',
  'How does the nucleus regulate gene expression inside a eukaryotic cell?',
  'What happens to glucose molecules during the Krebs cycle?',
  'Why do stomata close during drought conditions?',
  'Compare active transport with passive diffusion across a membrane.',
  'How do enzymes lower activation energy?',
  'In which direction does osmosis move water across a membrane?',
  'Which gas does photosynthesis release?',
  'How many cells does mitosis produce?',
  'What does meiosis produce?',
  'What does chlorophyll absorb?',
  'Does diffusion need energy?',
  'Why must proteins fold?',
  'Where inside the cell does respiration produce ATP molecules?',
  'Which pigment inside chloroplasts absorbs light?',
  'Which organelle regulates gene expression?',
  'Which process produces gametes?',
];
let topic = 0;

// Each question gets its own answer. Twenty questions that all answer
// "Mitochondria" are, to the learning-point check, largely one question.
const q = (over: Partial<GeneratedQuestion> = {}): GeneratedQuestion => {
  const type = over.type ?? 'MCQ';
  const n = topic++;
  return {
    type,
    difficulty: 'MEDIUM',
    text: TOPICS[n % TOPICS.length],
    options:
      type === 'MCQ'
        ? [
            { label: 'A', text: `Answer ${n}`, correct: true },
            { label: 'B', text: 'Ribosome', correct: false },
            { label: 'C', text: 'Golgi body', correct: false },
            { label: 'D', text: 'Nucleus', correct: false },
          ]
        : type === 'TRUE_FALSE'
          ? [
              { label: 'A', text: 'True', correct: true },
              { label: 'B', text: 'False', correct: false },
            ]
          : [],
    modelAnswer: type === 'SHORT_ANSWER' ? `Answer ${n}.` : '',
    explanation: '',
    marks: 1,
    chunkIndex: 0,
    ...over,
  };
};

/** What a batch writes when every question it was asked for is fine. */
const answer = (
  req: GenerationRequest,
  over: (i: number) => Partial<GeneratedQuestion> = () => ({}),
) =>
  req.plan.map((p, i) =>
    q({
      type: p.type,
      difficulty: p.difficulty,
      // From the chunk its line named, as asked.
      chunkIndex: req.targets?.[i] ?? req.chunks[0].index,
      ...over(i),
    }),
  );

const result = (
  req: GenerationRequest,
  questions: GeneratedQuestion[],
  over: Partial<GenerationResult> = {},
): GenerationResult => ({
  questions,
  insufficient: false,
  supportable: questions.length,
  model: req.tier.model,
  effort: req.tier.effort,
  inputTokens: 3000,
  cachedInputTokens: 0,
  outputTokens: 2000,
  reasoningTokens: 800,
  // What the call would actually cost at its tier's price.
  millicents: Math.round(
    (3000 / 1e6) * req.tier.price.inPerMToken * 1000 +
      (2000 / 1e6) * req.tier.price.outPerMToken * 1000,
  ),
  durationMs: 10,
  error: null,
  ...over,
});

const spec = (
  types: { MCQ: number; TRUE_FALSE: number; SHORT_ANSWER: number },
  language: ExamSpec['language'] = 'AUTO',
): ExamSpec =>
  normalizeSpec({
    questionCount: types.MCQ + types.TRUE_FALSE + types.SHORT_ANSWER,
    types,
    difficulty: 'MIXED',
    language,
  });

function setup(over: Partial<PaperImportConfig> = {}) {
  const config = Object.assign(new PaperImportConfig(), over) as PaperImportConfig;
  const generator = new QuestionGeneratorService({} as never, config);
  const calls: GenerationRequest[] = [];
  let script: (
    req: GenerationRequest,
    n: number,
  ) => Promise<GenerationResult> | GenerationResult = (req) => result(req, answer(req));
  jest.spyOn(generator, 'generate').mockImplementation(async (req) => {
    calls.push(req);
    return script(req, calls.length - 1);
  });
  const run = new GenerationRun(generator, config);
  return {
    config,
    generator,
    calls,
    run,
    respond: (fn: typeof script) => {
      script = fn;
    },
  };
}

const ALLOWED = ['gpt-6-luna', 'gpt-6-sol'];

beforeEach(() => {
  topic = 0;
});

describe('keeping what passed, asking only for what did not', () => {
  it('keeps seven good questions and asks for the one missing slot alone', async () => {
    const t = setup();
    const chunks = [chunk(0, 800), chunk(1, 800)];
    t.respond((req, n) =>
      n === 0
        ? // Eight asked for, one comes back with no correct option.
          result(
            req,
            answer(req, (i) =>
              i === 3
                ? {
                    options: [
                      { label: 'A', text: 'x one', correct: false },
                      { label: 'B', text: 'y two', correct: false },
                      { label: 'C', text: 'z three', correct: false },
                    ],
                  }
                : {},
            ),
          )
        : result(req, answer(req)),
    );

    const out = await t.run.run({
      importId: 'imp',
      asked: spec({ MCQ: 8, TRUE_FALSE: 0, SHORT_ANSWER: 0 }),
      chunks,
      profile: t.config.generationProfileOf('SOL_FIRST'),
      budgetMillicents: 25_000,
    });

    expect(t.calls).toHaveLength(2);
    expect(t.calls[0].plan).toHaveLength(8);
    // The replacement is for one question, not the batch.
    expect(t.calls[1].plan).toHaveLength(1);
    expect(t.calls[1].plan[0].type).toBe('MCQ');
    expect(t.calls[1].reason).toMatch(/no correct answer/);
    expect(out.report.accepted).toBe(8);
    expect(out.report.complete).toBe(true);
    // The seven from the first call are the seven that were kept.
    const firstTexts = TOPICS.slice(0, 8).filter((_, i) => i !== 3);
    for (const text of firstTexts) expect(out.questions.map((x) => x.text)).toContain(text);
  });

  it('replaces the exact type that failed, not whatever comes next in the plan', async () => {
    const t = setup();
    t.respond((req, n) =>
      n === 0
        ? // The true/false comes back with three options.
          result(
            req,
            answer(req, (i) =>
              req.plan[i].type === 'TRUE_FALSE'
                ? {
                    options: [
                      { label: 'A', text: 'True', correct: true },
                      { label: 'B', text: 'False', correct: false },
                      { label: 'C', text: 'Maybe', correct: false },
                    ],
                  }
                : {},
            ),
          )
        : result(req, answer(req)),
    );
    const out = await t.run.run({
      importId: 'imp',
      asked: spec({ MCQ: 4, TRUE_FALSE: 2, SHORT_ANSWER: 2 }),
      chunks: [chunk(0, 800), chunk(1, 800)],
      profile: t.config.generationProfileOf('SOL_FIRST'),
      budgetMillicents: 25_000,
    });
    expect(t.calls[1].plan.map((p) => p.type)).toEqual(['TRUE_FALSE', 'TRUE_FALSE']);
    expect(out.report.acceptedByType).toEqual({ MCQ: 4, TRUE_FALSE: 2, SHORT_ANSWER: 2 });
    expect(out.report.rejections.BAD_OPTIONS).toBe(2);
  });

  it('fills slots by type even when the model writes them in a different order', async () => {
    const t = setup();
    t.respond((req) => result(req, [...answer(req)].reverse()));
    const out = await t.run.run({
      importId: 'imp',
      asked: spec({ MCQ: 2, TRUE_FALSE: 1, SHORT_ANSWER: 1 }),
      chunks: [chunk(0, 800)],
      profile: t.config.generationProfileOf('SOL_FIRST'),
      budgetMillicents: 25_000,
    });
    expect(t.calls).toHaveLength(1);
    expect(out.report.complete).toBe(true);
    // In the order the exam was planned, not the order they were written.
    expect(out.questions.map((x) => x.type)).toEqual(['MCQ', 'TRUE_FALSE', 'SHORT_ANSWER', 'MCQ']);
  });

  it('refuses a question of a type nobody asked for', async () => {
    const t = setup({ generationRounds: 1 } as never);
    t.respond((req) =>
      result(
        req,
        answer(req, () => ({
          type: 'SHORT_ANSWER',
          options: [],
          modelAnswer: 'An answer about respiration in the cell.',
        })),
      ),
    );
    const out = await t.run.run({
      importId: 'imp',
      asked: spec({ MCQ: 2, TRUE_FALSE: 0, SHORT_ANSWER: 0 }),
      chunks: [chunk(0, 800)],
      profile: t.config.generationProfileOf('SOL_FIRST'),
      budgetMillicents: 25_000,
    });
    expect(out.report.accepted).toBe(0);
    expect(out.report.rejections.TYPE_MISMATCH).toBe(2);
  });
});

describe('duplicates', () => {
  it('drops a question that repeats one accepted in another batch', async () => {
    const t = setup({ generationRounds: 1 } as never);
    const repeated = TOPICS[0];
    t.respond((req, n) =>
      result(
        req,
        answer(req, (i) => (n === 1 && i === 0 ? { text: repeated } : {})),
      ),
    );
    const out = await t.run.run({
      importId: 'imp',
      asked: spec({ MCQ: 16, TRUE_FALSE: 0, SHORT_ANSWER: 0 }),
      chunks: [chunk(0, 900), chunk(1, 900), chunk(2, 900)],
      profile: t.config.generationProfileOf('SOL_FIRST'),
      budgetMillicents: 25_000,
    });
    expect(out.questions.filter((x) => x.text === repeated)).toHaveLength(1);
    expect(out.report.rejections.DUPLICATE).toBe(1);
  });

  it('does not accept a replacement that repeats an accepted question', async () => {
    const t = setup();
    t.respond((req, n) =>
      n === 0
        ? result(
            req,
            answer(req, (i) => (i === 1 ? { chunkIndex: 99 } : {})),
          )
        : result(
            req,
            answer(req, () => ({ text: TOPICS[0] })),
          ),
    );
    const out = await t.run.run({
      importId: 'imp',
      asked: spec({ MCQ: 4, TRUE_FALSE: 0, SHORT_ANSWER: 0 }),
      chunks: [chunk(0, 800)],
      profile: t.config.generationProfileOf('SOL_FIRST'),
      budgetMillicents: 25_000,
    });
    expect(out.questions.filter((x) => x.text === TOPICS[0])).toHaveLength(1);
    expect(out.report.accepted).toBe(3);
  });
});

describe('what a generated question must be', () => {
  const graded = (over: Record<string, unknown>) =>
    ({
      id: 'x',
      number: 1,
      type: 'MCQ',
      text: 'Which organelle produces ATP in the cell?',
      options: [
        { id: '1', label: 'A', text: 'Mitochondria', correct: true },
        { id: '2', label: 'B', text: 'Ribosome', correct: false },
        { id: '3', label: 'C', text: 'Nucleus', correct: false },
        { id: '4', label: 'D', text: 'Golgi body', correct: false },
      ],
      modelAnswer: '',
      marks: 1,
      sourcePages: [],
      unsupportedKind: '',
      needsReview: false,
      chunkIndex: 0,
      ...over,
    }) as GradedQuestion & { options: any[] };
  const ctx = { chunkText: LECTURE, anchor: true };

  it('passes a well-formed, grounded question', () => {
    expect(questionProblem(graded({}), ctx)).toBeNull();
  });
  it('needs exactly one correct option', () => {
    const none = graded({}).options.map((o: { correct: boolean }) => ({ ...o, correct: false }));
    const two = graded({}).options.map((o: { correct: boolean }, i: number) => ({
      ...o,
      correct: i < 2,
    }));
    expect(questionProblem(graded({ options: none }), ctx)).toBe('NO_KEY');
    expect(questionProblem(graded({ options: two }), ctx)).toBe('MULTIPLE_KEYS');
  });
  it('needs a real set of options', () => {
    const [a, b] = graded({}).options;
    expect(questionProblem(graded({ options: [a, b] }), ctx)).toBe('BAD_OPTIONS');
    const repeated = graded({}).options.map((o: object) => ({
      ...o,
      text: 'Same',
      correct: false,
    }));
    repeated[0].correct = true;
    expect(questionProblem(graded({ options: repeated }), ctx)).toBe('BAD_OPTIONS');
    expect(questionProblem(graded({ type: 'TRUE_FALSE' }), ctx)).toBe('BAD_OPTIONS');
  });
  it('needs a model answer for a written question', () => {
    expect(
      questionProblem(graded({ type: 'SHORT_ANSWER', options: [], modelAnswer: '' }), ctx),
    ).toBe('NO_KEY');
  });
  it('must name a chunk it was given, and share words with it', () => {
    expect(questionProblem(graded({ chunkIndex: null }), ctx)).toBe('UNGROUNDED');
    expect(questionProblem(graded({}), { chunkText: null, anchor: true })).toBe('UNGROUNDED');
    const offTopic = graded({
      text: 'Who won the football championship yesterday evening?',
      options: [
        { id: '1', label: 'A', text: 'Zamalek', correct: true },
        { id: '2', label: 'B', text: 'Ahly', correct: false },
        { id: '3', label: 'C', text: 'Pyramids', correct: false },
      ],
    });
    expect(questionProblem(offTopic, ctx)).toBe('UNGROUNDED');
    // Written in another language than the material: no word could match,
    // so the anchor is not asked for.
    expect(questionProblem(offTopic, { chunkText: LECTURE, anchor: false })).toBeNull();
  });
});

describe('bounded: rounds, calls, budget', () => {
  it('stops after its rounds when every answer keeps failing', async () => {
    const t = setup();
    t.respond((req) =>
      result(
        req,
        answer(req, () => ({ chunkIndex: 99 })),
      ),
    );
    const out = await t.run.run({
      importId: 'imp',
      asked: spec({ MCQ: 4, TRUE_FALSE: 0, SHORT_ANSWER: 0 }),
      chunks: [chunk(0, 800)],
      profile: t.config.generationProfileOf('SOL_FIRST'),
      budgetMillicents: 25_000,
    });
    expect(t.calls.length).toBeLessThanOrEqual(t.config.generationRounds);
    expect(out.report.complete).toBe(false);
    expect(out.report.missingByType.MCQ).toBe(4);
    expect(['ROUNDS', 'NO_PROGRESS']).toContain(out.report.stopReason);
  });

  it('never makes more calls than the cap', async () => {
    const t = setup({ generationMaxCalls: 2, generationRounds: 5 } as never);
    t.respond((req) =>
      result(
        req,
        answer(req, () => ({ chunkIndex: 99 })),
      ),
    );
    const out = await t.run.run({
      importId: 'imp',
      asked: spec({ MCQ: 20, TRUE_FALSE: 0, SHORT_ANSWER: 0 }),
      chunks: [chunk(0, 900), chunk(1, 900), chunk(2, 900)],
      profile: t.config.generationProfileOf('SOL_FIRST'),
      budgetMillicents: 100_000,
    });
    expect(t.calls).toHaveLength(2);
    expect(out.report.stopReason).toBe('CALLS');
  });

  it('does not start a call whose worst case does not fit, and says so', async () => {
    const t = setup();
    const out = await t.run.run({
      importId: 'imp',
      asked: spec({ MCQ: 8, TRUE_FALSE: 0, SHORT_ANSWER: 0 }),
      chunks: [chunk(0, 800)],
      profile: t.config.generationProfileOf('SOL_FIRST'),
      // Half a cent: less than one sol batch could cost.
      budgetMillicents: 500,
    });
    expect(t.calls).toHaveLength(0);
    expect(out.report.stopReason).toBe('BUDGET');
    expect(out.report.missingByType.MCQ).toBe(8);
  });

  it('ends partial on the budget, keeping what it had and naming what is missing', async () => {
    const t = setup();
    const chunks = [chunk(0, 900), chunk(1, 900), chunk(2, 900)];
    const worst = t.generator.worstCase({
      tier: t.config.generationProfileOf('SOL_FIRST').primary,
      mode: 'DISTINCT',
      plan: Array(8).fill({ index: 1, type: 'MCQ', difficulty: 'MEDIUM', marks: 1 }),
      chunks: chunks.slice(0, 2),
      language: 'AUTO',
      avoid: [],
    });
    // Room for one batch in flight and a little more: a second batch starts
    // only once the first has settled below its worst case.
    const out = await t.run.run({
      importId: 'imp',
      asked: spec({ MCQ: 14, TRUE_FALSE: 3, SHORT_ANSWER: 3 }),
      chunks,
      profile: t.config.generationProfileOf('SOL_FIRST'),
      budgetMillicents: Math.ceil(worst * 1.2),
    });
    expect(out.report.stopReason).toBe('BUDGET');
    expect(out.report.accepted).toBeGreaterThan(0);
    expect(out.report.accepted).toBeLessThan(20);
    const missing = Object.values(out.report.missingByType).reduce((a, b) => a + b, 0);
    expect(missing).toBe(20 - out.report.accepted);
    // The application's own count never goes past the limit.
    expect(out.report.chargedMillicents).toBeLessThanOrEqual(out.report.budgetMillicents);
  });

  it('charges a timed-out call its worst case, since it may have been billed', async () => {
    const t = setup({ generationRounds: 1 } as never);
    t.respond((req) =>
      result(req, [], {
        error: 'OpenAI request failed: Request timed out.',
        usageUnknown: true,
        millicents: 0,
      }),
    );
    const out = await t.run.run({
      importId: 'imp',
      asked: spec({ MCQ: 4, TRUE_FALSE: 0, SHORT_ANSWER: 0 }),
      chunks: [chunk(0, 800)],
      profile: t.config.generationProfileOf('SOL_FIRST'),
      budgetMillicents: 25_000,
    });
    expect(out.report.millicents).toBe(0);
    expect(out.report.chargedMillicents).toBeGreaterThan(0);
    expect(out.report.callLog[0].usageUnknown).toBe(true);
  });
});

describe('running batches side by side', () => {
  it('writes independent batches at the same time, and counts every one', async () => {
    const t = setup();
    let inflight = 0;
    let peak = 0;
    t.respond(async (req) => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight -= 1;
      return result(req, answer(req));
    });
    const out = await t.run.run({
      importId: 'imp',
      asked: spec({ MCQ: 14, TRUE_FALSE: 3, SHORT_ANSWER: 3 }),
      // Four chunks: six questions a chunk is the most one is asked to carry.
      chunks: [chunk(0, 900), chunk(1, 900), chunk(2, 900), chunk(3, 900)],
      profile: t.config.generationProfileOf('SOL_FIRST'),
      budgetMillicents: 25_000,
    });
    expect(t.calls).toHaveLength(3);
    expect(peak).toBe(3);
    expect(out.report.complete).toBe(true);
    const sum = out.report.callLog.reduce((n, c) => n + c.millicents, 0);
    expect(out.report.millicents).toBe(sum);
    expect(out.report.callLog.at(-1)!.cumulativeMillicents).toBe(sum);
  });

  it('holds a batch back when running it alongside the others could break the budget', async () => {
    const t = setup();
    let inflight = 0;
    let peak = 0;
    t.respond(async (req) => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight -= 1;
      return result(req, answer(req));
    });
    const chunks = [chunk(0, 900), chunk(1, 900), chunk(2, 900)];
    const worst = t.generator.worstCase({
      tier: t.config.generationProfileOf('SOL_FIRST').primary,
      mode: 'DISTINCT',
      plan: Array(8).fill({ index: 1, type: 'MCQ', difficulty: 'MEDIUM', marks: 1 }),
      chunks: chunks.slice(0, 2),
      language: 'AUTO',
      avoid: [],
    });
    await t.run.run({
      importId: 'imp',
      asked: spec({ MCQ: 20, TRUE_FALSE: 0, SHORT_ANSWER: 0 }),
      chunks,
      profile: t.config.generationProfileOf('SOL_FIRST'),
      budgetMillicents: Math.ceil(worst * 1.5),
    });
    expect(peak).toBe(1);
  });

  it('keeps budget accounting exact when calls overlap', () => {
    const b = new GenerationBudget(10_000);
    const one = b.reserve(6_000)!;
    expect(b.reserve(6_000)).toBeNull();
    b.settle(one, 2_500);
    const two = b.reserve(6_000)!;
    expect(two).not.toBeNull();
    b.settle(two, 3_000);
    expect(b.spentMillicents).toBe(5_500);
    expect(b.remainingMillicents).toBe(4_500);
  });
});

describe('stopping', () => {
  it('starts nothing more once the session is stopped', async () => {
    const t = setup();
    let live = true;
    t.respond((req, n) => {
      live = false; // stopped while the first call was out
      return result(
        req,
        answer(req, (i) => (n === 0 && i === 0 ? { chunkIndex: 99 } : {})),
      );
    });
    const out = await t.run.run({
      importId: 'imp',
      asked: spec({ MCQ: 4, TRUE_FALSE: 0, SHORT_ANSWER: 0 }),
      chunks: [chunk(0, 800)],
      profile: t.config.generationProfileOf('SOL_FIRST'),
      budgetMillicents: 25_000,
      isLive: async () => live,
    });
    expect(t.calls).toHaveLength(1);
    expect(out.report.stopReason).toBe('CANCELED');
    // What came back before the stop is still accounted for.
    expect(out.report.millicents).toBeGreaterThan(0);
  });
});

describe('the profiles, and the flagship', () => {
  it('never writes on anything but luna or sol, on either profile', async () => {
    for (const name of ['SOL_FIRST', 'LUNA_FIRST'] as const) {
      const t = setup();
      t.respond((req) =>
        result(
          req,
          answer(req, () => ({ chunkIndex: 99 })),
        ),
      );
      await t.run.run({
        importId: 'imp',
        asked: spec({ MCQ: 14, TRUE_FALSE: 3, SHORT_ANSWER: 3 }),
        chunks: [chunk(0, 900), chunk(1, 900), chunk(2, 900)],
        profile: t.config.generationProfileOf(name),
        budgetMillicents: 100_000,
      });
      for (const c of t.calls) expect(ALLOWED).toContain(c.tier.model);
      expect(t.calls.some((c) => c.tier.model === t.config.strongModel)).toBe(false);
    }
  });

  it('refuses a model outside the allow-list before calling anything', async () => {
    const config = new PaperImportConfig();
    const ai = { completeStructured: jest.fn(), costMillicents: jest.fn() };
    const gen = new QuestionGeneratorService(ai as never, config);
    const res = await gen.generate({
      tier: { model: config.strongModel, price: config.strongPrice, effort: 'high' },
      mode: 'DISTINCT',
      plan: [{ index: 1, type: 'MCQ', difficulty: 'MEDIUM', marks: 1 }],
      chunks: [chunk(0)],
      language: 'AUTO',
      avoid: [],
    });
    expect(res.error).toBe('MODEL_NOT_ALLOWED');
    expect(ai.completeStructured).not.toHaveBeenCalled();
  });

  it('SOL_FIRST replaces on sol and has nowhere else to go', async () => {
    const t = setup();
    t.respond((req, n) =>
      result(
        req,
        answer(req, (i) => (n < 2 && i === 0 ? { chunkIndex: 99 } : {})),
      ),
    );
    await t.run.run({
      importId: 'imp',
      asked: spec({ MCQ: 4, TRUE_FALSE: 0, SHORT_ANSWER: 0 }),
      chunks: [chunk(0, 800)],
      profile: t.config.generationProfileOf('SOL_FIRST'),
      budgetMillicents: 25_000,
    });
    expect(t.calls.every((c) => c.tier.model === 'gpt-6-sol')).toBe(true);
  });

  it('LUNA_FIRST hands one slot to sol only after it failed its checks twice on luna', async () => {
    const t = setup();
    // Slot 1 comes back with two correct options every time luna writes it.
    t.respond((req) =>
      result(
        req,
        answer(req, (i) =>
          req.tier.model === 'gpt-6-luna' && (req.plan.length === 1 || i === 1)
            ? {
                options: [
                  { label: 'A', text: 'Mitochondria', correct: true },
                  { label: 'B', text: 'Ribosome', correct: true },
                  { label: 'C', text: 'Nucleus', correct: false },
                ],
              }
            : {},
        ),
      ),
    );
    const out = await t.run.run({
      importId: 'imp',
      asked: spec({ MCQ: 4, TRUE_FALSE: 0, SHORT_ANSWER: 0 }),
      chunks: [chunk(0, 800)],
      profile: t.config.generationProfileOf('LUNA_FIRST'),
      budgetMillicents: 25_000,
    });
    expect(t.calls.map((c) => [c.tier.model, c.plan.length])).toEqual([
      ['gpt-6-luna', 4],
      ['gpt-6-luna', 1],
      ['gpt-6-sol', 1],
    ]);
    expect(out.report.complete).toBe(true);
    expect(out.report.callsByModel).toEqual({ 'gpt-6-luna': 2, 'gpt-6-sol': 1 });
  });

  it('LUNA_FIRST does not escalate for duplicates or missing questions', async () => {
    const t = setup();
    t.respond((req) =>
      result(
        req,
        answer(req, () => ({ text: TOPICS[0] })),
      ),
    );
    await t.run.run({
      importId: 'imp',
      asked: spec({ MCQ: 4, TRUE_FALSE: 0, SHORT_ANSWER: 0 }),
      chunks: [chunk(0, 800)],
      profile: t.config.generationProfileOf('LUNA_FIRST'),
      budgetMillicents: 25_000,
    });
    expect(t.calls.every((c) => c.tier.model === 'gpt-6-luna')).toBe(true);
  });
});

describe('thin material — the import that produced 18 of 20', () => {
  // cmufhs5jl0014966dyg0tdvvn: two photographed pages, 605 tokens between
  // them, twenty questions asked for. What the material carries is written
  // new; only the difference is written as variants.
  const thin = [chunk(0, 404), chunk(1, 201)];
  const cap = supportableQuestions(thin);

  it('asks for what it can carry, then exactly the rest, by type', async () => {
    const t = setup();
    const out = await t.run.run({
      importId: 'imp',
      asked: spec({ MCQ: 18, TRUE_FALSE: 1, SHORT_ANSWER: 1 }),
      chunks: thin,
      profile: t.config.generationProfileOf('LUNA_FIRST'),
      budgetMillicents: 10_000,
    });
    const fresh = t.calls.filter((c) => c.mode === 'DISTINCT').flatMap((c) => c.plan);
    expect(fresh).toHaveLength(cap);
    const owed = t.calls.filter((c) => c.mode === 'VARIANT').flatMap((c) => c.plan);
    expect(owed).toHaveLength(20 - cap);
    const all = [...fresh, ...owed].map((p) => p.type);
    expect(all.filter((x) => x === 'MCQ')).toHaveLength(18);
    expect(all.filter((x) => x === 'TRUE_FALSE')).toHaveLength(1);
    expect(all.filter((x) => x === 'SHORT_ANSWER')).toHaveLength(1);
    expect(out.report.accepted).toBe(20);
    expect(out.report.variants).toBe(20 - cap);
    expect(out.report.sourceSufficient).toBe(false);
  });

  it('gives each variant one question to vary, and spreads them', async () => {
    const t = setup();
    await t.run.run({
      importId: 'imp',
      asked: spec({ MCQ: 18, TRUE_FALSE: 1, SHORT_ANSWER: 1 }),
      chunks: thin,
      profile: t.config.generationProfileOf('SOL_FIRST'),
      budgetMillicents: 25_000,
    });
    const variantCalls = t.calls.filter((c) => c.mode === 'VARIANT');
    const varied: string[] = variantCalls.flatMap((c) =>
      c.variantOf!.map((k) => c.source![k - 1].text),
    );
    expect(varied).toHaveLength(20 - cap);
    // No question is varied more than its share.
    const counts = new Map<string, number>();
    for (const v of varied) counts.set(v, (counts.get(v) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(Math.ceil((20 - cap) / cap));
    // Two calls at once are not handed the same question to vary.
    const [a, b] = variantCalls;
    const overlap = a.source!.filter((x) => b.source!.some((y) => y.text === x.text));
    expect(overlap.length).toBeLessThan(a.source!.length);
  });

  it('with variants off, reports the shortfall as the material and spends nothing on it', async () => {
    const t = setup({ generationVariantRounds: 0 } as never);
    const out = await t.run.run({
      importId: 'imp',
      asked: spec({ MCQ: 18, TRUE_FALSE: 1, SHORT_ANSWER: 1 }),
      chunks: thin,
      profile: t.config.generationProfileOf('SOL_FIRST'),
      budgetMillicents: 25_000,
    });
    expect(t.calls).toHaveLength(1);
    expect(out.report.stopReason).toBe('MATERIAL');
    expect(out.report.accepted).toBe(cap);
  });
});

describe('two pages of different kinds — the import that produced 18 of 20, again', () => {
  // cmufjoy7t001414et7nu9v3dz: an arithmetic page of seven problems (400
  // tokens) and a revision sheet of fourteen one-line facts (231 tokens).
  // Counted by tokens that was nine questions; the first batch was handed
  // the arithmetic page alone and asked for eight, and the sheet was asked
  // for one. Every question on the final exam came from the arithmetic page.
  const problems = Array.from(
    { length: 7 },
    (_, i) =>
      `(${i + 1}) ${TOPICS[i]} Explain the mitochondria, chloroplasts and respiration steps carefully.`,
  ).join('\n');
  const facts = Array.from(
    { length: 14 },
    (_, i) => `- ${TOPICS[i + 5]} The cell membrane controls diffusion here.`,
  ).join('\n');
  const pages: SourceChunk[] = [
    { index: 0, text: problems, sourceFile: 'exam2.jpg', page: 1, tokensApprox: 400 },
    { index: 1, text: facts, sourceFile: 'images.jpg', page: 2, tokensApprox: 231 },
  ];

  it('sees that the two pages carry the exam, and writes no variants', async () => {
    const t = setup();
    const out = await t.run.run({
      importId: 'imp',
      asked: spec({ MCQ: 14, TRUE_FALSE: 3, SHORT_ANSWER: 3 }),
      chunks: pages,
      profile: t.config.generationProfileOf('SOL_FIRST'),
      budgetMillicents: 25_000,
    });
    expect(out.report.sourceCapacity).toBe(21);
    expect(out.report.sourceSufficient).toBe(true);
    expect(t.calls.every((c) => c.mode === 'DISTINCT')).toBe(true);
    expect(out.report.variants).toBe(0);
    expect(out.report.complete).toBe(true);
  });

  it('asks each page for its share, in even batches', async () => {
    const t = setup();
    await t.run.run({
      importId: 'imp',
      asked: spec({ MCQ: 14, TRUE_FALSE: 3, SHORT_ANSWER: 3 }),
      chunks: pages,
      profile: t.config.generationProfileOf('SOL_FIRST'),
      budgetMillicents: 25_000,
    });
    const targets = t.calls.flatMap((c) => c.targets ?? []);
    expect(targets.filter((x) => x === 0)).toHaveLength(7);
    expect(targets.filter((x) => x === 1)).toHaveLength(13);
    // 20 slots in three calls are 7 + 7 + 6, not 8 + 8 + 4.
    expect(t.calls.map((c) => c.plan.length).sort()).toEqual([6, 7, 7]);
    // Each call is handed only the pages its lines name.
    for (const c of t.calls) {
      const named = new Set(c.targets);
      expect(c.chunks.every((ch) => named.has(ch.index))).toBe(true);
    }
    // And the mix of types reaches both pages.
    const typesOn = (chunkIndex: number) =>
      new Set(
        t.calls.flatMap((c) =>
          c.plan.filter((_, i) => c.targets![i] === chunkIndex).map((p) => p.type),
        ),
      );
    expect(typesOn(1).size).toBeGreaterThan(1);
  });

  it('logs what a duplicate repeated, and how alike the two scored', async () => {
    const t = setup({ generationRounds: 1 } as never);
    t.respond((req, n) =>
      result(
        req,
        answer(req, (i) => (n === 1 && i === 0 ? { text: TOPICS[0] } : {})),
      ),
    );
    const out = await t.run.run({
      importId: 'imp',
      asked: spec({ MCQ: 14, TRUE_FALSE: 3, SHORT_ANSWER: 3 }),
      chunks: pages,
      profile: t.config.generationProfileOf('SOL_FIRST'),
      budgetMillicents: 25_000,
    });
    const samples = out.report.callLog.flatMap((c) => c.rejectedSamples);
    const dup = samples.find((x) => x.reason === 'DUPLICATE');
    expect(dup?.text).toBe(TOPICS[0]);
    expect(dup?.duplicateOf).toBe(TOPICS[0]);
    expect(dup?.score).toBe(1);
  });
});

describe('a billed failure is still a cost', () => {
  it('counts a truncated answer the provider charged for', async () => {
    const config = new PaperImportConfig();
    const ai = {
      completeStructured: jest.fn().mockRejectedValue(
        new AiJobError('AI response was cut off', 'RETRYABLE', {
          inputTokens: 3000,
          outputTokens: 5600,
        }),
      ),
      costMillicents: (i: number, o: number, p: { inPerMToken: number; outPerMToken: number }) =>
        Math.round(((i / 1e6) * p.inPerMToken + (o / 1e6) * p.outPerMToken) * 1000),
    };
    const gen = new QuestionGeneratorService(ai as never, config);
    const res = await gen.generate({
      tier: config.generationProfileOf('SOL_FIRST').primary,
      mode: 'DISTINCT',
      plan: [{ index: 1, type: 'MCQ', difficulty: 'MEDIUM', marks: 1 }],
      chunks: [chunk(0)],
      language: 'AUTO',
      avoid: [],
    });
    expect(res.error).toMatch(/cut off/);
    expect(res.millicents).toBe(6200);
    expect(res.usageUnknown).toBe(false);
  });
});

describe('one learning point per question', () => {
  // The revision sheet of cmufjoy7t001414et7nu9v3dz, fourteen one-line facts.
  const SHEET = [
    '← عدد حبس المسلمين ثلاثة آلاف مقاتل',
    '← عدد جيش القساسة وحلفائهم الروم مائتى ألف مقاتل',
    '← استمر القتال بينهما ستة أيام',
    '- أسر خالد بن الوليد بعد صلح الحديبية عام (٦) هـ',
    '- سورة الجن عدد آياتها (٢٨) آية - سورة مكية.',
    '- عند نطق الميم المشددة نغن بمقدار حركتين',
    '- تم صلح الحديبية في السنة السادسة من الهجرة',
    '- تم نص الصلح على وقف الحرب لمدة عشر سنوات',
    '- لم تنقض قريش صلح الحديبية بعد عامين من عقده في السنة الثامنة من الهجرة',
    '- ظل نوح عليه السلام يدعو قومه لمدة ٩٥٠ سنة.',
    '- الصاع يساوي أربع حفنات من الطعام باليدين',
    '- مقدار المد من الطعام من كيلوجرام تقريبا.',
    '- فتح مكة في السنة الثامنة للهجرة في شهر رمضان',
    '- توفي خالد بن الوليد من الشام وعمره حوالي ٦٠ عاماً',
  ].join('\n');
  const sheet: SourceChunk = {
    index: 0,
    text: SHEET,
    sourceFile: 'images.jpg',
    page: 1,
    tokensApprox: 231,
  };

  it('gives two calls over one revision sheet different statements, and says which in the prompt', async () => {
    const t = setup();
    await t.run.run({
      importId: 'imp',
      asked: spec({ MCQ: 8, TRUE_FALSE: 3, SHORT_ANSWER: 3 }),
      chunks: [sheet],
      profile: t.config.generationProfileOf('LUNA_FIRST'),
      budgetMillicents: 10_000,
    });
    // The first round: calls not repeating a slot that was rejected before.
    const first = t.calls.filter((c) => c.mode === 'DISTINCT' && !c.reason);
    expect(first.length).toBeGreaterThanOrEqual(2);
    const lines = first.flatMap((c) => c.lines ?? []);
    // Fourteen questions, fourteen statements: none tested twice.
    expect(lines).toHaveLength(14);
    expect(new Set(lines).size).toBe(14);
    const prompt = (t.generator as unknown as { prompt(r: GenerationRequest): string }).prompt(
      first[0],
    );
    expect(prompt).toContain('L1. ← عدد حبس المسلمين');
    expect(prompt).toMatch(/chunk=0 line=L\d+/);
  });

  it('turns away a new question that tests a fact already on the exam', async () => {
    const t = setup({ generationRounds: 1 } as never);
    t.respond((req, n) =>
      result(
        req,
        req.plan.map((p, i) => ({
          ...q({ type: 'MCQ', difficulty: p.difficulty }),
          chunkIndex: 0,
          ...(n === 0 && i === 0
            ? {
                type: 'TRUE_FALSE' as const,
                text: 'ظل نوح عليه السلام يدعو قومه لمدة ٩٥٠ سنة.',
                options: [
                  { label: 'أ', text: 'صواب', correct: true },
                  { label: 'ب', text: 'خطأ', correct: false },
                ],
              }
            : n === 0 && i === 1
              ? {
                  text: 'كم سنة ظل نوح عليه السلام يدعو قومه بحسب المادة؟',
                  options: [
                    { label: 'أ', text: '٩٥٠ سنة', correct: true },
                    { label: 'ب', text: '٩٠٠ سنة', correct: false },
                    { label: 'ج', text: '١٠٠٠ سنة', correct: false },
                  ],
                }
              : {
                  text: `ما الذي يذكره السطر ${i + 1} من ورقة المراجعة عن الصاع والمد وفتح مكة؟ ${i}`,
                }),
        })),
      ),
    );
    const out = await t.run.run({
      importId: 'imp',
      asked: spec({ MCQ: 3, TRUE_FALSE: 1, SHORT_ANSWER: 0 }),
      chunks: [sheet],
      profile: t.config.generationProfileOf('LUNA_FIRST'),
      budgetMillicents: 10_000,
    });
    expect(out.report.rejections.SAME_POINT).toBe(1);
    expect(out.questions.filter((x) => /نوح/.test(x.text))).toHaveLength(1);
  });

  it('turns away a problem with a given the material does not state', async () => {
    const page: SourceChunk = {
      index: 0,
      text: '(٥) تاجر ملابس يضع على كل بنطلون ورقة مكتوب عليها الثمن الذي يبيع به ولكنه يتنازل لزبائنه عن ٢٥٪ من ذلك الثمن المكتوب ومع ذلك يكسب ٥٪ من ثمن الشراء.',
      sourceFile: 'exam2.jpg',
      page: 1,
      tokensApprox: 120,
    };
    const t = setup({ generationRounds: 1 } as never);
    t.respond((req) =>
      result(
        req,
        req.plan.map((p) => ({
          ...q({ type: 'MCQ', difficulty: p.difficulty }),
          chunkIndex: 0,
          text: 'يتنازل تاجر الملابس عن ٢٥٪ من الثمن المكتوب ويكسب ٥٪ من ثمن الشراء. إذا كان ثمن الشراء ١٠٠ جنيه، فما الثمن المكتوب على البنطلون؟',
        })),
      ),
    );
    const out = await t.run.run({
      importId: 'imp',
      asked: spec({ MCQ: 1, TRUE_FALSE: 0, SHORT_ANSWER: 0 }),
      chunks: [page],
      profile: t.config.generationProfileOf('LUNA_FIRST'),
      budgetMillicents: 10_000,
    });
    expect(out.report.rejections.UNSUPPORTED_NUMBER).toBe(1);
    expect(out.report.accepted).toBe(0);
  });
});

describe('statements are a hint for spreading questions, not a rule', () => {
  const ask = (t: ReturnType<typeof setup>, chunks: SourceChunk[], types: Record<string, number>) =>
    t.run.run({
      importId: 'imp',
      asked: spec(types as never),
      chunks,
      profile: t.config.generationProfileOf('LUNA_FIRST'),
      budgetMillicents: 10_000,
    });
  const mcqOf = (text: string, key: string, chunkIndex = 0) => ({
    ...q({ type: 'MCQ' }),
    text,
    chunkIndex,
    options: [key, 'أ', 'ب', 'ج'].map((t, i) => ({ label: String(i), text: t, correct: i === 0 })),
  });

  it('accepts a grounded question written from another statement than the one named', async () => {
    // One problem runs over two lines; the second line has nothing of its own
    // to ask. The model writes the second question from the third statement.
    const page: SourceChunk = {
      index: 0,
      text:
        '(٤) سبيكتان من الذهب الأولى تحتوي على ذهب خالص مقداره ٨١٪ من وزنها\n' +
        'والثانية تحتوي على ذهب خالص مقداره ٩٦٪ من وزنها فإذا خلط منهما مقداران بنسبة ٢ : ٣\n' +
        '(٥) تاجر ملابس يتنازل لزبائنه عن ٢٥٪ من الثمن المكتوب ومع ذلك يكسب ٥٪ من ثمن الشراء',
      sourceFile: 'exam2.jpg',
      page: 1,
      tokensApprox: 90,
    };
    const t = setup({ generationRounds: 1 } as never);
    t.respond((req) =>
      result(req, [
        mcqOf(
          'سبيكتان من الذهب نسبة الذهب الخالص فيهما ٨١٪ و٩٦٪ خلط منهما مقداران بنسبة ٢ : ٣. ما نسبة الذهب الخالص في الخليط؟',
          '٩٠٪',
        ),
        mcqOf(
          'يتنازل تاجر ملابس عن ٢٥٪ من الثمن المكتوب ويكسب ٥٪ من ثمن الشراء. ما نسبة الثمن المكتوب إلى ثمن الشراء؟',
          '١٤٠٪',
        ),
      ]),
    );
    const out = await ask(t, [page], { MCQ: 2, TRUE_FALSE: 0, SHORT_ANSWER: 0 });
    expect(t.calls[0].lines).toEqual([1, 2]);
    expect(out.report.accepted).toBe(2);
    expect(out.report.rejections).toEqual({});
  });

  it('lets two questions test different facts of one statement', async () => {
    const line: SourceChunk = {
      index: 0,
      text: '- سورة الجن عدد آياتها (٢٨) آية - سورة مكية.',
      sourceFile: 'images.jpg',
      page: 1,
      tokensApprox: 150, // two questions by length, one statement by lines
    };
    const t = setup({ generationRounds: 1 } as never);
    t.respond((req) =>
      result(req, [
        mcqOf('كم عدد آيات سورة الجن؟', '٢٨ آية'),
        {
          ...q({ type: 'TRUE_FALSE' }),
          text: 'سورة الجن سورة مكية.',
          chunkIndex: 0,
          options: [
            { label: 'أ', text: 'صواب', correct: true },
            { label: 'ب', text: 'خطأ', correct: false },
          ],
        },
      ]),
    );
    const out = await ask(t, [line], { MCQ: 1, TRUE_FALSE: 1, SHORT_ANSWER: 0 });
    expect(t.calls[0].lines).toEqual([1, 1]);
    expect(out.report.accepted).toBe(2);
  });

  it('accepts what a cut-off statement does say, and nothing it does not', async () => {
    const cut: SourceChunk = {
      index: 0,
      text: '(٥) تاجر ملابس يضع على كل بنطلون ورقة مكتوب عليها الثمن الذي يبيع به ولكنه يتنازل لزبائنه عن ٢٥٪ من ذلك الثمن المكتوب ومع ذلك يكسب ٥٪ من ثمن الشراء. فإذا كان ٢٨٠ قرشاً',
      sourceFile: 'exam2.jpg',
      page: 1,
      tokensApprox: 150,
    };
    const t = setup({ generationRounds: 1 } as never);
    t.respond((req) =>
      result(req, [
        mcqOf(
          'تاجر ملابس يتنازل عن ٢٥٪ من الثمن المكتوب على البنطلون ويكسب ٥٪ من ثمن الشراء. إذا كان الثمن المكتوب ٢٨٠ قرشًا، فما ثمن الشراء؟',
          '٢٠٠ قرش',
        ),
        mcqOf(
          'تاجر ملابس يتنازل عن ٢٥٪ من الثمن المكتوب على البنطلون ويكسب ٥٪ من ثمن الشراء. إذا كان ثمن الشراء ١٠٠ جنيه، فما الثمن المكتوب؟',
          '١٤٠ جنيهًا',
        ),
      ]),
    );
    const out = await ask(t, [cut], { MCQ: 2, TRUE_FALSE: 0, SHORT_ANSWER: 0 });
    expect(out.report.accepted).toBe(1);
    expect(out.report.rejections.UNSUPPORTED_NUMBER).toBe(1);
    expect(out.questions[0].text).toContain('٢٨٠');
  });

  it('on a short sheet, names each statement once and asks the rest as variants, never as new lines', async () => {
    const short: SourceChunk = {
      index: 0,
      text:
        '- ظل نوح عليه السلام يدعو قومه لمدة ٩٥٠ سنة.\n' +
        '- الصاع يساوي أربع حفنات من الطعام باليدين\n' +
        '- فتح مكة في السنة الثامنة للهجرة في شهر رمضان',
      sourceFile: 'images.jpg',
      page: 1,
      tokensApprox: 60,
    };
    const t = setup();
    const out = await ask(t, [short], { MCQ: 8, TRUE_FALSE: 0, SHORT_ANSWER: 0 });
    const first = t.calls.find((c) => c.mode === 'DISTINCT')!;
    expect(first.plan).toHaveLength(3);
    expect(first.lines).toEqual([1, 2, 3]);
    expect(t.calls.filter((c) => c.mode === 'VARIANT').every((c) => !c.lines)).toBe(true);
    expect(out.report.sourceSufficient).toBe(false);
  });
});

describe('DUPLICATE before SAME_POINT', () => {
  // A question that is another reworded is a DUPLICATE, and only that; a
  // different question on the same fact is SAME_POINT. The run checks
  // DUPLICATE first and never reports one pair as both.
  it('reports a reworded question as a duplicate, not as the same point', async () => {
    const sheet: SourceChunk = {
      index: 0,
      text: '- ظل نوح عليه السلام يدعو قومه لمدة ٩٥٠ سنة.\n- الصاع يساوي أربع حفنات من الطعام باليدين',
      sourceFile: 'images.jpg',
      page: 1,
      tokensApprox: 150,
    };
    const noah = (text: string) => ({
      ...q({ type: 'MCQ' }),
      text,
      chunkIndex: 0,
      options: ['٩٥٠ سنة', '٩٠٠ سنة', '١٠٠٠ سنة'].map((t, i) => ({
        label: String(i),
        text: t,
        correct: i === 0,
      })),
    });
    const t = setup({ generationRounds: 1 } as never);
    t.respond((req) =>
      result(req, [
        noah('كم سنة ظل نوح عليه السلام يدعو قومه؟'),
        noah('كم سنة ظل نوح عليه السلام يدعو قومه بحسب المادة؟'),
      ]),
    );
    const out = await t.run.run({
      importId: 'imp',
      asked: spec({ MCQ: 2, TRUE_FALSE: 0, SHORT_ANSWER: 0 }),
      chunks: [sheet],
      profile: t.config.generationProfileOf('LUNA_FIRST'),
      budgetMillicents: 10_000,
    });
    expect(out.report.rejections).toEqual({ DUPLICATE: 1 });
  });
});
