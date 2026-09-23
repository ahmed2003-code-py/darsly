import {
  apportion,
  defaultSpec,
  normalizeSpec,
  planQuestions,
  scaleSpec,
  specFromQuestions,
  specProblems,
} from './exam-spec';
import { MAX_QUESTIONS_PER_CHUNK, supportableQuestions } from './source-text';

/**
 * Turning "20 questions, mixed difficulty, mostly multiple choice" into a list
 * of twenty questions to write.
 *
 * All arithmetic, and it happens before a single token is spent — which is
 * what lets a batch be retried without re-deciding anything and lets the
 * result be checked against the request rather than against a feeling.
 */
describe('planning an exam from what the teacher asked for', () => {
  it('splits a total by percentages without losing or inventing a question', () => {
    // The obvious implementation rounds each share and hands back 19 or 21.
    expect(apportion(20, { EASY: 30, MEDIUM: 50, HARD: 20 })).toEqual({
      EASY: 6,
      MEDIUM: 10,
      HARD: 4,
    });
    const awkward = apportion(7, { EASY: 33, MEDIUM: 33, HARD: 34 });
    expect(Object.values(awkward).reduce((a, b) => a + b, 0)).toBe(7);
  });

  it('plans exactly as many questions as were asked for', () => {
    const spec = {
      ...defaultSpec(),
      questionCount: 20,
      types: { MCQ: 12, TRUE_FALSE: 4, SHORT_ANSWER: 4 },
    };
    expect(planQuestions(spec)).toHaveLength(20);
  });

  it('plans the kinds the teacher chose, in the numbers they chose', () => {
    const spec = {
      ...defaultSpec(),
      questionCount: 20,
      types: { MCQ: 12, TRUE_FALSE: 4, SHORT_ANSWER: 4 },
    };
    const plan = planQuestions(spec);
    const count = (t: string) => plan.filter((p) => p.type === t).length;
    expect(count('MCQ')).toBe(12);
    expect(count('TRUE_FALSE')).toBe(4);
    expect(count('SHORT_ANSWER')).toBe(4);
  });

  it('spreads difficulty inside each kind, not across the paper', () => {
    // Otherwise "mixed" gives twelve easy multiple-choice and four hard essays.
    const spec = {
      ...defaultSpec(),
      questionCount: 20,
      difficulty: 'MIXED' as const,
      types: { MCQ: 10, TRUE_FALSE: 5, SHORT_ANSWER: 5 },
    };
    const plan = planQuestions(spec);
    for (const type of ['MCQ', 'TRUE_FALSE', 'SHORT_ANSWER']) {
      const kinds = new Set(plan.filter((p) => p.type === type).map((p) => p.difficulty));
      expect(kinds.size).toBeGreaterThan(1);
    }
  });

  it('makes every question the chosen difficulty when one was chosen', () => {
    const spec = {
      ...defaultSpec(),
      questionCount: 6,
      difficulty: 'HARD' as const,
      types: { MCQ: 6, TRUE_FALSE: 0, SHORT_ANSWER: 0 },
    };
    expect(planQuestions(spec).every((p) => p.difficulty === 'HARD')).toBe(true);
  });

  it('interleaves the kinds so the paper does not open with fourteen of one', () => {
    const spec = {
      ...defaultSpec(),
      questionCount: 6,
      types: { MCQ: 3, TRUE_FALSE: 3, SHORT_ANSWER: 0 },
    };
    const types = planQuestions(spec).map((p) => p.type);
    expect(types.slice(0, 2)).toEqual(['MCQ', 'TRUE_FALSE']);
  });

  it('weights a written answer more than a tick-box when the teacher has not said', () => {
    const spec = {
      ...defaultSpec(),
      questionCount: 2,
      types: { MCQ: 1, TRUE_FALSE: 0, SHORT_ANSWER: 1 },
    };
    const plan = planQuestions(spec);
    const mcq = plan.find((p) => p.type === 'MCQ')!;
    const written = plan.find((p) => p.type === 'SHORT_ANSWER')!;
    expect(written.marks).toBeGreaterThan(mcq.marks);
  });

  it('honours one mark per question when the teacher sets one', () => {
    const spec = {
      ...defaultSpec(),
      questionCount: 2,
      marksPerQuestion: 5,
      types: { MCQ: 1, TRUE_FALSE: 0, SHORT_ANSWER: 1 },
    };
    expect(planQuestions(spec).every((p) => p.marks === 5)).toBe(true);
  });

  it('numbers the plan from one, consecutively', () => {
    const spec = {
      ...defaultSpec(),
      questionCount: 5,
      types: { MCQ: 5, TRUE_FALSE: 0, SHORT_ANSWER: 0 },
    };
    expect(planQuestions(spec).map((p) => p.index)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('refusing a request that could not become an exam', () => {
  it('accepts a sound spec', () => {
    expect(specProblems(defaultSpec())).toEqual([]);
  });

  it('refuses a type breakdown that does not add up to the total', () => {
    const spec = {
      ...defaultSpec(),
      questionCount: 20,
      types: { MCQ: 5, TRUE_FALSE: 5, SHORT_ANSWER: 5 },
    };
    expect(specProblems(spec)).toContain('TYPES_MISMATCH');
  });

  it('refuses an exam of no questions at all', () => {
    const spec = {
      ...defaultSpec(),
      questionCount: 0,
      types: { MCQ: 0, TRUE_FALSE: 0, SHORT_ANSWER: 0 },
    };
    expect(specProblems(spec)).toContain('COUNT_RANGE');
  });

  it('refuses more questions than the exam engine can hold', () => {
    const spec = {
      ...defaultSpec(),
      questionCount: 500,
      types: { MCQ: 500, TRUE_FALSE: 0, SHORT_ANSWER: 0 },
    };
    expect(specProblems(spec)).toContain('COUNT_RANGE');
  });

  it('refuses a mixed difficulty that mixes nothing', () => {
    const spec = { ...defaultSpec(), mix: { EASY: 0, MEDIUM: 0, HARD: 0 } };
    expect(specProblems(spec)).toContain('MIX_EMPTY');
  });

  it('fills in what an older stored spec is missing rather than throwing', () => {
    const spec = normalizeSpec({ questionCount: 5 } as never);
    expect(spec.types).toBeDefined();
    expect(spec.mix.MEDIUM).toBeGreaterThan(0);
    expect(Array.isArray(spec.instructions)).toBe(true);
  });
});

describe('cutting an exam to the material that exists', () => {
  const base = {
    ...defaultSpec(),
    questionCount: 20,
    types: { MCQ: 10, TRUE_FALSE: 5, SHORT_ANSWER: 5 },
  };

  it('keeps the mixture the teacher asked for when it has to shrink', () => {
    // 10/5/5 becoming 10/3/0 would be a different exam. The teacher asked for
    // a mixture and a shorter exam is still that mixture.
    const scaled = scaleSpec(base, 13);
    expect(scaled.questionCount).toBe(13);
    const total = scaled.types.MCQ + scaled.types.TRUE_FALSE + scaled.types.SHORT_ANSWER;
    expect(total).toBe(13);
    expect(scaled.types.MCQ).toBeGreaterThan(scaled.types.TRUE_FALSE);
    expect(scaled.types.SHORT_ANSWER).toBeGreaterThan(0);
  });

  it('leaves a spec alone when the material can carry it', () => {
    expect(scaleSpec(base, 20)).toBe(base);
    expect(scaleSpec(base, 40)).toBe(base);
  });

  it('produces a plan of exactly the scaled size', () => {
    expect(planQuestions(scaleSpec(base, 13))).toHaveLength(13);
  });

  it('describes the exam that was actually written', () => {
    const written = [
      { type: 'MCQ' },
      { type: 'MCQ' },
      { type: 'TRUE_FALSE' },
      { type: 'SHORT_ANSWER' },
    ];
    const out = specFromQuestions(base, written);
    expect(out.questionCount).toBe(4);
    expect(out.types).toEqual({ MCQ: 2, TRUE_FALSE: 1, SHORT_ANSWER: 1 });
    // And it is a spec that would pass its own validation, so the settings
    // form opens on numbers that save.
    expect(specProblems(out)).toEqual([]);
  });
});

describe('how much exam a pile of material can carry', () => {
  const chunk = (tokens: number) => ({ tokensApprox: tokens });

  it('says a single short page cannot carry twenty questions', () => {
    // One page of ~420 tokens: six questions, not twenty.
    expect(supportableQuestions([chunk(424)])).toBeLessThan(10);
  });

  it('grows with the material', () => {
    const one = supportableQuestions([chunk(700)]);
    const ten = supportableQuestions(Array.from({ length: 10 }, () => chunk(700)));
    expect(ten).toBeGreaterThan(one * 5);
  });

  it('never lets one chunk carry an unlimited number of questions', () => {
    expect(supportableQuestions([chunk(100_000)])).toBe(MAX_QUESTIONS_PER_CHUNK);
  });

  it('is zero for no material at all, and at least one otherwise', () => {
    expect(supportableQuestions([])).toBe(0);
    expect(supportableQuestions([chunk(10)])).toBe(1);
  });
});
