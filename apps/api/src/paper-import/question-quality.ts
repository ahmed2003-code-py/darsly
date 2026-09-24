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

/** Two questions are compared over at least this share of the larger one's
 *  features. A paraphrase says about as much as what it rewords; a question
 *  a third the length of another, all of whose words the other contains,
 *  is about the same topic and asks something smaller. */
const SIZE_BALANCE = 0.75;

/** Words that turn a question into its opposite, in pairs, folded. "Which
 *  combination describes good clustering" and "…bad clustering" share every
 *  other word and ask for opposite answers. Any length: "bad" is three
 *  letters, and the features below keep only four and up. */
const OPPOSITES: [string, string][] = [
  ['good', 'bad'],
  ['high', 'low'],
  ['higher', 'lower'],
  ['highest', 'lowest'],
  ['increase', 'decrease'],
  ['increases', 'decreases'],
  ['more', 'less'],
  ['most', 'least'],
  ['largest', 'smallest'],
  ['larger', 'smaller'],
  ['maximum', 'minimum'],
  ['best', 'worst'],
  ['advantage', 'disadvantage'],
  ['advantages', 'disadvantages'],
  ['true', 'false'],
  ['correct', 'incorrect'],
  ['before', 'after'],
  ['first', 'last'],
  ['strong', 'weak'],
  ['اكبر', 'اصغر'],
  ['اعلي', 'اقل'],
  ['اكثر', 'اقل'],
  ['زياده', 'نقصان'],
  ['يزيد', 'يقل'],
  ['مزايا', 'عيوب'],
  ['ميزه', 'عيب'],
  ['صحيح', 'خطا'],
  ['صحيحه', 'خاطئه'],
  ['قبل', 'بعد'],
  ['اول', 'اخر'],
  ['جيد', 'سيئ'],
  ['جيده', 'سيئه'],
  ['قوي', 'ضعيف'],
];

/** Whether one question holds a word whose opposite only the other holds. */
function opposed(a: string, b: string): boolean {
  // Each word as written and stemmed, so "الأكبر" is "أكبر".
  const words = (t: string) =>
    new Set(
      foldArabic(t ?? '')
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean)
        .flatMap((w) => [w, lightStem(w)]),
    );
  const [left, right] = [words(a), words(b)];
  return OPPOSITES.map(([x, y]) => [lightStem(x), lightStem(y)]).some(
    ([x, y]) =>
      (left.has(x) && !left.has(y) && right.has(y) && !right.has(x)) ||
      (left.has(y) && !left.has(x) && right.has(x) && !right.has(y)),
  );
}

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
  // Over the smaller question, but never less than most of the larger: a
  // short question whose every word is in a long one ("What is unsupervised
  // learning?" in "Which pair lists the two main tasks of unsupervised
  // learning?") shares its topic, not its question.
  const smaller = Math.min(left.all.size, right.all.size);
  const larger = Math.max(left.all.size, right.all.size);
  const overlap = shared / Math.max(MIN_EVIDENCE, smaller, larger * SIZE_BALANCE);
  if (opposed(a, b)) return Math.min(overlap, NUMBERS_AGREE);
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

// ── learning points ────────────────────────────────────────────────────────

/** Function words and question scaffolding of three letters or more, folded:
 *  "بحسب المادة" names where a fact is, not which fact. */
