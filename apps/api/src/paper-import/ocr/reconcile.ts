import { PageTranscript, TranscriptRegion, UNCLEAR, UncertainRegion } from './transcript.schema';

/**
 * Choosing between two readings of the same pixels.
 *
 * The rule, and the reason this is code rather than another model call:
 * **visual evidence outranks sense.** When one pass reads "128" and another
 * reads "1280", the tempting resolution is the one where the arithmetic works
 * out — and that is exactly the resolution that silently changes a student's
 * exam. Sense is allowed to break a tie between readings that are equally well
 * evidenced. It is never allowed to overturn a better look at the page.
 *
 * "A better look" has a concrete meaning here: a crop of one question, sent at
 * the same patch budget as the whole page, is several times the resolution on
 * that question. So a later, tighter pass wins by construction, and the
 * ranking below is mostly a way of saying so precisely.
 */

/** Where a reading came from, which is what decides how much it is worth. */
export type Evidence = 'page' | 'region' | 'line' | 'focus';

/** How many pixels per character each kind of pass got, relative to the page
 *  pass. A region crop is the whole budget on a fraction of the page. */
const EVIDENCE_WEIGHT: Record<Evidence, number> = {
  page: 1,
  region: 2.2,
  line: 3.2,
  focus: 4,
};

export interface Candidate {
  text: string;
  confidence: number;
  evidence: Evidence;
  /** Which variant of the image it was read from, for the log. */
  variant?: string;
}

export interface Resolution {
  text: string;
  confidence: number;
  /** True when the candidates disagreed and none was well enough evidenced to
   *  settle it — the caller marks it unreadable rather than picking one. */
  unresolved: boolean;
  /** What was compared, kept for the log and for a human asking why. */
  considered: Candidate[];
}

/**
 * Digits in either script, plus the separators that belong to a number.
 *
 * Includes the Arabic decimal and thousands separators (U+066B ٫, U+066C ٬),
 * which are neither the comma nor the full stop — without them ١٣٫٦ does not
 * read as a number at all, and the numeric standoff that protects it never
 * fires.
 */
const NUMERIC = /^[\s٠-٩0-9.,،\u066b\u066c/\-+×x*٪%]+$/u;

export function looksNumeric(text: string): boolean {
  const trimmed = (text ?? '').trim();
  return !!trimmed && NUMERIC.test(trimmed) && /[٠-٩0-9]/u.test(trimmed);
}

/**
 * Pick between readings of the same thing.
 *
 * Agreement is the strongest signal there is: two passes at different
 * resolutions, off differently-processed images, arriving at the same string
 * is worth more than either pass's own confidence. Disagreement falls back to
 * evidence weight, and a disagreement about a *number* that the evidence does
 * not settle is left unresolved rather than guessed.
 */
export function reconcile(candidates: Candidate[]): Resolution {
  const usable = candidates.filter((c) => (c.text ?? '').trim());
  if (!usable.length) {
    return { text: '', confidence: 0, unresolved: true, considered: candidates };
  }
  if (usable.length === 1) {
    return {
      text: usable[0].text,
      confidence: usable[0].confidence,
      unresolved: false,
      considered: candidates,
    };
  }

  // Group by what they actually say, ignoring spacing and Arabic spelling
  // variants — two passes that differ only in whitespace agree.
  const groups = new Map<string, Candidate[]>();
  for (const c of usable) {
    const key = normalise(c.text);
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }

  const scored = [...groups.entries()].map(([, members]) => {
    const best = members.reduce((a, b) =>
      EVIDENCE_WEIGHT[b.evidence] > EVIDENCE_WEIGHT[a.evidence] ? b : a,
    );
    // Evidence first, then agreement, then the model's own confidence. The
    // ordering is the policy: a closer look beats two distant looks that
    // happened to agree with each other.
    const weight =
      EVIDENCE_WEIGHT[best.evidence] *
      (1 + 0.35 * (members.length - 1)) *
      (0.5 + best.confidence / 2);
    return { members, best, weight, agreement: members.length };
  });
  scored.sort((a, b) => b.weight - a.weight);

  const winner = scored[0];
  const runnerUp = scored[1];
  const agreed = winner.agreement > 1;

  // A disagreement about a number that no pass is clearly better placed to
  // settle. Picking one here is picking at random and calling it a reading.
  const numericStandoff =
    !!runnerUp &&
    looksNumeric(winner.best.text) &&
    looksNumeric(runnerUp.best.text) &&
    normalise(winner.best.text) !== normalise(runnerUp.best.text) &&
    winner.weight < runnerUp.weight * 1.25;

  return {
    text: winner.best.text,
    // Agreement across passes is worth more than any single pass's own number,
    // and a bare win over a close rival is worth less.
    confidence: Math.max(
      0,
      Math.min(
        1,
        agreed
          ? Math.min(1, winner.best.confidence + 0.15)
          : runnerUp
            ? winner.best.confidence * 0.9
            : winner.best.confidence,
      ),
    ),
    unresolved: numericStandoff,
    considered: candidates,
  };
}

/** Whitespace, Arabic orthography and digit script folded away, so two
 *  readings are compared on what they say rather than on how they are typed. */
export function normalise(text: string): string {
  return (text ?? '')
    .replace(/[ً-ْٰـ]/g, '')
    .replace(/[آأإٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Fold a re-read of one region back into the page.
 *
 * The region that was looked at again replaces the one that was guessed at,
 * and the ones that were already good are left exactly as they were — which is
 * the whole point of looking again at one question rather than at the page.
 */
export function mergeRegion(
  transcript: PageTranscript,
  index: number,
  resolved: TranscriptRegion,
): PageTranscript {
  const regions = transcript.regions.map((r, i) => (i === index ? resolved : r));
  return {
    ...transcript,
    regions,
    // The page is only as readable as its least readable part, because that is
    // the part a teacher will be retyping.
    confidence: regions.length
      ? Math.min(...regions.map((r) => r.confidence))
      : transcript.confidence,
  };
}

/** Replace an uncertain fragment inside a region's text with what a closer
 *  look actually found, or with the marker when the look settled nothing. */
export function applyFragment(
  region: TranscriptRegion,
  fragment: UncertainRegion,
  resolution: Resolution,
): TranscriptRegion {
  const replacement = resolution.unresolved ? UNCLEAR : resolution.text;
  const text = region.text.includes(fragment.text)
    ? region.text.replace(fragment.text, replacement)
    : region.text;
  const uncertain = resolution.unresolved
    ? region.uncertain.map((u) =>
        u === fragment ? { ...u, text: replacement, confidence: resolution.confidence } : u,
      )
    : region.uncertain.filter((u) => u !== fragment);
  return {
    ...region,
    text,
    uncertain,
    confidence: resolution.unresolved
      ? Math.min(region.confidence, resolution.confidence)
      : Math.max(region.confidence, Math.min(1, resolution.confidence)),
  };
}
