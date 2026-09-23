import { linesWithin, mergeToCount, scaleBoxes, segment } from './segmentation';
import { FIXTURES, renderFixture } from './eval/fixtures';
import { segmentationAccuracy } from './eval/metrics';

const sharp = require('sharp');
const fixture = (id: string) => FIXTURES.find((f) => f.id === id)!;

async function mask(id: string) {
  const png = await renderFixture(fixture(id).render);
  const small = await sharp(png).greyscale().resize({ width: 520 }).raw().toBuffer({
    resolveWithObject: true,
  });
  return { raw: new Uint8Array(small.data), w: small.info.width, h: small.info.height };
}

/**
 * Cutting a page into questions.
 *
 * Not for tidiness — for resolution. A whole A4 page inside the model's image
 * budget is about fifty pixels per line of text; one question from that page,
 * at the *same* budget, is several times that for the same number of image
 * tokens. Segmentation is how that magnification gets spent where it is
 * needed, so a box in the wrong place is worse than no box at all.
 */
describe('finding the questions on a page', () => {
  jest.setTimeout(30_000);

  it('finds seven questions on a page of seven', async () => {
    const { raw, w, h } = await mask('dense-seven');
    const result = segment(raw, w, h);
    expect(result.confident).toBe(true);
    expect(segmentationAccuracy(7, result.blocks.length)).toBeGreaterThan(0.7);
  });

  it('finds three on a page of three', async () => {
    const { raw, w, h } = await mask('clean-print-ar');
    const result = segment(raw, w, h);
    expect(result.blocks.length).toBeGreaterThanOrEqual(2);
    expect(result.blocks.length).toBeLessThanOrEqual(5);
  });

  it('returns the blocks in reading order, top to bottom, without overlapping', async () => {
    const { raw, w, h } = await mask('dense-seven');
    const { blocks } = segment(raw, w, h);
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i].top).toBeGreaterThan(blocks[i - 1].top);
    }
  });

  it('keeps every block inside the page', async () => {
    // A box that runs off the edge crops to nothing and wastes a call.
    const { raw, w, h } = await mask('dense-seven');
    for (const b of segment(raw, w, h).blocks) {
      expect(b.top).toBeGreaterThanOrEqual(0);
      expect(b.top + b.height).toBeLessThanOrEqual(h);
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.left + b.width).toBeLessThanOrEqual(w);
    }
  });

  it('pads each block, so a descender or a margin number is not cut off', async () => {
    const { raw, w, h } = await mask('clean-print-ar');
    const result = segment(raw, w, h);
    // Full width on purpose: the question number sits in the margin and the
    // working sits to one side.
    expect(result.blocks.every((b) => b.left === 0 && b.width === w)).toBe(true);
    expect(result.blocks.every((b) => b.height > result.textHeightPx)).toBe(true);
  });

  it('finds more lines than blocks — the third pass down', async () => {
    // Page, then question, then line. Each step spends the same image budget
    // on less of the page, so each is a real increase in resolution.
    const { raw, w, h } = await mask('dense-seven');
    const result = segment(raw, w, h);
    expect(result.lines.length).toBeGreaterThanOrEqual(result.blocks.length);
  });

  it('says it is not confident about a page it could not divide', async () => {
    // A blank page divides into nothing, and the caller should read it whole
    // rather than crop a box it invented.
    const blank = new Uint8Array(200 * 300).fill(250);
    const result = segment(blank, 200, 300);
    expect(result.confident).toBe(false);
    expect(result.blocks).toHaveLength(0);
  });

  it('refuses to call a page that fragmented a segmentation', async () => {
    // Noise segments into hundreds of bands; cropping each would cost more
    // than reading the page and would aim every crop at nothing.
    const noise = new Uint8Array(200 * 400);
    for (let i = 0; i < noise.length; i++) noise[i] = i % 7 === 0 ? 20 : 250;
    expect(segment(noise, 200, 400, { maxBlocks: 10 }).confident).toBe(false);
  });

  it('scales boxes onto the original, which is where the crop is taken from', async () => {
    const { raw, w, h } = await mask('dense-seven');
    const { blocks } = segment(raw, w, h);
    const scaled = scaleBoxes(blocks, 2.5);
    expect(scaled[0].top).toBe(Math.round(blocks[0].top * 2.5));
    expect(scaled[0].width).toBe(Math.round(blocks[0].width * 2.5));
  });

  it('finds the lines inside one block and none from its neighbours', async () => {
    const { raw, w, h } = await mask('dense-seven');
    const result = segment(raw, w, h);
    const inside = linesWithin(result.lines, result.blocks[0]);
    expect(inside.length).toBeGreaterThan(0);
    for (const l of inside) {
      expect(l.top).toBeGreaterThanOrEqual(result.blocks[0].top - 2);
      expect(l.top + l.height).toBeLessThanOrEqual(
        result.blocks[0].top + result.blocks[0].height + 2,
      );
    }
  });

  it('still segments a page lit unevenly', async () => {
    // The local threshold is what makes this possible: one global cut on a
    // shadowed page calls the dark corner ink and the page one giant block.
    const { raw, w, h } = await mask('low-light');
    const result = segment(raw, w, h);
    expect(result.blocks.length).toBeGreaterThanOrEqual(2);
  });

  it('separates lines on a page whose gaps are never empty', async () => {
    // The failure that rewrote the thresholds. A photographed manuscript's
    // gaps carry paper grain — the profile never touches zero — and its scan
    // has a dark top edge that no line of text comes near. Against a cut set
    // as a fraction of the busiest row, that page became one band and
    // reported a line of text 1601 pixels tall.
    const { raw, w, h } = await mask('handwriting-faded');
    const result = segment(raw, w, h);
    expect(result.textHeightPx).toBeGreaterThan(2);
    expect(result.textHeightPx).toBeLessThan(h / 4);
    expect(result.blocks.length).toBeGreaterThan(1);
  });

  it('is not thrown by a bright edge at the top of a scan', async () => {
    const { raw, w, h } = await mask('dense-seven');
    const withEdge = Uint8Array.from(raw);
    // A dark band across the first rows, as a scanner leaves.
    for (let x = 0; x < w * 3; x++) withEdge[x] = 5;
    const before = segment(raw, w, h);
    const after = segment(withEdge, w, h);
    expect(Math.abs(after.blocks.length - before.blocks.length)).toBeLessThanOrEqual(2);
  });
});

describe('lining the bands up with the questions', () => {
  const band = (top: number, height: number) => ({ left: 0, top, width: 100, height, ink: 10 });

  it('merges extra bands down to the number of questions there are', () => {
    // On the real 1947 page, seven questions segmented into eleven bands: a
    // question written over two paragraphs is two bands. What matters is that
    // crop four is aimed at question four.
    const merged = mergeToCount([band(0, 10), band(12, 10), band(60, 10), band(120, 10)], 3);
    expect(merged).toHaveLength(3);
    // The two closest together are the ones that were joined.
    expect(merged[0].top).toBe(0);
    expect(merged[0].height).toBe(22);
  });

  it('keeps them in reading order and covering the same ground', () => {
    const bands = [band(0, 10), band(30, 10), band(60, 10), band(90, 10)];
    const merged = mergeToCount(bands, 2);
    expect(merged[0].top).toBeLessThan(merged[1].top);
    expect(merged[merged.length - 1].top + merged[merged.length - 1].height).toBe(100);
  });

  it('leaves them alone when there are already few enough', () => {
    const bands = [band(0, 10), band(30, 10)];
    expect(mergeToCount(bands, 5)).toBe(bands);
    expect(mergeToCount(bands, 2)).toBe(bands);
  });
});
