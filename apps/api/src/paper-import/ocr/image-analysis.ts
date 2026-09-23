/**
 * What is actually wrong with this photograph, measured before anything is
 * done to it.
 *
 * The pipeline this replaces applied the same four operations to every image —
 * rotate, greyscale, resize, encode — whatever the image was. A clean 300dpi
 * scan and a phone snapshot of a faded 1947 manuscript taken at an angle in
 * bad light went through identically, and the manuscript came back unreadable.
 *
 * Everything here is arithmetic over a small greyscale copy: no model, no
 * network, no cost. It runs in a few milliseconds and decides which of the
 * expensive things downstream are worth doing.
 */

/** The small copy everything is measured on. Big enough for the measurements
 *  to mean something, small enough that thirty-three shear projections is a
 *  few milliseconds rather than a few seconds. */
const ANALYSIS_WIDTH = 520;

export interface ImageQuality {
  width: number;
  height: number;
  /** 0–1. Laplacian energy, normalised. Below ~0.15 the image is soft enough
   *  that upscaling will not recover strokes that were never captured. */
  sharpness: number;
  /** 0–1. How far ink and paper are apart. Faded ink on aged paper is low. */
  contrast: number;
  /** Fraction of the page that is ink. Tells a dense manuscript from a form. */
  inkCoverage: number;
  /**
   * 0–1. How much the *paper* brightness varies across the page.
   *
   * A scan is flat: the paper is the same white everywhere. A photograph has a
   * gradient — brighter near the window, darker under the hand holding it —
   * and a single threshold then eats the text in the dark corner.
   */
  lighting: number;
  /** Degrees, positive = clockwise. Estimated from the text's own rows. */
  skewDegrees: number;
  /** Median height of a line of text, in pixels of the ORIGINAL image. The
   *  number that decides whether this is "low resolution handwriting". */
  textHeightPx: number;
  /** True when the strokes are too few pixels tall for a model to resolve. */
  lowResolution: boolean;
  /** True when the image is effectively already grey — no colour to preserve. */
  monochrome: boolean;
}

/** Which of the expensive operations are worth doing to this particular page. */
export interface VariantPlan {
  deskew: boolean;
  /** Flat-field: divide out the lighting gradient so the paper is one white. */
  flatten: boolean;
  upscale: boolean;
  /** Stretch the histogram. Helps faded ink, hurts a clean scan. */
  enhanceContrast: boolean;
  denoise: boolean;
  /** Keep the colour. Blue ink on yellow paper separates in colour and
   *  collapses in grey, and colour costs nothing — image tokens come from the
   *  pixel dimensions, not from the channels. */
  keepColour: boolean;
  /** Send a second, differently-processed copy alongside the first, so the
   *  model can compare. Only worth the tokens when the page is hard. */
  sendSecondVariant: boolean;
}

/** Thresholds, in one place, so the reasoning is legible and tunable. */
export const QUALITY_THRESHOLDS = {
  /** Below this the strokes themselves are soft — measured on the ink, not
   *  on the page, because a mostly-blank page has no edges to measure. */
  softSharpness: 0.3,
  /** Ink within this much of its own paper is faded enough that a stretch
   *  helps. Crisp print separates by well over half the range. */
  lowContrast: 0.4,
  /** Above this the paper brightness varies enough to matter. */
  unevenLighting: 0.18,
  /** Past this many degrees, rows of text stop lining up with pixel rows. */
  skewDegrees: 0.8,
  /**
   * A line of text shorter than this cannot be read reliably at any budget.
   *
   * Measured against the ink band rather than the font size, so it is smaller
   * than a typeface's nominal height: 38pt text on a 1240px page measures
   * around 24 here. Below 18 the strokes are a few pixels wide and enlarging
   * is the only thing that can help.
   */
  smallTextPx: 18,
  /** Colour worth keeping only if the channels actually differ. */
  colourSpread: 6,
} as const;

/**
 * Measure a page.
 *
 * `raw` is a single-channel greyscale buffer of `width * height` bytes —
 * whatever the caller got from sharp — plus the dimensions of the image it was
 * downscaled from, so the measurements come back in the original's units.
 */
export function analyse(
  raw: Uint8Array,
  small: { width: number; height: number },
  original: { width: number; height: number; channelSpread: number },
): ImageQuality {
  const scale = original.width / small.width;
  // Built once and shared: every measurement below is about the ink, and
  // deciding twice what counts as ink is how two of them come to disagree.
  const mask = inkMask(raw, small.width, small.height);
  const sharpness = laplacianEnergy(raw, small.width, small.height, mask);
  const contrast = inkSeparation(raw, small.width, small.height, mask);
  const inkCoverage = inkFraction(mask);
  const lighting = lightingUnevenness(raw, small.width, small.height);
  const skewDegrees = estimateSkewFromMask(mask, small.width, small.height);
  const textHeightSmall = textHeightFromMask(mask, small.width, small.height, skewDegrees);
  const textHeightPx = Math.round(textHeightSmall * scale);

  return {
    width: original.width,
    height: original.height,
    sharpness,
    contrast,
    inkCoverage,
    lighting,
    skewDegrees,
    textHeightPx,
    lowResolution: textHeightPx > 0 && textHeightPx < QUALITY_THRESHOLDS.smallTextPx,
    monochrome: original.channelSpread < QUALITY_THRESHOLDS.colourSpread,
  };
}