const POINT_STOP = new Set([
  'اذا',
  'فما',
  'وكم',
  'وهل',
  'فهل',
  'علي',
  'الي',
  'التي',
  'الذي',
  'كان',
  'كانت',
  'هذا',
  'هذه',
  'ذلك',
  'تلك',
  'وهي',
  'وهو',
  'لها',
  'فيه',
  'فيها',
  'بين',
  'عند',
  'كما',
  'مما',
  'لكن',
  'ليس',
  'غير',
  'بعد',
  'قبل',
  'حتي',
  'ماذا',
  'متي',
  'كيف',
  'لماذا',
  'بحسب',
  'حسب',
  'وفق',
  'وفقا',
  'ماده',
  'الماده',
  'النص',
  'المذكور',
  'المذكوره',
  'المذكورين',
  'الوارده',
  'ورد',
  'وردت',
  'وردتا',
  'يلي',
  'عدد',
  'خيار',
  'الخيار',
  'وصف',
  'يطابق',
  'يوافق',
  'يجمع',
  'تجمع',
  'بصوره',
  'صوره',
  'the',
  'and',
  'for',
  'are',
  'was',
  'were',
  'not',
  'its',
  'has',
  'have',
  'but',
  'you',
  'can',
  'how',
  'why',
  'who',
  'did',
  'according',
  'material',
  'text',
]);

/** Arabic prefixes and endings that change a word's case or number, not its
 *  meaning: "حركتان" and "حركتين" are one answer. Only ever cut down to three
 *  letters, so a short root is left alone. */
function lightStem(w: string): string {
  let s = w;
  for (const p of ['وال', 'بال', 'فال', 'كال', 'لل', 'ال']) {
    if (s.startsWith(p) && s.length - p.length >= 3) {
      s = s.slice(p.length);
      break;
    }
  }
  // A single-letter prefix ("ومدة", "لمدة") is cut whenever three letters are
  // left. It sometimes cuts a letter that belongs to the word, but it cuts it
  // the same way in both questions, and matching is all this is for.
  if (s === w && /^[وبلفك]/.test(s) && s.length >= 4 && /[؀-ۿ]/.test(s)) s = s.slice(1);
  // Up to two endings: "هجرية" → "هجري" → "هجر".
  for (let pass = 0; pass < 2; pass++) {
    const suf = ['هم', 'ها', 'ان', 'ين', 'ون', 'ات', 'ه', 'ي', 'ا'].find(
      (x) => s.endsWith(x) && s.length - x.length >= 3,
    );
    if (!suf) break;
    s = s.slice(0, -suf.length);
  }
  return s;
}

/** What a stretch of text says, for comparing learning points: its numbers
 *  and its content words (three letters and up, stemmed). */
export function pointFeatures(text: string): Set<string> {
  const out = new Set<string>();
  const folded = normaliseMath(foldArabic(text ?? '')).toLowerCase();
  for (const n of folded.match(/\d+(?:\.\d+)?/g) ?? []) out.add(`#${n}`);
  for (const w of folded.split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < 3 || /\d/.test(w) || GENERIC_WORDS.has(w) || POINT_STOP.has(w)) continue;
    const s = lightStem(w);
    if (GENERIC_WORDS.has(s) || POINT_STOP.has(s)) continue;
    out.add(s);
  }
  return out;
}

type PointQuestion = Pick<GradedQuestion, 'type' | 'text' | 'options' | 'modelAnswer'>;

/**
 * What a question tests: the answer it expects, less what its own wording
 * already says. A true/false question tests its whole statement.
 */
function testedBy(q: PointQuestion): Set<string> {
  if (q.type === 'TRUE_FALSE') return pointFeatures(q.text);
  const answer =
    q.type === 'SHORT_ANSWER'
      ? (q.modelAnswer ?? '')
      : (q.options ?? [])
          .filter((o) => o.correct)
          .map((o) => o.text)
          .join(' ');
  const stem = pointFeatures(q.text);
  return new Set([...pointFeatures(answer)].filter((f) => !stem.has(f)));
}

function wholeOf(q: PointQuestion): Set<string> {
  const parts = [
    q.text,
    q.modelAnswer ?? '',
    ...(q.options ?? []).filter((o) => o.correct).map((o) => o.text),
  ];
  return pointFeatures(parts.join(' '));
}

