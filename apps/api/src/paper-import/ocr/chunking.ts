import { Band } from './segmentation';

/**
 * Cutting a page into crops from its own lines.
 *
 * The current path cut the page into as many crops as the cheap model said it
 * saw regions — and on a handwritten page the cheap model saw nothing: it
 * returned five regions of pure [UNCLEAR], the page's thirteen blocks were
 * merged down to five, and one crop held questions one to three while two
 * others were empty strips thirty-five times wider than tall. What the model
 * got to read depended on a number it had made up, so the same page came back
 * with two questions one run and seven the next.
 *
 * Here the crops come from the pixels alone: the lines the segmenter found,
 * grouped where the page leaves more white between them than it does inside
 * a paragraph, capped in size, with slivers folded into their neighbours and
 * the scanner's dark border left out. No model is asked anything to decide
 * where a crop goes, so the same page is always cut the same way.
 */

export interface Chunk {
  top: number;
  height: number;
  /** Lines of text inside, which is what validation measures output against. */
  lines: number;
  /** How it was formed, for the log. */
  why: string;
  /** The lines inside, top to bottom — so one line can be looked at again
   *  closely without re-reading the whole crop. */
  members: { top: number; height: number }[];
}

export interface ChunkOptions {
  maxLines: number;
}

/**
 * Notebook paper.
 *
 * On ruled paper the row profile peaks on the printed rules, not on the
 * writing, and the segmenter reports one thin "line" per rule — thirty-seven
 * of them, evenly spaced, on a page with fifteen lines of handwriting. Taking
 * the rules out does not work for Arabic: a row through connected script is
 * itself one long run of ink, and removing long runs removed the text of a
 * 1927 exam along with them.
 *
 * So the rules are used instead of fought: many thin bands at an even pitch
 * is a ruled page, and every line of writing lives in the space between two
 * rules. Those spaces become the lines, and the ones with no ink in them are
 * the paragraph breaks.
 */
export function isRuled(bands: Band[]): boolean {
  if (bands.length < 8) return false;
  const sorted = [...bands].sort((a, b) => a.top - b.top);
  const pitches = sorted.slice(1).map((b, i) => b.top - sorted[i].top);
  const pitch = median(pitches);
  if (!pitch) return false;
  // Even spacing: most pitches within 25% of the typical one. A page of text
  // lines is uneven — paragraph gaps, question gaps, headings.
  const even = pitches.filter((p) => Math.abs(p - pitch) <= pitch * 0.25).length / pitches.length;
  // Thin: a rule is a small fraction of the space it rules off.
  const thin = median(sorted.map((b) => b.height)) <= pitch * 0.55;
  return even >= 0.75 && thin;
}

/**
 * The writing lines of a ruled page: the space above each rule, down to and
 * including the rule (Arabic sits on it; descenders cross it), kept when it
 * carries ink beyond the paper's grain.
 */