/**
 * Decide what to do about it.
 *
 * Deliberately conservative. Every operation here loses information as well as
 * gaining it, and a clean scan that is put through contrast stretching,
 * denoising and flat-fielding comes out worse than it went in. Nothing happens
 * unless the measurement says it should.
 */
export function decideVariants(q: ImageQuality): VariantPlan {
  const faded = q.contrast < QUALITY_THRESHOLDS.lowContrast;
  const uneven = q.lighting > QUALITY_THRESHOLDS.unevenLighting;
  const soft = q.sharpness < QUALITY_THRESHOLDS.softSharpness;
  return {
    deskew: Math.abs(q.skewDegrees) >= QUALITY_THRESHOLDS.skewDegrees,
    flatten: uneven,
    // Only when the strokes are genuinely small. Upscaling a page that is
    // already big enough invents pixels and costs a bigger crop budget for
    // nothing.
    upscale: q.lowResolution,
    enhanceContrast: faded,
    // Denoising a sharp page erases the thin parts of handwriting. It is for
    // the soft, speckled scan only.
    denoise: soft && faded,
    keepColour: !q.monochrome,
    // A second copy doubles the image tokens for that call, so it is reserved
    // for the pages where one look is demonstrably not enough.
    sendSecondVariant: (faded && uneven) || (soft && q.lowResolution),
  };
}

// ── measurements ───────────────────────────────────────────────────────────
//
// Everything below works off a LOCAL estimate of the paper rather than a
// single threshold over the page. That is the whole difference between these
// numbers meaning something and not: a photograph with a shadow across one
// corner has paper at 240 in the light and 120 in the dark, and one global
// threshold either calls the shadow ink or calls the ink in the shadow paper.
// The first is what happened — a shadowed page measured as 94% ink and a line
// of text 940 pixels tall.

/** How many tiles across the page the background is estimated on. Coarse
 *  enough to be the lighting, fine enough to follow a gradient. */
const BACKGROUND_TILES = 8;

/** The paper's own brightness, per tile — the 85th percentile, which is paper
 *  wherever there is more paper than ink, and that is everywhere. */
function backgroundGrid(raw: Uint8Array, w: number, h: number): Float64Array {
  const grid = new Float64Array(BACKGROUND_TILES * BACKGROUND_TILES);
  for (let ty = 0; ty < BACKGROUND_TILES; ty++) {
    for (let tx = 0; tx < BACKGROUND_TILES; tx++) {
      const x0 = Math.floor((tx * w) / BACKGROUND_TILES);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * w) / BACKGROUND_TILES));
      const y0 = Math.floor((ty * h) / BACKGROUND_TILES);
      const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * h) / BACKGROUND_TILES));
      const tile: number[] = [];
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) tile.push(raw[y * w + x]);
      tile.sort((a, b) => a - b);
      grid[ty * BACKGROUND_TILES + tx] = tile[Math.floor(tile.length * 0.85)] ?? 255;
    }
  }
  return grid;
}

/** The paper's brightness at one pixel, interpolated between tiles so the
 *  threshold does not step at tile boundaries. */
function backgroundAt(grid: Float64Array, w: number, h: number, x: number, y: number): number {
  const fx = Math.min(BACKGROUND_TILES - 1, (x / w) * BACKGROUND_TILES);
  const fy = Math.min(BACKGROUND_TILES - 1, (y / h) * BACKGROUND_TILES);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(BACKGROUND_TILES - 1, x0 + 1);
  const y1 = Math.min(BACKGROUND_TILES - 1, y0 + 1);
  const dx = fx - x0;
  const dy = fy - y0;
  const at = (gx: number, gy: number) => grid[gy * BACKGROUND_TILES + gx];
  return (
    at(x0, y0) * (1 - dx) * (1 - dy) +
    at(x1, y0) * dx * (1 - dy) +
    at(x0, y1) * (1 - dx) * dy +
    at(x1, y1) * dx * dy
  );
}

/**
 * Which pixels are ink, judged against the paper beside them.
 *
 * Shared by every measurement and by the segmenter, so they cannot disagree
 * about what a row of text is.
 */
