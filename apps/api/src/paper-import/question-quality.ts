import { DraftQuestion, looksLikePlaceholder } from './extraction.schema';
import { PlannedQuestion, SpecQuestionType } from './exam-spec';
import { foldArabic, keywords } from './source-text';

/**
 * Whether a generated exam is fit to show a teacher.
 *
 * Deterministic on purpose. An AI call that asks a model to mark its own
 * homework costs as much as the generation did and agrees with itself, and
 * every check below is a fact about the text rather than a judgement about it:
 * are there the right number of questions, of the right kinds, does every
 * multiple choice have options and an answer, did two questions come out the
 * same, is anything an apology rather than a question.
 *
 * The one thing no code here can check is whether a question is *good*. That
 * is what the review screen is for.
 */

export type QualityProblem =
  | 'COUNT_SHORT'
  | 'TYPE_MISMATCH'
  | 'EMPTY_TEXT'
  | 'PLACEHOLDER'
  | 'NO_OPTIONS'
  | 'NO_KEY'
  | 'DUPLICATE'
  | 'UNGROUNDED';

export interface QualityFinding {
  problem: QualityProblem;
  /** Which question, by its position in the draft. Absent for exam-wide ones. */
  number?: number;
  params?: Record<string, string | number>;
}

/** Two questions this alike are the same question asked twice. Tuned on real
 *  generated batches: below this, genuinely different questions about the same
 *  paragraph start being flagged, which is worse than missing a duplicate. */
export const DUPLICATE_THRESHOLD = 0.75;

/** A multiple choice question needs somewhere to choose from. */
const MIN_OPTIONS = 2;
/** Shorter than this is a fragment, not a question. */
const MIN_QUESTION_CHARS = 12;

/**
 * How alike two questions are, from 0 to 1.
 *
 * Word overlap over the smaller question, on folded Arabic so that spelling
 * variants do not hide a duplicate. Not an embedding: there is no vector store
 * here, and two questions written from the same paragraph in the same call
 * repeat each other's words when they repeat each other — which is the case
 * this needs to catch.
 */
export function similarity(a: string, b: string): number {
  const left = keywords(a);
  const right = keywords(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  const overlap = shared / Math.min(left.size, right.size);
  // Identical text after folding is a duplicate whatever the word count says
  // — a two-word question has too few keywords for the ratio to be stable.
  if (foldArabic(a).trim().toLowerCase() === foldArabic(b).trim().toLowerCase()) return 1;
  return overlap;
}

/** Pairs of questions that are really one question. Returns the *later* one of
 *  each pair, which is the one worth rewriting. */
export function findDuplicates(
  questions: Pick<DraftQuestion, 'id' | 'text'>[],
  threshold = DUPLICATE_THRESHOLD,
): { id: string; duplicateOfId: string; score: number }[] {
  const out: { id: string; duplicateOfId: string; score: number }[] = [];
  for (let i = 0; i < questions.length; i++) {
    for (let j = 0; j < i; j++) {
      const score = similarity(questions[i].text, questions[j].text);
      if (score >= threshold) {
        out.push({ id: questions[i].id, duplicateOfId: questions[j].id, score });
        break; // one report per question is enough to act on
      }
    }
  }
  return out;
}

export interface GradedQuestion extends DraftQuestion {
  /** Which chunk of the uploaded material this was written from. */
  chunkIndex?: number | null;
}

/**
 * Everything wrong with a generated exam, as codes the screen words in Arabic.
 *
 * `plan` is what the teacher asked for; without it only the per-question
 * checks run, which is what the paper path needs.
 */
export function gradeQuestions(
  questions: GradedQuestion[],
  plan?: PlannedQuestion[],
  opts: { requireGrounding?: boolean } = {},
): QualityFinding[] {
  const findings: QualityFinding[] = [];

  if (plan?.length) {
    if (questions.length < plan.length) {
      findings.push({
        problem: 'COUNT_SHORT',
        params: { got: questions.length, wanted: plan.length },
      });
    }
    const wanted = countTypes(plan.map((p) => p.type));
    const got = countTypes(questions.map((q) => q.type as SpecQuestionType));
    for (const type of Object.keys(wanted) as SpecQuestionType[]) {
      if ((got[type] ?? 0) < (wanted[type] ?? 0)) {
        findings.push({
          problem: 'TYPE_MISMATCH',
          params: { type, got: got[type] ?? 0, wanted: wanted[type] ?? 0 },
        });
      }
    }
  }

  questions.forEach((q, i) => {
    const number = q.number || i + 1;
    const text = (q.text ?? '').trim();
    if (text.length < MIN_QUESTION_CHARS) {
      findings.push({ problem: 'EMPTY_TEXT', number });
      return;
    }
    // The same check the paper path learned the hard way: a model that cannot
    // do the job sometimes writes an apology into the field instead of saying
    // so, and it passes every structural test.
    if (looksLikePlaceholder(text)) {
      findings.push({ problem: 'PLACEHOLDER', number });
      return;
    }
    if (q.type === 'MCQ' || q.type === 'TRUE_FALSE') {
      const options = (q.options ?? []).filter((o) => (o.text ?? '').trim());
      if (options.length < MIN_OPTIONS) {
        findings.push({ problem: 'NO_OPTIONS', number });
      } else if (!options.some((o) => o.correct)) {
        // Generated questions must carry their key — unlike a scanned paper,
        // where the teacher usually has to supply it.
        findings.push({ problem: 'NO_KEY', number });
      }
    }
    if (q.type === 'SHORT_ANSWER' && !(q.modelAnswer ?? '').trim()) {
      findings.push({ problem: 'NO_KEY', number });
    }
    if (opts.requireGrounding && (q.chunkIndex == null || q.chunkIndex < 0)) {
      findings.push({ problem: 'UNGROUNDED', number });
    }
  });

  for (const { id } of findDuplicates(questions)) {
    const q = questions.find((x) => x.id === id);
    findings.push({ problem: 'DUPLICATE', number: q?.number });
  }

  return findings;
}

function countTypes(types: SpecQuestionType[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of types) out[t] = (out[t] ?? 0) + 1;
  return out;
}

/** The questions a finding points at, so only those are rewritten. Exam-wide
 *  findings (a short count, a missing type) point at nothing and are answered
 *  by generating more, not by rewriting one. */
export function questionsNeedingWork(
  questions: GradedQuestion[],
  findings: QualityFinding[],
): GradedQuestion[] {
  const numbers = new Set(findings.map((f) => f.number).filter((n): n is number => n != null));
  return questions.filter((q, i) => numbers.has(q.number || i + 1));
}
