import { estimateSkew, estimateTextHeight, profileCut, rowProfile } from './image-analysis';

/**
 * Cutting a page into the pieces worth looking at closely.
 *
 * The point is not tidiness. A whole A4 page sent at the model's patch budget
 * is about fifty pixels per line of text; one question from that page, sent at
 * the *same* budget, is six times the linear detail for the same number of
 * image tokens. Segmentation is how that magnification gets spent where it is
 * needed, and it is the difference between reading a faded handwritten
 * fraction and guessing at it.
 *
 * Deterministic, and deliberately so: a model asked to draw boxes costs a call
 * and returns coordinates that have to be trusted. A horizontal projection
 * over the page's own ink does not cost anything and can be checked.
 */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Band extends Box {
  /** Ink in this band, for ranking which pieces are worth a second look. */
  ink: number;
}

export interface SegmentationResult {
  /** The blocks a page divides into — questions, on an exam. */
  blocks: Band[];
  /** Individual text lines, for when a block is still too hard to read. */
  lines: Band[];
  /** Measured, in the units of the image that was segmented. */
  textHeightPx: number;
  /** False when the page did not divide into anything convincing, and the
   *  caller should fall back to reading it whole. */
  confident: boolean;
}

export interface SegmentOptions {
  /** Lines closer together than this many text-heights belong to one block. */
  blockGapRatio?: number;
  /** Ignore a band this much shorter than a line of text: a speck, a rule. */
  minBandRatio?: number;
  /** Padding around each box, in text-heights, so descenders and the question
   *  number in the margin are not cut off. */
  padRatio?: number;
  /** Refuse to return more than this many blocks: past it the page did not
   *  segment, it disintegrated. */
  maxBlocks?: number;
}

const DEFAULTS: Required<SegmentOptions> = {
  blockGapRatio: 1.2,
  minBandRatio: 0.35,
  padRatio: 0.45,
  maxBlocks: 40,
};

/**
 * Find the lines and the blocks.
 *
 * `raw` is single-channel greyscale at `width * height`. Coordinates come back
 * in that image's own pixels; the caller scales them to the original before
 * cropping.
 */
export function segment(
  raw: Uint8Array,
  width: number,
  height: number,
  options: SegmentOptions = {},
): SegmentationResult {
  const opts = { ...DEFAULTS, ...options };
  const skew = estimateSkew(raw, width, height, 6);
  const profile = rowProfile(raw, width, height, skew);
  const textHeightPx = estimateTextHeight(raw, width, height, skew) || Math.round(height / 40);

  const lineBands = bandsFrom(profile, {
    // A line is separated from the next by a gap; anything shorter than a
    // third of a text height is the space between two rows of the same line.
    minGap: Math.max(1, Math.round(textHeightPx * 0.35)),
    minRun: Math.max(1, Math.round(textHeightPx * opts.minBandRatio)),
  });

  if (!lineBands.length) {
    return { blocks: [], lines: [], textHeightPx, confident: false };
  }

  const blockBands = bandsFrom(profile, {
    // Questions are separated by more white than lines are.
    minGap: Math.max(2, Math.round(textHeightPx * opts.blockGapRatio)),
    minRun: Math.max(1, Math.round(textHeightPx * opts.minBandRatio)),
  });

  const pad = Math.round(textHeightPx * opts.padRatio);
  const toBox = (b: { start: number; end: number; ink: number }): Band => ({
    // Full width: a question's number sits in the margin and its working sits
    // to one side, and a box that clips either is worse than no box.
    left: 0,
    width,
    top: Math.max(0, b.start - pad),
    height: Math.min(height - Math.max(0, b.start - pad), b.end - b.start + pad * 2),
    ink: b.ink,
  });

  const blocks = blockBands.map(toBox);
  const lines = lineBands.map(toBox);

  return {
    blocks,
    lines,
    textHeightPx,
    // One block is the whole page, which is not a segmentation; more than the
    // cap means the page fragmented and the boxes mean nothing.
    confident: blocks.length >= 2 && blocks.length <= opts.maxBlocks,
  };
}

