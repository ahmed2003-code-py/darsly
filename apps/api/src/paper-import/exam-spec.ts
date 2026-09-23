/**
 * What the teacher asked for, and how that becomes a plan.
 *
 * The content path needs a shape before it needs a model: how many questions,
 * of which kinds, at which difficulty. Deciding that here — in plain
 * arithmetic, before anything is generated — is what lets the generator be
 * told exactly what to write, lets a batch be retried without re-deciding
 * anything, and lets the result be checked against the request rather than
 * against a vague sense that it looks about right.
 *
 * The question kinds are exactly Darsly's `QuestionType` and nothing else.
 * There is no ESSAY here: the exam engine has three types, and offering a
 * fourth on the form that silently became one of the three would be a promise
 * the exam cannot keep. A long written answer is a SHORT_ANSWER with more
 * marks and more space on the printed paper.
 */

export type SpecQuestionType = 'MCQ' | 'TRUE_FALSE' | 'SHORT_ANSWER';
export const SPEC_QUESTION_TYPES: SpecQuestionType[] = ['MCQ', 'TRUE_FALSE', 'SHORT_ANSWER'];

export type Difficulty = 'EASY' | 'MEDIUM' | 'HARD';
export type DifficultyChoice = Difficulty | 'MIXED';

/** The default spread when a teacher picks "متنوع" and nothing else. */
export const DEFAULT_MIX = { EASY: 30, MEDIUM: 50, HARD: 20 } as const;

export interface ExamSpec {
  questionCount: number;
  difficulty: DifficultyChoice;
  /** Percentages, only meaningful when difficulty is MIXED. */
  mix: { EASY: number; MEDIUM: number; HARD: number };
  /** How many of each kind. Must add up to questionCount. */
  types: Record<SpecQuestionType, number>;
  title: string;
  instructions: string[];
  /** Marks for every question, or null to let each kind carry its own weight. */
  marksPerQuestion: number | null;
  timeLimitMin: number | null;
  /** AUTO writes in the language the source material is in. */
  language: 'AUTO' | 'AR' | 'EN';
  shuffle: boolean;
  showAnswers: boolean;
}

/** One question the generator has been asked for. */
export interface PlannedQuestion {
  index: number;
  type: SpecQuestionType;
  difficulty: Difficulty;
  marks: number;
}

/** Ceilings, shared with the DTO so a spec that could not become a quiz is
 *  refused while it is still a form. */
export const SPEC_LIMITS = {
  MIN_QUESTIONS: 1,
  /** SetQuizQuestionsDto's own ceiling. */
  MAX_QUESTIONS: 200,
  MAX_MARKS: 1_000,
  MIN_TIME_MIN: 1,
  MAX_TIME_MIN: 1_440,
} as const;

/** What a kind of question is worth when the teacher has not said. Written
 *  answers are worth more because they take longer and mark harder. */
const DEFAULT_MARKS: Record<SpecQuestionType, number> = {
  MCQ: 1,
  TRUE_FALSE: 1,
  SHORT_ANSWER: 3,
};

export function defaultSpec(): ExamSpec {
  return {
    questionCount: 20,
    difficulty: 'MIXED',
    mix: { ...DEFAULT_MIX },
    types: { MCQ: 14, TRUE_FALSE: 3, SHORT_ANSWER: 3 },
    title: '',
    instructions: [],
    marksPerQuestion: null,
    timeLimitMin: 60,
    language: 'AUTO',
    shuffle: false,
    showAnswers: true,
  };
}

/**
 * Split `total` by percentages without losing or inventing one.
 *
 * Largest remainder, because the obvious way — round each share and hope —
 * gives 19 or 21 questions for a request of 20 often enough to matter, and a
 * teacher who asked for 20 questions counting 19 is a bug report.
 */
export function apportion(total: number, weights: Record<string, number>): Record<string, number> {
  const keys = Object.keys(weights);
  const sum = keys.reduce((n, k) => n + Math.max(0, weights[k]), 0);
  if (!sum || total <= 0) return Object.fromEntries(keys.map((k) => [k, 0]));

  const exact = keys.map((k) => ({ k, value: (Math.max(0, weights[k]) / sum) * total }));
  const out: Record<string, number> = {};
  let used = 0;
  for (const { k, value } of exact) {
    out[k] = Math.floor(value);
    used += out[k];
  }
  // Hand the leftovers to whoever was cheated of the most by the rounding.
  const order = [...exact].sort(
    (a, b) => b.value - Math.floor(b.value) - (a.value - Math.floor(a.value)),
  );
  for (let i = 0; used < total; i++, used++) out[order[i % order.length].k] += 1;
  return out;
}

/**
 * Turn the request into a list of questions to write.
 *
 * Difficulty is spread *within* each kind rather than across the exam as a
 * whole, so "12 multiple choice, mixed difficulty" is twelve questions of
 * varying difficulty rather than twelve easy ones and four hard essays.
 */
