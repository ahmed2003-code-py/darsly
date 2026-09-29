/**
 * What a transcription answer must look like before it is kept as what the
 * teacher said — the lessons of the 2026-09 Egyptian-Arabic benchmark:
 *
 *  - a 1.7 s tail piece came back as the lesson title (the prompt) instead of
 *    speech, 4 times in 9 chunked runs of the larger model;
 *  - one whole-file run fell into a loop — «مين هينجح» 20 times, the rest of
 *    the lesson gone (WER 2.16).
 *
 * Every check here is deliberately conservative: a teacher who repeats a
 * sentence three times, or says the lesson's title, is not a malfunction.
 */

/** A piece shorter than this is not sent to the provider (a tail, not speech). */
export const MIN_PIECE_MS = 2_000;

/** ~32 kbps Opus — the fallback when a piece did not say how long it was. */
export const estimateMs = (p: { durationMs: number | null; sizeBytes: number }) =>
  p.durationMs ?? Math.round(((p.sizeBytes * 8) / 32_000) * 1000);

export const isTooShort = (p: { durationMs: number | null; sizeBytes: number }) =>
  estimateMs(p) < MIN_PIECE_MS;

/**
 * Text for comparison only (never stored): Arabic letter variants folded,
 * diacritics and tatweel dropped, Arabic-Indic digits made ASCII, Latin
 * lower-cased, every punctuation mark and symbol a space, spaces collapsed.
 */
export function normalizeForCompare(s: string): string {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/[ً-ٰٟۖ-ۭ]/g, '')
    .replace(/ـ/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const tokens = (s: string) => normalizeForCompare(s).split(' ').filter(Boolean);
/** Little words a title-echo may add or drop («مقدمة في» / «مقدمة in»). */
const GLUE = new Set(['في', 'in', 'of', 'the', 'ال', 'و', 'عن', 'to']);

/**
 * The provider handed back the prompt (the lesson title) instead of speech.
 *
 * Only for a short answer — at most two words beyond the title — whose
 * content words all come from the title, and only when the piece is short
 * (under 30 s) or the answer is the title exactly. A long piece in which the
 * teacher says the title and then teaches is never caught: its answer is long.
 */
export function isPromptEcho(text: string, title: string, durationMs: number | null): boolean {
  const t = tokens(text);
  const ti = tokens(title);
  if (!t.length || !ti.length) return false;
  if (normalizeForCompare(text) === normalizeForCompare(title)) return true;
  if (t.length > ti.length + 2) return false;
  const titleSet = new Set(ti);
  const content = t.filter((w) => !GLUE.has(w));
  if (!content.length) return false;
  const fromTitle = content.filter((w) => titleSet.has(w)).length / content.length;
  const short = durationMs == null || durationMs < 30_000;
  return short && fromTitle >= 0.8;
}

/** A window this long, repeated this often, is a loop, not emphasis. */
const LOOP_WINDOW = 8;
const LOOP_REPEATS = 4;

/**
 * A pathological repetition loop — not a teacher repeating themselves.
 *
 * The observed loop was a ~100-word stretch played back ten times: no short
 * phrase dominates, but every 8-word window inside it recurs ten times. So
 * the test is coverage — the share of words that sit inside an 8-word window
 * occurring 4 or more times. Flagged when:
 *  - that coverage is at least 30 % (in real speech an 8-word window almost
 *    never recurs: the reference recording had no 5-word phrase twice, and a
 *    key sentence said three times covers a few percent at most); or
 *  - the words are impossibly dense for the audio: more than 7 words a second
 *    over at least 20 s (real Egyptian speech measured 2.3; the loop 6.5 —
 *    this bound is only for the extreme case the coverage test could miss).
 */
export function looksLikeRepetitionLoop(text: string, durationMs: number | null): boolean {
  const w = normalizeForCompare(text).split(' ').filter(Boolean);
  if (durationMs != null && durationMs >= 20_000 && w.length / (durationMs / 1000) > 7) return true;
  if (w.length < LOOP_WINDOW * LOOP_REPEATS) return false;
  const counts = new Map<string, number>();
  for (let i = 0; i + LOOP_WINDOW <= w.length; i++) {
    const k = w.slice(i, i + LOOP_WINDOW).join(' ');
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const covered = new Uint8Array(w.length);
  for (let i = 0; i + LOOP_WINDOW <= w.length; i++) {
    if ((counts.get(w.slice(i, i + LOOP_WINDOW).join(' ')) ?? 0) >= LOOP_REPEATS)
      covered.fill(1, i, i + LOOP_WINDOW);
  }
  return covered.reduce((a, b) => a + b, 0) / w.length >= 0.3;
}

/**
 * Delayed retries of a LIVE_TRANSCRIBE job, when pieces are still owed after
 * a transient failure (an outage, a rate limit, a timeout) that the quick
 * retries inside the job did not get past: ≈30 s, 2 min and 8 min. Indexed by
 * the attempt that just failed (1-based); the fourth attempt is the last.
 * With the quick retries a piece rides out ≈11 minutes of provider trouble.
 *
 * Failures that no wait can fix — the provider refusing the account, a file it
 * cannot read, an answer the guards rejected twice — never come here.
 */
export const TRANSCRIBE_RETRY_DELAYS_MS = [30_000, 2 * 60_000, 8 * 60_000];
export const retryDelayFor = (attempt: number) =>
  TRANSCRIBE_RETRY_DELAYS_MS[Math.min(Math.max(attempt, 1), TRANSCRIBE_RETRY_DELAYS_MS.length) - 1];

/** Inside one run, a piece that met a transient failure is tried again after these waits. */
export const PIECE_QUICK_RETRY_MS = [2_000, 8_000];
/** A rate limit's own "retry after" is honoured inside the run only up to this. */
export const MAX_IN_RUN_WAIT_MS = 20_000;