export function inkMask(raw: Uint8Array, w: number, h: number): Uint8Array {
  const grid = backgroundGrid(raw, w, h);
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const paper = backgroundAt(grid, w, h, x, y);
      // 18% darker than its own paper. Loose enough for faded pencil, tight
      // enough that paper texture is not text.
      mask[y * w + x] = raw[y * w + x] < paper * 0.82 ? 1 : 0;
    }
  }
  return mask;
}

/**
 * How far ink and paper are apart, where they actually are.
 *
 * Global standard deviation measured the wrong thing: a page is mostly white,
 * so a page of crisp black print and a page of faded pencil both come out near
 * 0.03 and the number says nothing. This compares the ink to the paper next to
 * it, which is the thing that decides whether a stretch would help.
 */
function inkSeparation(raw: Uint8Array, w: number, h: number, mask: Uint8Array): number {
  const grid = backgroundGrid(raw, w, h);
  const inks: number[] = [];
  const papers: number[] = [];
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = y * w + x;
      if (mask[i]) inks.push(raw[i]);
      else papers.push(backgroundAt(grid, w, h, x, y));
    }
  }
  if (inks.length < 20 || !papers.length) return 0;
  inks.sort((a, b) => a - b);
  papers.sort((a, b) => a - b);
  const ink = inks[Math.floor(inks.length * 0.3)];
  const paper = papers[Math.floor(papers.length * 0.5)];
  return Math.max(0, Math.min(1, (paper - ink) / 255));
}

/**
 * Focus, measured on the strokes rather than on the page.
 *
 * Laplacian energy over a mostly-blank page is mostly zero however sharp the
 * text is, which made every fixture read as "soft". Averaged over the ink
 * only, the number means what it is supposed to mean.
 */
function laplacianEnergy(raw: Uint8Array, w: number, h: number, mask: Uint8Array): number {
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      const v = 4 * raw[i] - raw[i - 1] - raw[i + 1] - raw[i - w] - raw[i + w];
      sumSq += v * v;
      n++;
    }
  }
  if (n < 20) return 0;
  return Math.min(1, Math.sqrt(sumSq / n) / 150);
}

function inkFraction(mask: Uint8Array): number {
  let ink = 0;
  for (let i = 0; i < mask.length; i++) ink += mask[i];
  return ink / mask.length;
}

/**
 * How much the paper's own brightness varies across the page.
 *
 * Measured from the background estimate — the paper, not the ink — because the
 * ink is supposed to be dark and its darkness says nothing about the lighting.
 */
function lightingUnevenness(raw: Uint8Array, w: number, h: number): number {
  const grid = backgroundGrid(raw, w, h);
  const values = Array.from(grid).filter((v) => v > 0);
  if (values.length < 4) return 0;
  values.sort((a, b) => a - b);
  // Trimmed, so one dark corner of a scan's edge is not the whole story.
  const lo = values[Math.floor(values.length * 0.1)];
  const hi = values[Math.floor(values.length * 0.9)];
  return Math.max(0, (hi - lo) / 255);
}

/**
 * The angle the text is lying at.
 *
 * Rows of text make a strongly peaked horizontal profile when they line up
 * with pixel rows and a flat one when they do not, so the angle that maximises
 * the profile's variance is the angle the text is at. Done by shearing the row
 * index rather than by rotating the image thirty-three times, which is the
 * difference between milliseconds and seconds.
 */
export function estimateSkewFromMask(
  mask: Uint8Array,
  w: number,
  h: number,
  span = 8,
  step = 0.25,
): number {
  const scoreAt = (deg: number): number => {
    const tan = Math.tan((deg * Math.PI) / 180);
    const profile = new Float64Array(h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!mask[y * w + x]) continue;
        const row = Math.round(y - (x - w / 2) * tan);
        if (row >= 0 && row < h) profile[row] += 1;
      }
    }
    /**
     * How sharply the profile steps between rows.
     *
     * The obvious objective is the sum of the profile's squares, and it
     * barely works: on a page with five lines of text the correct angle
     * scored 1.6% above flat, which is inside the noise. What a rotated page
     * actually destroys is the *edge* between a line of text and the white
     * above it, so summing the squared differences between adjacent rows
     * measures the thing that is being lost. The same page then scores 24%
     * above flat, which is a signal rather than a hint.
     */
    let score = 0;
    for (let i = 1; i < h; i++) {
      const d = profile[i] - profile[i - 1];
      score += d * d;
    }
    return score;
  };

  let best = 0;
  let bestScore = -1;
  for (let deg = -span; deg <= span; deg += step) {
    const score = scoreAt(deg);
    if (score > bestScore) {
      bestScore = score;
      best = deg;
    }
  }

  /**
   * A straight page still has a best angle, and it is never exactly zero.
   *
   * Lines of text start and end in ragged places, so the projection is always
   * a fraction of a degree happier somewhere off-centre — every straight
   * fixture here measured about −0.75°, and rotating a straight page by that
   * is a resample that costs sharpness and buys nothing. So the winner has to
   * beat lying flat by a real margin before it is believed.
   *
   * Five percent, measured: a genuinely skewed page clears it by twenty, and
   * a straight one never gets within one.
   */
  const flat = scoreAt(0);
  if (bestScore < flat * 1.05) return 0;
  return Number(best.toFixed(2));
}

