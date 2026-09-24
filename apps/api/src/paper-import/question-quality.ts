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
 * Words that say what kind of question this is, not what it is about. Folded
 * (see `foldArabic`) and lowercase, and only ones long enough to survive the
 * four-letter cut. "ما قيمة …" opens half of all arithmetic questions; sharing
 * it says nothing about whether two of them are the same question.
 */
const GENERIC_WORDS = new Set([
  'قيمه',
  'القيمه',
  'ناتج',
  'الناتج',
  'مقدار',
  'المقدار',
  'العدد',
  'احسب',
  'اوجد',
  'اختر',
  'اكتب',
  'اذكر',
  'وضح',
  'فسر',
  'علل',
  'اجابه',
  'الاجابه',
  'صحيح',
  'صحيحه',
  'الصحيح',
  'الصحيحه',
  'خاطئ',
  'خاطئه',
  'عباره',
  'العباره',
  'العبارات',
  'السؤال',
  'التالي',
  'التاليه',
  'الاتي',
  'الاتيه',
  'يساوي',
  'تساوي',
  'ايهما',
  'يكون',
  'تكون',
  'كانت',
  'عندما',
  'الذي',
  'التي',
  'هذه',
  'هذا',
  'معادله',
  'المعادله',
  'which',
  'what',
  'following',
  'value',
  'find',
  'calculate',
  'compute',
  'correct',
  'answer',
  'true',
  'false',
  'statement',
  'choose',
  'select',
  'given',
  'equal',
  'equals',
  'that',
  'this',
  'these',
  'those',
  'with',
  'from',
  'does',
  'when',
  'where',
]);

/** Two questions with fewer distinctive features than this cannot score a
 *  full match on the strength of one shared word. */
const MIN_EVIDENCE = 2;

/** Both questions carry numbers and fewer than half of them agree: different
 *  problems, however alike the wording. */
const NUMBERS_AGREE = 0.5;

/** At least this many numbers, and this share of them the same, plus one
 *  distinctive word in common: the same problem reworded. Arabic inflects —
 *  "ذهب خالص" and "ذهبًا خالصًا" share no word — so a paraphrase of a word
 *  problem can fall below the word threshold while its numbers match exactly. */
const SAME_PROBLEM_NUMBERS = 3;
const SAME_PROBLEM_AGREE = 0.75;

/** Operators that make a run of tokens a mathematical expression. */
const OPERATOR = /^[+\-×÷/=^²³√<>≤≥%:]$/;

/** Arabic-Indic and Persian digits to ASCII, one spelling of each operator. */
function normaliseMath(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.')
    .replace(/٪/g, '%')
    .replace(/[−–—]/g, '-')
    .replace(/[*✕]/g, '×');
}

/**
 * What a question is about, as a set of features: its distinctive words, every
 * number in it whatever its length, its acronyms, and each mathematical
 * expression written as one token ("ك=√6÷(2-√6)"). A short arithmetic question
 * is mostly numbers and symbols, which a word list alone cannot see — so to a
 * word list two unrelated ones look like the same question.
 */
function features(text: string): {
  all: Set<string>;
  numbers: Set<string>;
  words: Set<string>;
} {
  const all = new Set<string>();
  const numbers = new Set<string>();
  const words = new Set<string>();
  for (const acronym of (text ?? '').match(/\b[A-Z]{2,}\b/g) ?? []) all.add(`@${acronym}`);
  const folded = normaliseMath(foldArabic(text ?? '')).toLowerCase();

  for (const n of folded.match(/\d+(?:\.\d+)?/g) ?? []) {
    numbers.add(n);
    all.add(`#${n}`);
  }
  for (const w of folded.split(/[^\p{L}\p{N}]+/u)) {
    if (w.length >= 4 && !/\d/.test(w) && !GENERIC_WORDS.has(w)) {
      words.add(w);
      all.add(w);
    }
  }

  // Expressions: maximal runs of numbers, single-letter variables, operators
  // and brackets, kept only when an operator joins two operands or more. "81%"
  // alone is a number, already counted; counting it twice would let unit signs
  // outweigh the words of a paraphrase.
  const tokens = folded.match(/\d+(?:\.\d+)?|\p{L}+|[^\s\p{L}\p{N}]/gu) ?? [];
  let run: string[] = [];
  const flush = () => {
    const expr = run.join('').replace(/^[=:+×÷/]+|[=:+\-×÷/]+$/g, '');
    const operands = run.filter((t) => /^\d/.test(t) || /^\p{L}$/u.test(t)).length;
    if (run.some((t) => OPERATOR.test(t)) && operands >= 2) all.add(`=${expr}`);
    run = [];
  };
  for (const t of tokens) {
    const math = /^\d/.test(t) || OPERATOR.test(t) || /^[()[\]]$/.test(t) || /^\p{L}$/u.test(t);
    if (math) run.push(t);
    else flush();
  }
  flush();
  return { all, numbers, words };
}

