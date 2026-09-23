import { normalise } from '../reconcile';

/**
 * How good is a transcription, in numbers.
 *
 * The reason this file exists as its own thing: **numeric accuracy has to be
 * measured separately from word accuracy.** A transcriber that gets 96% of the
 * Arabic right and turns ١٢٨ into ١٢٨٠ is worse than useless for an exam — the
 * text reads fine, a teacher publishes it, and a class is marked against a
 * number nobody typed. A single blended score hides exactly that.
 */

export interface AccuracyReport {
  /** 1 − (edits / reference length). Characters. */
  characterAccuracy: number;
  /** Same, on whitespace-separated words. */
  wordAccuracy: number;
  /**
   * Fraction of the reference's numbers that appear, unchanged, in the
   * result. The number that decides whether a pipeline is usable here.
   */
  numericAccuracy: number;
  /** Numbers that changed, so a regression names them rather than scoring. */
  numericErrors: { expected: string; got: string | null }[];
  /** Fraction of reference math expressions preserved. */
  mathAccuracy: number;
  referenceNumbers: number;
}

/**
 * Digits in either script, with the separators that belong to a number.
 *
 * The Arabic decimal separator is U+066B (٫) and the thousands separator is
 * U+066C (٬) — neither is the comma or the full stop, and leaving them out
 * split ١٣٫٦ into "١٣" and "٦". That is two numbers where the page has one,
 * on exactly the pages this metric exists for.
 */
const NUMBER = /[٠-٩0-9]+(?:[.,،\u066b\u066c/][٠-٩0-9]+)*/gu;

export function numbersIn(text: string): string[] {
  return (text ?? '').match(NUMBER) ?? [];
}

/** Levenshtein. Iterative and two-rowed, because a page of Arabic against a
 *  page of Arabic is a million cells and the naive matrix is a memory bug. */
export function editDistance(a: string[], b: string[]): number {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

function accuracy(reference: string[], got: string[]): number {
  if (!reference.length) return got.length ? 0 : 1;
  return Math.max(0, 1 - editDistance(reference, got) / reference.length);
}

/**
 * Compare a transcription against what the page actually says.
 *
 * Both sides are folded the way the reconciler folds them — Arabic spelled
 * with and without diacritics is the same word, and marking it wrong would
 * measure typography rather than reading. Numbers are NOT folded: a digit is
 * either the digit on the page or it is not.
 */
export function scoreTranscription(reference: string, got: string): AccuracyReport {
  const refNorm = normalise(reference);
  const gotNorm = normalise(got);

  const refNumbers = numbersIn(reference);
  const gotNumbers = numbersIn(got);
  const pool = [...gotNumbers];
  const numericErrors: { expected: string; got: string | null }[] = [];
  let matched = 0;
  for (const expected of refNumbers) {
    const at = pool.indexOf(expected);
    if (at >= 0) {
      pool.splice(at, 1);
      matched++;
    } else {
      // Name the nearest thing that came back instead, which is what a human
      // debugging a regression actually wants to see.
      const near = pool
        .map((c) => ({ c, d: editDistance([...c], [...expected]) }))
        .sort((x, y) => x.d - y.d)[0];
      numericErrors.push({ expected, got: near && near.d <= 2 ? near.c : null });
      if (near && near.d <= 2) pool.splice(pool.indexOf(near.c), 1);
    }
  }

  const refMath = mathIn(reference);
  const gotMathText = normalise(got);
  const mathMatched = refMath.filter((m) => gotMathText.includes(normalise(m))).length;

  return {
    characterAccuracy: accuracy([...refNorm], [...gotNorm]),
    wordAccuracy: accuracy(refNorm.split(' ').filter(Boolean), gotNorm.split(' ').filter(Boolean)),
    numericAccuracy: refNumbers.length ? matched / refNumbers.length : 1,
    numericErrors,
    mathAccuracy: refMath.length ? mathMatched / refMath.length : 1,
    referenceNumbers: refNumbers.length,
  };
}

/** Expressions worth checking survived: roots, fractions, powers, percents. */
export function mathIn(text: string): string[] {
  const found =
    (text ?? '').match(/[√∛][^\s]*|[٠-٩0-9]+\s*\/\s*[٠-٩0-9]+|[٠-٩0-9]+\s*[٪%]|\^\s*[٠-٩0-9]+/gu) ??
    [];
  return found.map((m) => m.trim()).filter(Boolean);
}

/**
 * Did the page divide into the right pieces?
 *
 * Measured against the reference's own question count rather than against
 * boxes, because the boxes are a means: what matters downstream is that
 * question four did not get glued onto question three.
 */
export function segmentationAccuracy(expectedRegions: number, gotRegions: number): number {
  if (!expectedRegions) return gotRegions ? 0 : 1;
  return Math.max(0, 1 - Math.abs(expectedRegions - gotRegions) / expectedRegions);
}

/**
 * Is the confidence honest?
 *
 * A pipeline whose confidence has nothing to do with whether it was right is
 * worse than one with no confidence at all, because every threshold built on
 * it is then noise. Positive means high confidence went with high accuracy.
 */
export function confidenceCalibration(samples: { confidence: number; accuracy: number }[]): number {
  if (samples.length < 2) return 0;
  const mc = samples.reduce((s, x) => s + x.confidence, 0) / samples.length;
  const ma = samples.reduce((s, x) => s + x.accuracy, 0) / samples.length;
  let cov = 0;
  let vc = 0;
  let va = 0;
  for (const s of samples) {
    cov += (s.confidence - mc) * (s.accuracy - ma);
    vc += (s.confidence - mc) ** 2;
    va += (s.accuracy - ma) ** 2;
  }
  if (!vc || !va) return 0;
  return cov / Math.sqrt(vc * va);
}
