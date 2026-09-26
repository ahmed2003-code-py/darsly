/**
 * Scoring for the Arabic lesson transcription benchmark (bench.mjs).
 *
 * WER/CER alone hide what matters in an Egyptian classroom: the English
 * technical words teachers drop into Arabic ("الـ derivative", "function"),
 * the numbers in a worked example, and whether the words that remain are the
 * dialect that was spoken. So each is scored separately, against a human
 * reference transcript.
 */
const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';

export function toAsciiDigits(s) {
  return s.replace(/[٠-٩۰-۹]/g, (d) => String(ARABIC_INDIC.indexOf(d) >= 0 ? ARABIC_INDIC.indexOf(d) : PERSIAN.indexOf(d)));
}

export function normalizeArabic(s) {
  return toAsciiDigits(s)
    .normalize('NFKC')
    .replace(/[ً-ْٰـ]/g, '') // harakat, dagger alef, tatweel
    .replace(/[آأإٱ]/g, 'ا') // alef forms → ا
    .replace(/ى/g, 'ي') // ى → ي
    .replace(/ة/g, 'ه') // ة → ه
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const words = (s) => normalizeArabic(s).split(' ').filter(Boolean);

export function wer(ref, hyp) {
  const r = words(ref);
  return r.length ? editDistance(r, words(hyp)) / r.length : 0;
}

export function cer(ref, hyp) {
  const r = [...normalizeArabic(ref).replace(/ /g, '')];
  return r.length ? editDistance(r, [...normalizeArabic(hyp).replace(/ /g, '')]) / r.length : 0;
}

/** Share of the reference's tokens of one kind found in the hypothesis (multiset). */
function recall(refTokens, hypTokens) {
  if (!refTokens.length) return null;
  const bag = new Map();
  for (const t of hypTokens) bag.set(t, (bag.get(t) ?? 0) + 1);
  let hit = 0;
  for (const t of refTokens) {
    const n = bag.get(t) ?? 0;
    if (n > 0) {
      hit++;
      bag.set(t, n - 1);
    }
  }
  return hit / refTokens.length;
}

const isArabic = (w) => /\p{Script=Arabic}/u.test(w);
const isLatin = (w) => /^[a-z][a-z0-9-]+$/.test(w);
const isNumber = (w) => /^\d+([.,]\d+)?$/.test(w);

/** Arabic words kept (dialect included — the reference is what was said). */
export const arabicRecall = (ref, hyp) => recall(words(ref).filter(isArabic), words(hyp).filter(isArabic));
/** English terms inside Arabic speech. */
export const englishRecall = (ref, hyp) => recall(words(ref).filter(isLatin), words(hyp).filter(isLatin));
/** Numbers, digits normalised (٣ = 3). */
export const numberRecall = (ref, hyp) => recall(words(ref).filter(isNumber), words(hyp).filter(isNumber));

/**
 * Egyptian-dialect words kept as dialect. A model that "corrects" دلوقتي to
 * الآن or إزاي to كيف has changed what the teacher said; this is the share of
 * the reference's dialect markers (normalised) that survive.
 */
export const EGYPTIAN_MARKERS = [
  'دلوقتي', 'ازاي', 'عشان', 'علشان', 'كده', 'كدا', 'مش', 'بتاع', 'بتاعه', 'بتاعت', 'ليه', 'ايه',
  'النهارده', 'بكره', 'امبارح', 'يعني', 'اهو', 'خلاص', 'اوي', 'فين', 'امتي', 'هنعمل', 'هنشوف',
  'عايز', 'عاوز', 'عايزين', 'ماشي', 'بس', 'برضه', 'لسه', 'حاجه', 'زي', 'دي', 'ده', 'اللي',
].map((w) => normalizeArabic(w));
export const dialectRecall = (ref, hyp) => {
  const set = new Set(EGYPTIAN_MARKERS);
  return recall(words(ref).filter((w) => set.has(w)), words(hyp).filter((w) => set.has(w)));
};

/** Punctuation the provider put in, relative to the reference (1 = as much). */
export function punctuationRatio(ref, hyp) {
  const count = (s) => (s.match(/[.,،؛؟?!:]/g) ?? []).length;
  const r = count(ref);
  return r ? +(count(hyp) / r).toFixed(3) : null;
}

export function scoreAll(ref, hyp) {
  return {
    wer: +wer(ref, hyp).toFixed(4),
    cer: +cer(ref, hyp).toFixed(4),
    arabicWordRecall: round(arabicRecall(ref, hyp)),
    englishTermRecall: round(englishRecall(ref, hyp)),
    numberRecall: round(numberRecall(ref, hyp)),
    dialectRecall: round(dialectRecall(ref, hyp)),
    punctuationRatio: punctuationRatio(ref, hyp),
  };
}
const round = (x) => (x == null ? null : +x.toFixed(4));