/**
 * How alike two questions are, from 0 to 1.
 *
 * Feature overlap over the smaller question (see `features`), on folded Arabic
 * so that spelling variants do not hide a duplicate. Not an embedding: there
 * is no vector store here, and two questions written from the same paragraph
 * in the same call repeat each other's words, numbers and expressions when
 * they repeat each other — which is the case this needs to catch.
 *
 * The overlap is divided by at least `MIN_EVIDENCE`, so a question with one
 * distinctive word cannot be a full match for every question that shares it.
 * Two problems whose numbers mostly differ are two problems; two that share
 * nearly all of several numbers and a word of their subject are one.
 */
export function similarity(a: string, b: string): number {
  // Identical text after folding is a duplicate whatever the features say.
  if (foldArabic(a).trim().toLowerCase() === foldArabic(b).trim().toLowerCase()) return 1;
  const left = features(a);
  const right = features(b);
  if (!left.all.size || !right.all.size) return 0;
  let shared = 0;
  for (const f of left.all) if (right.all.has(f)) shared++;
  const overlap = shared / Math.max(MIN_EVIDENCE, Math.min(left.all.size, right.all.size));
  if (left.numbers.size && right.numbers.size) {
    let common = 0;
    for (const n of left.numbers) if (right.numbers.has(n)) common++;
    const agree = common / (left.numbers.size + right.numbers.size - common);
    if (agree < NUMBERS_AGREE) return Math.min(overlap, NUMBERS_AGREE);
    const sameProblem =
      common >= SAME_PROBLEM_NUMBERS &&
      agree >= SAME_PROBLEM_AGREE &&
      [...left.words].some((w) => right.words.has(w));
    if (sameProblem) return Math.max(overlap, agree);
  }
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

// ── one generated question, before it is accepted ──────────────────────────

/**
 * Why a generated question was not kept, one code per question.
 *
 * The first group is something wrong with the question itself — the only
 * kind a different model might do better on, and the only kind that counts
 * towards handing a slot to one. The second is about the material or the
 * call, and a bigger model does not fix either.
 */
export type RejectReason =
  | 'TYPE_MISMATCH'
  | 'EMPTY_TEXT'
  | 'PLACEHOLDER'
  | 'NO_OPTIONS'
  | 'BAD_OPTIONS'
  | 'NO_KEY'
  | 'MULTIPLE_KEYS'
  | 'UNGROUNDED'
  // not the question's fault:
  | 'DUPLICATE'
  | 'SURPLUS'
  | 'NOT_RETURNED'
  | 'CALL_FAILED';

const NOT_QUALITY: RejectReason[] = ['DUPLICATE', 'SURPLUS', 'NOT_RETURNED', 'CALL_FAILED'];

export function isQualityReason(reason: RejectReason): boolean {
  return !NOT_QUALITY.includes(reason);
}

/** A choice question needs this many to be one. Four are asked for. */
const MCQ_MIN_OPTIONS = 3;
const MCQ_MAX_OPTIONS = 6;

/**
 * Everything checkable about one generated question, or null when it passes.
 *
 * Stricter than `gradeQuestions`, which also has to accept scanned papers as
 * they were printed: a generated multiple choice has three to six distinct
 * options and exactly one of them correct, a true/false has exactly two, a
 * written question has a model answer, and every question names a chunk it
 * was given.
 *
 * `anchor` is the one check about content rather than form: the question and
 * its answer share at least one distinctive word with the chunk they claim to
 * come from. It cannot tell a good question from a bad one; it does catch a
 * question about something the chunk never mentions. Off when the exam is
 * written in a different language from the material, where no word would
 * match.
 */
export function questionProblem(
  q: GradedQuestion,
  opts: { chunkText?: string | null; anchor?: boolean } = {},
): RejectReason | null {
  const text = (q.text ?? '').trim();
  if (text.length < MIN_QUESTION_CHARS) return 'EMPTY_TEXT';
  if (looksLikePlaceholder(text)) return 'PLACEHOLDER';

  const options = (q.options ?? []).filter((o) => (o.text ?? '').trim());
  if (q.type === 'MCQ' || q.type === 'TRUE_FALSE') {
    const [min, max] = q.type === 'MCQ' ? [MCQ_MIN_OPTIONS, MCQ_MAX_OPTIONS] : [2, 2];
    if (options.length < Math.min(min, MIN_OPTIONS)) return 'NO_OPTIONS';
    if (options.length < min || options.length > max) return 'BAD_OPTIONS';
    const folded = options.map((o) => foldArabic(o.text).trim().toLowerCase());
    if (new Set(folded).size !== folded.length) return 'BAD_OPTIONS';
    const keys = options.filter((o) => o.correct).length;
    if (keys === 0) return 'NO_KEY';
    if (keys > 1) return 'MULTIPLE_KEYS';
  } else if (q.type === 'SHORT_ANSWER') {
    if (!(q.modelAnswer ?? '').trim()) return 'NO_KEY';
  }

  if (q.chunkIndex == null || q.chunkIndex < 0 || opts.chunkText == null) return 'UNGROUNDED';
  if (opts.anchor) {
    const answer = [
      text,
      q.modelAnswer ?? '',
      ...options.filter((o) => o.correct).map((o) => o.text),
    ].join(' ');
    const source = keywords(opts.chunkText);
    let shared = false;
    for (const word of keywords(answer)) {
      if (source.has(word)) {
        shared = true;
        break;
      }
    }
    if (!shared) return 'UNGROUNDED';
  }
  return null;
}