export function ruledLines(
  rules: Band[],
  pageHeight: number,
  inkIn: (top: number, bottom: number) => number,
): Band[] {
  const sorted = [...rules].sort((a, b) => a.top - b.top);
  const pitch = median(sorted.slice(1).map((b, i) => b.top - sorted[i].top));
  const spaces: Band[] = [];
  for (let i = 0; i <= sorted.length; i++) {
    const below = sorted[i];
    const above = sorted[i - 1];
    const top = above ? above.top + above.height : Math.max(0, (below?.top ?? 0) - pitch);
    const bottom = below ? below.top + below.height : Math.min(pageHeight, top + pitch);
    if (bottom - top < 2) continue;
    spaces.push({ left: 0, width: 0, top, height: bottom - top, ink: inkIn(top, bottom) });
  }
  const peak = Math.max(0, ...spaces.map((s) => s.ink));
  return spaces.filter((s) => s.ink >= peak * 0.2);
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * Lines → crops.
 *
 * Coordinates are whatever the lines are in; the caller scales. `pageHeight`
 * is in the same units.
 */
export function chunkLines(lines: Band[], pageHeight: number, opts: ChunkOptions): Chunk[] {
  if (!lines.length) return [];
  const sorted = [...lines].sort((a, b) => a.top - b.top);
  const lineH = median(sorted.map((l) => l.height)) || 1;

  // The scanner's border and the shadow at a photograph's edge: a band that
  // touches the very top or bottom of the page and is taller than a line of
  // text. Reading it is a call that returns nothing.
  const edge = Math.max(2, pageHeight * 0.01);
  const text = sorted.filter((l) => {
    const atEdge = l.top <= edge || l.top + l.height >= pageHeight - edge;
    return !(atEdge && l.height > lineH * 1.2);
  });
  if (!text.length) return [];

  const gaps = text.slice(1).map((l, i) => l.top - (text[i].top + text[i].height));
  const typicalGap = Math.max(1, median(gaps));
  // More white than a paragraph leaves between its own lines. The floor keeps
  // a page with no gaps at all from splitting at every line.
  const boundary = Math.max(typicalGap * 2.2, lineH * 0.6);

  // 1. Paragraphs: split where the page leaves a real gap.
  const groups: Band[][] = [[text[0]]];
  for (let i = 1; i < text.length; i++) {
    if (gaps[i - 1] > boundary) groups.push([text[i]]);
    else groups[groups.length - 1].push(text[i]);
  }

  // 2. No crop longer than maxLines: a long run is split at its widest gap,
  //    which is where a question most likely ends.
  const capped: Band[][] = [];
  const split = (g: Band[]) => {
    if (g.length <= opts.maxLines) return void capped.push(g);
    let at = Math.floor(g.length / 2);
    let widest = -1;
    for (let i = 1; i < g.length; i++) {
      // Only split points that leave neither side too small to be worth a call.
      if (i < 2 || g.length - i < 2) continue;
      const gap = g[i].top - (g[i - 1].top + g[i - 1].height);
      if (gap > widest) {
        widest = gap;
        at = i;
      }
    }
    split(g.slice(0, at));
    split(g.slice(at));
  };
  groups.forEach(split);

  // 3. A sliver — one line much thinner than text, a stray mark, a ruler
  //    stub — is not worth a call of its own; it joins the nearer neighbour.
  const merged: Band[][] = [];
  for (let i = 0; i < capped.length; i++) {
    const g = capped[i];
    const sliver = g.length === 1 && g[0].height < lineH * 0.55;
    if (!sliver || capped.length === 1) {
      merged.push(g);
      continue;
    }
    const prev = merged[merged.length - 1];
    const next = capped[i + 1];
    const gapPrev = prev ? g[0].top - (prev.at(-1)!.top + prev.at(-1)!.height) : Infinity;
    const gapNext = next ? next[0].top - (g[0].top + g[0].height) : Infinity;
    if (prev && gapPrev <= gapNext) prev.push(...g);
    else if (next) next.unshift(...g);
    else merged.push(g);
  }

  // 3b. Many small paragraphs make many small crops, and every crop is a
  //     call — a notebook page with a blank rule between its lines came out
  //     as fourteen two-line crops. Neighbours are folded together while the
  //     result stays within maxLines and the white between them is no more
  //     than a couple of lines: a crop may hold two short questions, which
  //     structuring separates; it never holds a page.
  for (let i = 0; i < merged.length - 1;) {
    const a = merged[i];
    const b = merged[i + 1];
    const gap = b[0].top - (a.at(-1)!.top + a.at(-1)!.height);
    if (a.length + b.length <= opts.maxLines && gap <= lineH * 2.2) {
      merged.splice(i, 2, [...a, ...b]);
    } else {
      i++;
    }
  }

  // 4. Boxes: whole lines, padded into the white around them but never past
  //    halfway to the next crop, so no line appears in two crops.
  return merged.map((g, i) => {
    const first = g[0];
    const last = g[g.length - 1];
    const prevEnd = i > 0 ? merged[i - 1].at(-1)!.top + merged[i - 1].at(-1)!.height : 0;
    const nextTop = i < merged.length - 1 ? merged[i + 1][0].top : pageHeight;
    const padUp = Math.min(lineH * 0.5, Math.max(0, (first.top - prevEnd) / 2));
    const padDown = Math.min(lineH * 0.5, Math.max(0, (nextTop - (last.top + last.height)) / 2));
    const top = Math.max(0, first.top - padUp);
    const bottom = Math.min(pageHeight, last.top + last.height + padDown);
    return {
      top: Math.round(top),
      height: Math.round(bottom - top),
      lines: g.length,
      members: g.map((l) => ({ top: l.top, height: l.height })),
      why: g.length > opts.maxLines ? 'capped' : 'paragraph',
    };
  });
}

/**
 * Crops for a page the segmenter could not divide: horizontal tiles of a few
 * lines each, overlapping by one line so nothing is cut through the middle of
 * every tile. Worse than real lines, far better than one look at the whole
 * page or a count invented by a model.
 */
export function tiles(pageHeight: number, lineH: number, maxLines: number): Chunk[] {
  const size = Math.max(lineH * 2, lineH * maxLines * 1.6);
  const overlap = lineH;
  const out: Chunk[] = [];
  for (let top = 0; top < pageHeight; top += size - overlap) {
    const height = Math.min(size, pageHeight - top);
    if (height < lineH) break;
    out.push({
      top: Math.round(top),
      height: Math.round(height),
      lines: maxLines,
      members: [],
      why: 'tile',
    });
    if (top + height >= pageHeight) break;
  }
  return out;
}

/**
 * Push a crop's edges out while the row just outside still carries ink.
 *
 * A line band is where most of a line's ink is, not all of it: a fraction's
 * denominator, a subscript, a long descender and a teacher's note under the
 * line all sit below it. The first real crop of a 1927 exam cut "٦ / ٦-٢" in
 * half at the fraction bar. An edge is moved only through rows with ink and
 * stops at the first quiet row, so it grows into the stroke that was cut and
 * not into the next line.
 */
export function growToQuiet(
  chunk: { top: number; height: number },
  rowInk: ArrayLike<number>,
  maxGrow: number,
): { top: number; height: number } {
  const n = rowInk.length;
  const inside: number[] = [];
  for (let y = Math.max(0, chunk.top); y < Math.min(n, chunk.top + chunk.height); y++) {
    inside.push(rowInk[y]);
  }
  const busy = median(inside.filter((v) => v > 0));
  const quiet = Math.max(1, busy * 0.08);
  let top = chunk.top;
  let bottom = chunk.top + chunk.height;
  for (let g = 0; g < maxGrow && top > 0 && rowInk[top - 1] > quiet; g++) top--;
  for (let g = 0; g < maxGrow && bottom < n && rowInk[bottom] > quiet; g++) bottom++;
  return { top, height: bottom - top };
}