/** Kept for callers that only have pixels. */
export function estimateSkew(raw: Uint8Array, w: number, h: number, span = 8): number {
  return estimateSkewFromMask(inkMask(raw, w, h), w, h, span);
}

/**
 * How tall a line of text is, which is what "low resolution" actually means.
 *
 * A 4000px photograph of a page with six-pixel strokes is not high resolution;
 * a 1200px scan of large handwriting is not low. The number that matters is
 * the height of a line, so that is what is measured.
 */
export function estimateTextHeight(raw: Uint8Array, w: number, h: number, skewDegrees = 0): number {
  return textHeightFromMask(inkMask(raw, w, h), w, h, skewDegrees);
}

export function textHeightFromMask(
  mask: Uint8Array,
  w: number,
  h: number,
  skewDegrees = 0,
): number {
  const rows = profileFromMask(mask, w, h, skewDegrees);
  const runs = textRuns(rows);
  if (!runs.length) return 0;
  runs.sort((a, b) => a - b);
  return runs[Math.floor(runs.length / 2)];
}

/**
 * Where a row of text starts and stops, on a profile that never reaches zero.
 *
 * This is the function the whole segmenter turned out to rest on, and the
 * first version of it did not survive contact with a real page. On the clean
 * rendered fixtures the gaps between lines were empty, so "a row with ink in
 * it is text" worked. On a photographed 1947 manuscript the gaps carry 25
 * ink-pixels of paper grain and bleed-through, the busiest row carries 90 —
 * and the first row of all carries 520, because the scan has a dark edge.
 * Against that, a threshold set as a fraction of the busiest row put the
 * entire page in one band and reported a line of text 1601 pixels tall.
 *
 * So the profile is measured against itself: the pedestal is subtracted, the
 * peak is taken from a percentile rather than the maximum so one dark edge
 * cannot set the scale, and the whole thing is smoothed first so a single
 * speckled row does not end a line.
 */
export function textRuns(profile: Float64Array): number[] {
  const { cut, smoothed } = profileCut(profile);
  const runs: number[] = [];
  let run = 0;
  for (const v of smoothed) {
    if (v >= cut) run++;
    else if (run) {
      runs.push(run);
      run = 0;
    }
  }
  if (run) runs.push(run);
  return runs;
}

/**
 * The level that separates a line of text from the white between lines, and
 * the smoothed profile it applies to.
 *
 * Exported because the segmenter needs exactly the same answer: two places
 * deciding separately what counts as a row of text is two places that come to
 * disagree, and the boxes then stop lining up with the lines.
 */
export function profileCut(profile: Float64Array): { cut: number; smoothed: Float64Array } {
  const h = profile.length;
  if (!h) return { cut: 1, smoothed: profile };

  // A three-row moving average. A page of handwriting has rows that happen to
  // be empty in the middle of a word; smoothing stops each one ending a line.
  const smoothed = new Float64Array(h);
  for (let i = 0; i < h; i++) {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - 1); j <= Math.min(h - 1, i + 1); j++) {
      sum += profile[j];
      n++;
    }
    smoothed[i] = sum / n;
  }

  const sorted = Array.from(smoothed).sort((a, b) => a - b);
  // The pedestal: what an empty row of this page still carries.
  const baseline = sorted[Math.floor(h * 0.15)] ?? 0;
  // The peak, from a percentile rather than the maximum — a scan's dark top
  // edge is not a line of text and must not set the scale for one.
  const peak = sorted[Math.floor(h * 0.92)] ?? baseline + 1;
  const range = Math.max(1, peak - baseline);
  return { cut: baseline + range * 0.35, smoothed };
}

/** Ink per row, optionally along a sheared axis. */
export function profileFromMask(
  mask: Uint8Array,
  w: number,
  h: number,
  skewDegrees = 0,
): Float64Array {
  const tan = Math.tan((skewDegrees * Math.PI) / 180);
  const profile = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const row = Math.round(y - (x - w / 2) * tan);
      if (row >= 0 && row < h) profile[row] += 1;
    }
  }
  return profile;
}

export function rowProfile(raw: Uint8Array, w: number, h: number, skewDegrees = 0): Float64Array {
  return profileFromMask(inkMask(raw, w, h), w, h, skewDegrees);
}

export const ANALYSIS_TARGET_WIDTH = ANALYSIS_WIDTH;