/**
 * Whether two questions test the same learning point — the number of verses
 * in a surah asked once as true/false and again as multiple choice — or one
 * gives away the other's answer in its wording.
 *
 * Not the same as a duplicate: the two may be worded nothing alike. And not
 * the same as a shared topic: two questions about one surah, one asking how
 * many verses it has and one whether it is Meccan, test different points.
 *
 * The rule: the two share a subject (a content word or number in both
 * stems), and what one of them tests, apart from that subject, is at least
 * half present in the other — asked by it, answered by it, or stated in it.
 */
export function repeatsPoint(a: PointQuestion, b: PointQuestion): boolean {
  const stemA = pointFeatures(a.text);
  const stemB = pointFeatures(b.text);
  const subject = new Set([...stemA].filter((f) => stemB.has(f)));
  if (!subject.size) return false;
  // Two questions whose answer is the same word — "mitochondria" for where
  // ATP is made and for which organelle has its own DNA — are two points.
  // More than half of what the smaller one says must be in the other too.
  const wholeA = wholeOf(a);
  const wholeB = wholeOf(b);
  const [small, large] = wholeA.size <= wholeB.size ? [wholeA, wholeB] : [wholeB, wholeA];
  if ([...small].filter((f) => large.has(f)).length * 2 <= small.size) return false;
  const covers = (x: PointQuestion, other: Set<string>, otherStem: Set<string>) => {
    const tested = [...testedBy(x)].filter((f) => !subject.has(f));
    if (!tested.length) return false;
    if (tested.filter((f) => other.has(f)).length * 2 < tested.length) return false;
    // A worked-out number printed in the other question's wording gives the
    // answer away, whatever else either question says.
    const numbers = tested.filter((f) => f.startsWith('#'));
    if (numbers.length && numbers.every((f) => otherStem.has(f))) return true;
    // Otherwise what x asks about, beyond the shared subject, must be there
    // too: "how is the new centroid found" is not the assignment step, however
    // much of the assignment step its answer repeats on the way. Only when x
    // asks about two things or more and the other mentions none of them — one
    // leftover word is usually just the question's verb ("بلغ", "استمر").
    if (x.type === 'TRUE_FALSE') return true;
    const asked = [...pointFeatures(x.text)].filter((f) => !subject.has(f));
    return asked.length < 2 || asked.some((f) => other.has(f));
  };
  return covers(a, wholeB, stemB) || covers(b, wholeA, stemA);
}

// ── numbers a question gives ───────────────────────────────────────────────

/** Folded Arabic number words, cardinal and ordinal. The material says
 *  "ستة أيام" where a question writes "٦ أيام"; both are the number 6. */
const NUMBER_WORDS: Record<string, number> = {
  واحد: 1,
  احد: 1,
  احدي: 1,
  اول: 1,
  اولي: 1,
  حادي: 1,
  حاديه: 1,
  اثنان: 2,
  اثنين: 2,
  اثنتان: 2,
  اثنتين: 2,
  اثنا: 2,
  اثنتا: 2,
  ثاني: 2,
  ثانيه: 2,
  ثلاث: 3,
  ثلاثه: 3,
  ثالث: 3,
  ثالثه: 3,
  اربع: 4,
  اربعه: 4,
  رابع: 4,
  رابعه: 4,
  خمس: 5,
  خمسه: 5,
  خامس: 5,
  خامسه: 5,
  ست: 6,
  سته: 6,
  سادس: 6,
  سادسه: 6,
  سبع: 7,
  سبعه: 7,
  سابع: 7,
  سابعه: 7,
  ثمان: 8,
  ثماني: 8,
  ثمانيه: 8,
  ثامن: 8,
  ثامنه: 8,
  تسع: 9,
  تسعه: 9,
  تاسع: 9,
  تاسعه: 9,
  عشر: 10,
  عشره: 10,
  عاشر: 10,
  عاشره: 10,
  عشرون: 20,
  عشرين: 20,
  ثلاثون: 30,
  ثلاثين: 30,
  اربعون: 40,
  اربعين: 40,
  خمسون: 50,
  خمسين: 50,
  ستون: 60,
  ستين: 60,
  سبعون: 70,
  سبعين: 70,
  ثمانون: 80,
  ثمانين: 80,
  تسعون: 90,
  تسعين: 90,
  مائه: 100,
  مئه: 100,
  مائتا: 200,
  مائتي: 200,
  مائتان: 200,
  مئتا: 200,
  مئتي: 200,
  مئتان: 200,
  الف: 1000,
  الفا: 1000,
  الفان: 2000,
  الفين: 2000,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  hundred: 100,
  thousand: 1000,
};
const THOUSANDS = new Set(['الف', 'الاف', 'thousand']);
const TEENS = new Set(['عشر', 'عشره']);

