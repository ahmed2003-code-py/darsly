import { UNCLEAR } from './transcript.schema';
import { normalise } from './reconcile';

/**
 * Deciding what a reading needs, without asking a model how it feels.
 *
 * The current path escalated on the confidence number the reading model
 * reported about itself, and on the benchmark pages that number said the
 * opposite of the truth: text that was genuinely unreadable came back at
 * 0.10–0.20, and exam questions that are nowhere on the page — invented by
 * the cheap model from a crop of revision notes — came back at 0.45–0.74.
 * Everything here is measured from the output and the pixels instead, and
 * every verdict carries the reason, so every escalation can say why it
 * happened.
 */

export type ChunkVerdict =
  /** Read; accept it. */
  | 'CLEAR'
  /** The crop is likely the problem — it has ink, the reading has almost
   *  nothing. Recrop before paying for a better reader. */
  | 'BAD_CROP'
  /** The crop looks fine and the reader could not settle what it shows. */
  | 'AMBIGUOUS';

export interface ChunkAssessment {
  verdict: ChunkVerdict;
  reasons: string[];
  signals: {
    readableChars: number;
    lines: number;
    charsPerLine: number;
    expectedCharsPerLine: number;
    unclearRatio: number;
  };
}

/** Readable characters: what is left once the markers and the spacing go. */
export function readableChars(text: string): number {
  return (text ?? '').split(UNCLEAR).join('').replace(/\s+/g, '').length;
}

/** The share of the reading that is [UNCLEAR], counted in words. */
export function unclearRatio(text: string): number {
  const t = text ?? '';
  const unclear = t.split(UNCLEAR).length - 1;
  const words = t
    .split(UNCLEAR)
    .join(' ')
    .split(/\s+/)
    .filter((w) => w.replace(/[^\p{L}\p{N}]/gu, '').length > 0).length;
  return unclear + words ? unclear / (unclear + words) : 0;
}

export const THRESHOLDS = {
  /** Above this share of [UNCLEAR], a reading is not settled. */
  unclear: 0.2,
  /** Below this fraction of the page's typical characters per line, a crop
   *  that has ink in it has been read as (nearly) nothing. */
  shortFraction: 0.3,
  /** What a line of handwriting carries at least, when the page gives no
   *  better estimate. Deliberately low: a line of "(٢) ٥ + ٣" is short. */
  minCharsPerLine: 6,
};

export function assessChunk(input: {
  text: string;
  lines: number;
  expectedCharsPerLine: number;
}): ChunkAssessment {
  const chars = readableChars(input.text);
  const lines = Math.max(1, input.lines);
  const expected = Math.max(THRESHOLDS.minCharsPerLine, input.expectedCharsPerLine);
  const perLine = chars / lines;
  const ratio = unclearRatio(input.text);
  const reasons: string[] = [];
  let verdict: ChunkVerdict = 'CLEAR';

  if (chars < 3) {
    verdict = 'BAD_CROP';
    reasons.push(`EMPTY_WITH_INK (${lines} line(s) of ink, ${chars} chars read)`);
  } else if (perLine < expected * THRESHOLDS.shortFraction && ratio < THRESHOLDS.unclear) {
    // Short but not unclear: the reader saw only part of what is there —
    // a crop cut through lines, or ink too faint in this rendering.
    verdict = 'BAD_CROP';
    reasons.push(
      `TOO_SHORT_FOR_INK (${perLine.toFixed(1)} chars/line vs ~${expected.toFixed(0)} typical)`,
    );
  } else if (ratio > THRESHOLDS.unclear) {
    verdict = 'AMBIGUOUS';
    reasons.push(`UNCLEAR_RATIO ${(ratio * 100).toFixed(0)}%`);
  }
  return {
    verdict,
    reasons,
    signals: {
      readableChars: chars,
      lines,
      charsPerLine: perLine,
      expectedCharsPerLine: expected,
      unclearRatio: ratio,
    },
  };
}

// ── the page as a whole ────────────────────────────────────────────────────

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const toInt = (s: string) => Number(s.replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d))));

/**
 * Question numbers printed at the start of a line: (١) ، ١) ، ١- ، ١. ، س١ ،
 * Q1 ، [٢] ، ٢/ . Only at a line start, so a number inside a sentence — «في
 * السنة ٦» — is not taken for a question.
 */
const MARKER =
  /^\s*(?:(?:س|سؤال|السؤال|Q|Question)\s*\.?\s*([0-9٠-٩]{1,2})|[([]\s*([0-9٠-٩]{1,2})\s*[)\]]|([0-9٠-٩]{1,2})\s*[)\-–.\/])/iu;

export function questionMarkers(text: string): number[] {
  const out: number[] = [];
  for (const line of (text ?? '').split('\n')) {
    const m = MARKER.exec(line);
    if (!m) continue;
    const n = toInt(m[1] ?? m[2] ?? m[3]);
    if (n >= 1 && n <= 60) out.push(n);
  }
  return out;
}

export interface NumberingReport {
  numbers: number[];
  /** Numbers between the first and last that never appear. */
  missing: number[];
  duplicates: number[];
  /** A run long enough to call the page numbered at all. */
  numbered: boolean;
}

export function numbering(numbers: number[]): NumberingReport {
  const seen = new Map<number, number>();
  for (const n of numbers) seen.set(n, (seen.get(n) ?? 0) + 1);
  const distinct = [...seen.keys()].sort((a, b) => a - b);
  const missing: number[] = [];
  if (distinct.length) {
    for (let n = distinct[0]; n <= distinct[distinct.length - 1]; n++) {
      if (!seen.has(n)) missing.push(n);
    }
  }
  return {
    numbers,
    missing,
    duplicates: [...seen.entries()].filter(([, c]) => c > 1).map(([n]) => n),
    // Two consecutive numbers at line starts is a numbered page; one could be
    // a heading or a list inside a question.
    numbered: distinct.some((n) => seen.has(n + 1)),
  };
}

// ── is the question on the page at all ─────────────────────────────────────

const wordsOf = (text: string) =>
  normalise(text)
    .replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)))
    .split(UNCLEAR.toLowerCase())
    .join(' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1);

/**
 * How much of a question's text is present in the transcript it was taken
 * from, in words. The structuring step is told never to invent; this is how
 * that is checked rather than hoped. A question the transcript does not
 * contain — «احسب مساحة المثلث» out of a page of revision notes — scores near
 * zero, and is dropped with its reason logged rather than shown to a teacher
 * as if it were on the paper.
 */
export function grounding(questionText: string, transcript: string): number {
  const q = wordsOf(questionText);
  if (!q.length) return 1;
  const t = new Set(wordsOf(transcript));
  return q.filter((w) => t.has(w)).length / q.length;
}