/**
 * Runs of rows carrying text, separated by runs that do not.
 *
 * The threshold comes from `profileCut`, which measures the profile against
 * itself. It used to be a fraction of the busiest row, and that worked on
 * clean renderings and failed completely on a photographed manuscript: the
 * gaps between lines of handwriting are not empty, they carry paper grain, and
 * a scan's dark top edge sets a "busiest row" no line of text comes near.
 * That page segmented into exactly one block.
 */
function bandsFrom(
  profile: Float64Array,
  opts: { minGap: number; minRun: number },
): { start: number; end: number; ink: number }[] {
  if (!profile.length) return [];
  const { cut, smoothed } = profileCut(profile);
  profile = smoothed;

  const bands: { start: number; end: number; ink: number }[] = [];
  let start = -1;
  let gap = 0;
  let ink = 0;
  for (let y = 0; y < profile.length; y++) {
    if (profile[y] >= cut) {
      if (start < 0) {
        start = y;
        ink = 0;
      }
      gap = 0;
      ink += profile[y];
    } else if (start >= 0) {
      gap++;
      if (gap >= opts.minGap) {
        const end = y - gap;
        if (end - start >= opts.minRun) bands.push({ start, end, ink });
        start = -1;
        gap = 0;
      }
    }
  }
  if (start >= 0 && profile.length - start >= opts.minRun) {
    bands.push({ start, end: profile.length - 1, ink });
  }
  return bands;
}

/** Scale boxes measured on a downscaled copy back onto the original. */
export function scaleBoxes(boxes: Band[], factor: number): Band[] {
  return boxes.map((b) => ({
    left: Math.round(b.left * factor),
    top: Math.round(b.top * factor),
    width: Math.round(b.width * factor),
    height: Math.round(b.height * factor),
    ink: b.ink,
  }));
}

/**
 * The lines inside one block, for when a whole question is still too hard.
 *
 * The third pass down: page, then question, then line. Each step spends the
 * same image budget on less of the page, so each step is a genuine increase in
 * resolution rather than a repeat of the last look.
 */
export function linesWithin(lines: Band[], block: Band): Band[] {
  return lines.filter(
    (l) => l.top >= block.top - 2 && l.top + l.height <= block.top + block.height + 2,
  );
}

/**
 * Merge adjacent blocks until there are exactly `count` of them.
 *
 * The pixels and the model rarely agree on how many questions a page has, and
 * they do not have to: a question written over two paragraphs shows up as two
 * bands, and on the real 1947 page seven questions came back as eleven. What
 * matters is that crop number four is aimed at question number four, so the
 * bands are merged — closest pair first, because two bands separated by two
 * pixels of white are one question far more often than two — until the counts
 * line up.
 *
 * Merging only goes one way. Bands can be joined; they cannot be split, so a
 * page that segmented into fewer blocks than there are questions is one the
 * caller should not crop at all.
 */
export function mergeToCount(blocks: Band[], count: number): Band[] {
  if (count < 1 || blocks.length <= count) return blocks;
  const merged = [...blocks];
  while (merged.length > count) {
    let closest = 0;
    let smallest = Infinity;
    for (let i = 0; i < merged.length - 1; i++) {
      const gap = merged[i + 1].top - (merged[i].top + merged[i].height);
      if (gap < smallest) {
        smallest = gap;
        closest = i;
      }
    }
    const a = merged[closest];
    const b = merged[closest + 1];
    merged.splice(closest, 2, {
      left: Math.min(a.left, b.left),
      top: Math.min(a.top, b.top),
      width: Math.max(a.left + a.width, b.left + b.width) - Math.min(a.left, b.left),
      height: Math.max(a.top + a.height, b.top + b.height) - Math.min(a.top, b.top),
      ink: a.ink + b.ink,
    });
  }
  return merged;
}