/** Numbers a text writes in words: "ثلاثة آلاف" 3000, "الحادية عشرة" 11. */
function wordNumbers(text: string): Set<number> {
  const out = new Set<number>();
  const words = foldArabic(text ?? '')
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter(Boolean)
    .map((w) => {
      for (const p of ['وال', 'بال', 'لل', 'ال', 'و', 'ب', 'ل'])
        if (w.startsWith(p) && NUMBER_WORDS[w.slice(p.length)] != null) return w.slice(p.length);
      return w === 'الاف' ? 'الاف' : w;
    });
  for (let i = 0; i < words.length; i++) {
    let n = NUMBER_WORDS[words[i]];
    if (n == null) continue;
    if (n < 10 && TEENS.has(words[i + 1] ?? '')) {
      n += 10;
      i++;
    }
    if (n < 1000 && THOUSANDS.has(words[i + 1] ?? '')) {
      n *= 1000;
      i++;
    }
    out.add(n);
  }
  return out;
}

/** Words after which a small number is a reference, not data: "المسألة (٥)",
 *  "الخطوة ٢". Folded. */
const LABEL_WORDS = new Set([
  'المساله',
  'مساله',
  'السؤال',
  'سؤال',
  'الخطوه',
  'خطوه',
  'السطر',
  'سطر',
  'البند',
  'بند',
  'الفقره',
  'فقره',
  'الشكل',
  'شكل',
  'رقم',
  'الجزء',
  'جزء',
  'التمرين',
  'تمرين',
  'step',
  'question',
  'problem',
  'line',
  'part',
  'item',
  'number',
  'no',
  'exercise',
]);

/**
 * Every reading of the numbers in a text. "٩,٢" is 9.2 in Arabic writing and
 * "22,000" is 22000 in English; which one a comma means cannot be told from
 * the text, so both readings are kept.
 */
function numbersIn(text: string): Set<number> {
  const out = new Set<number>();
  const t = normaliseMath(foldArabic(text ?? '')).replace(/،/g, ' ');
  for (const m of t.match(/\d+(?:[.,]\d+)*/g) ?? []) {
    out.add(Number(m.replace(/,/g, '')));
    if (/^\d+,\d+$/.test(m)) out.add(Number(m.replace(',', '.')));
  }
  out.delete(NaN);
  return out;
}

/** The text of the answer a question is keyed to. */
function keyOf(q: Pick<GradedQuestion, 'type' | 'options' | 'modelAnswer'>): string {
  return q.type === 'SHORT_ANSWER'
    ? (q.modelAnswer ?? '')
    : ((q.options ?? []).find((o) => o.correct)?.text ?? '');
}

/** Whether a true/false statement is keyed as false — it may then quote a
 *  wrong number on purpose. */
function keyedFalse(q: Pick<GradedQuestion, 'type' | 'options'>): boolean {
  if (q.type !== 'TRUE_FALSE') return false;
  const key = (q.options ?? []).find((o) => o.correct)?.text ?? '';
  return /خطا|خاطئ|غلط|false|incorrect|wrong/i.test(foldArabic(key));
}