export function planQuestions(spec: ExamSpec): PlannedQuestion[] {
  const plan: PlannedQuestion[] = [];
  const weights =
    spec.difficulty === 'MIXED'
      ? spec.mix
      : ({ EASY: 0, MEDIUM: 0, HARD: 0, [spec.difficulty]: 100 } as Record<Difficulty, number>);

  for (const type of SPEC_QUESTION_TYPES) {
    const count = Math.max(0, Math.floor(spec.types[type] ?? 0));
    if (!count) continue;
    const byDifficulty = apportion(count, weights);
    for (const difficulty of ['EASY', 'MEDIUM', 'HARD'] as Difficulty[]) {
      for (let i = 0; i < (byDifficulty[difficulty] ?? 0); i++) {
        plan.push({
          index: 0,
          type,
          difficulty,
          marks: spec.marksPerQuestion ?? DEFAULT_MARKS[type],
        });
      }
    }
  }
  // Interleave the kinds so the paper does not open with fourteen identical
  // multiple-choice questions and close with three essays.
  const byType = new Map<SpecQuestionType, PlannedQuestion[]>();
  for (const q of plan) {
    if (!byType.has(q.type)) byType.set(q.type, []);
    byType.get(q.type)!.push(q);
  }
  const ordered: PlannedQuestion[] = [];
  // Kept in the order the exam engine lists them, so the paper reads
  // predictably: choices, then true/false, then the written ones.
  while (ordered.length < plan.length) {
    for (const type of SPEC_QUESTION_TYPES) {
      const queue = byType.get(type);
      if (queue?.length) ordered.push(queue.shift()!);
    }
  }
  return ordered.map((q, i) => ({ ...q, index: i + 1 }));
}

/** Everything wrong with a spec, as codes the screen words in Arabic. */
export type SpecProblem =
  'COUNT_RANGE' | 'TYPES_EMPTY' | 'TYPES_MISMATCH' | 'MIX_EMPTY' | 'MARKS_RANGE' | 'TIME_RANGE';

export function specProblems(spec: ExamSpec): SpecProblem[] {
  const problems: SpecProblem[] = [];
  if (
    !Number.isFinite(spec.questionCount) ||
    spec.questionCount < SPEC_LIMITS.MIN_QUESTIONS ||
    spec.questionCount > SPEC_LIMITS.MAX_QUESTIONS
  ) {
    problems.push('COUNT_RANGE');
  }
  const typeTotal = SPEC_QUESTION_TYPES.reduce((n, t) => n + Math.max(0, spec.types?.[t] ?? 0), 0);
  if (!typeTotal) problems.push('TYPES_EMPTY');
  else if (typeTotal !== spec.questionCount) problems.push('TYPES_MISMATCH');

  if (spec.difficulty === 'MIXED') {
    const mixTotal = (['EASY', 'MEDIUM', 'HARD'] as const).reduce(
      (n, k) => n + Math.max(0, spec.mix?.[k] ?? 0),
      0,
    );
    if (!mixTotal) problems.push('MIX_EMPTY');
  }
  if (
    spec.marksPerQuestion != null &&
    (spec.marksPerQuestion < 1 || spec.marksPerQuestion > SPEC_LIMITS.MAX_MARKS)
  ) {
    problems.push('MARKS_RANGE');
  }
  if (
    spec.timeLimitMin != null &&
    (spec.timeLimitMin < SPEC_LIMITS.MIN_TIME_MIN || spec.timeLimitMin > SPEC_LIMITS.MAX_TIME_MIN)
  ) {
    problems.push('TIME_RANGE');
  }
  return problems;
}

/** Fill in whatever a stored spec is missing, so a session written by an older
 *  build still generates rather than throwing. */
export function normalizeSpec(raw: Partial<ExamSpec> | null | undefined): ExamSpec {
  const base = defaultSpec();
  const spec: ExamSpec = { ...base, ...(raw ?? {}) } as ExamSpec;
  spec.mix = { ...base.mix, ...(raw?.mix ?? {}) };
  spec.types = { ...(raw?.types ?? base.types) } as Record<SpecQuestionType, number>;
  for (const t of SPEC_QUESTION_TYPES) spec.types[t] = Math.max(0, Math.floor(spec.types[t] ?? 0));
  spec.instructions = Array.isArray(spec.instructions) ? spec.instructions : [];
  return spec;
}

/**
 * The same exam, cut to the number of questions the material can carry.
 *
 * Proportional, so a request for "10 multiple choice, 5 true/false, 5 written"
 * that has to become thirteen becomes 7/3/3 rather than 10/3/0 — the teacher
 * asked for a mixture and a shorter exam is still that mixture. Largest
 * remainder again, so the parts add up to the whole exactly.
 */
export function scaleSpec(spec: ExamSpec, toCount: number): ExamSpec {
  const target = Math.max(0, Math.min(toCount, spec.questionCount));
  if (target === spec.questionCount) return spec;
  const scaled = apportion(target, spec.types as unknown as Record<string, number>);
  return {
    ...spec,
    questionCount: target,
    types: {
      MCQ: scaled.MCQ ?? 0,
      TRUE_FALSE: scaled.TRUE_FALSE ?? 0,
      SHORT_ANSWER: scaled.SHORT_ANSWER ?? 0,
    },
  };
}

/** What a spec actually asks for, counted from a produced question list. So
 *  the stored spec can be made to match what was really written. */
export function specFromQuestions(spec: ExamSpec, questions: { type: string }[]): ExamSpec {
  const types: Record<SpecQuestionType, number> = { MCQ: 0, TRUE_FALSE: 0, SHORT_ANSWER: 0 };
  for (const q of questions) {
    if (q.type === 'TRUE_FALSE') types.TRUE_FALSE += 1;
    else if (q.type === 'SHORT_ANSWER') types.SHORT_ANSWER += 1;
    else types.MCQ += 1;
  }
  return { ...spec, questionCount: questions.length, types };
}