/**
 * Numbers a question hands the student that its chunk never gives.
 *
 * Only the question's own wording is read: the answer and the options may be
 * worked out, and a worked-out value is not in the material by definition.
 * The givens are different — "if the purchase price was 100" when the
 * material names no purchase price is a new problem the material does not
 * support, however well it is solved.
 */
export function unsupportedNumbers(
  q: Pick<GradedQuestion, 'type' | 'text' | 'options'>,
  chunkText: string,
): number[] {
  if (keyedFalse(q)) return [];
  const source = new Set([...numbersIn(chunkText), ...wordNumbers(chunkText)]);
  const out: number[] = [];
  const text = normaliseMath(foldArabic(q.text ?? ''));
  for (const match of text.matchAll(/\d+(?:[.,]\d+)*/g)) {
    const m = match[0];
    const readings = numbersIn(m);
    if ([...readings].some((n) => source.has(n))) continue;
    // A reference is not data: "(٥)" or "المسألة ٥" names a problem. Any other
    // number, however small, can change what is asked — "٣ أيام" is not six.
    const before = text.slice(0, match.index);
    const after = text.slice((match.index ?? 0) + m.length);
    const word = /([\p{L}]+)\s*$/u.exec(before)?.[1]?.toLowerCase() ?? '';
    const bracketed = /\(\s*$/.test(before) && /^\s*\)/.test(after);
    if (/^\d+$/.test(m) && (bracketed || LABEL_WORDS.has(word))) continue;
    out.push([...readings][0]);
  }
  return out;
}

/**
 * Whether a variant's new numbers are a problem.
 *
 * A variant of a worked problem may change its inputs on purpose — that is a
 * different question to sit for. It may not change a fact: Noah's 950 years
 * stay 950. So a number that is in neither the material nor the question
 * being varied (its answer included) is allowed only when:
 * - the question being varied is itself a problem, with two numbers or more
 *   given in it;
 * - the variant is keyed to a worked-out number, not "true" or a name;
 * - that answer differs from the original's — new inputs with the old answer
 *   means the answer was not worked out again.
 *
 * It checks the answer was recomputed, not that it is right; that remains the
 * review screen's job.
 */
export function variantNumbersProblem(
  variant: Pick<GradedQuestion, 'type' | 'text' | 'options' | 'modelAnswer'>,
  original: Pick<GradedQuestion, 'type' | 'text' | 'options' | 'modelAnswer'> | null,
  chunkText: string,
): boolean {
  // Asking a problem from the other end gives its answer as an input.
  const given = original ? `${original.text}\n${keyOf(original)}` : '';
  const extra = unsupportedNumbers(variant, `${chunkText}\n${given}`);
  if (!extra.length) return false;
  if (!original || numbersIn(original.text).size < 2) return true;
  const key = keyOf(variant);
  if (!numbersIn(key).size) return true;
  const fold = (s: string) => normaliseMath(foldArabic(s)).replace(/\s+/g, ' ').trim();
  return fold(key) === fold(keyOf(original));
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
  | 'UNSUPPORTED_NUMBER'
  // not the question's fault:
  | 'DUPLICATE'
  | 'SAME_POINT'
  | 'SURPLUS'
  | 'NOT_RETURNED'
  | 'CALL_FAILED';

const NOT_QUALITY: RejectReason[] = [
  'DUPLICATE',
  'SAME_POINT',
  'SURPLUS',
  'NOT_RETURNED',
  'CALL_FAILED',
];

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
 *
 * `numbers` checks the givens: every number the question states must be one
 * its chunk states (see `unsupportedNumbers`). Sharing a word with the chunk
 * says nothing about a price the model made up to finish a problem.
 */
export function questionProblem(
  q: GradedQuestion,
  opts: { chunkText?: string | null; anchor?: boolean; numbers?: boolean } = {},
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
  // Variants are checked by the run, against the question they vary.
  if (opts.numbers && unsupportedNumbers(q, opts.chunkText).length) return 'UNSUPPORTED_NUMBER';
  return null;
}
