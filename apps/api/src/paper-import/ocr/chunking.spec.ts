import { chunkLines, growToQuiet, isRuled, ruledLines, tiles } from './chunking';
import { Band } from './segmentation';

const line = (top: number, height = 20): Band => ({ left: 0, width: 500, top, height, ink: 100 });

/**
 * Where crops go, from the pixels alone.
 *
 * The property that matters most is the one the current path lacked: the
 * same lines always give the same crops. Nothing here takes a count from a
 * model, so there is nothing a model can make up.
 */
describe('cutting a page into crops from its lines', () => {
  it('groups lines into paragraphs where the page leaves a real gap', () => {
    // Two questions of three lines, a clear gap between them.
    const lines = [line(0), line(25), line(50), line(140), line(165), line(190)];
    const chunks = chunkLines(lines, 400, { maxLines: 6 });
    expect(chunks.map((c) => c.lines)).toEqual([3, 3]);
  });

  it('never makes one crop out of more lines than the cap, splitting at the widest gap', () => {
    const lines = Array.from({ length: 10 }, (_, i) => line(i * 25 + (i >= 6 ? 8 : 0)));
    const chunks = chunkLines(lines, 400, { maxLines: 6 });
    expect(chunks.every((c) => c.lines <= 6)).toBe(true);
    expect(chunks.reduce((n, c) => n + c.lines, 0)).toBe(10);
  });

  it('leaves out the dark band a scanner puts along the top edge', () => {
    // A 60px-tall band touching the top of the page is the scan border, not text.
    const lines = [line(0, 60), line(120), line(145), line(170)];
    const chunks = chunkLines(lines, 400, { maxLines: 6 });
    expect(chunks[0].top).toBeGreaterThan(60);
  });

  it('folds a sliver into its neighbour instead of paying a call for it', () => {
    const lines = [line(0), line(25), line(50), line(120, 6), line(200), line(225)];
    const chunks = chunkLines(lines, 400, { maxLines: 6 });
    expect(chunks.some((c) => c.lines === 1 && c.height < 15)).toBe(false);
  });

  it('keeps which lines each crop holds, so one line can be looked at again', () => {
    const chunks = chunkLines([line(0), line(25), line(50)], 200, { maxLines: 6 });
    expect(chunks[0].members.map((m) => m.top)).toEqual([0, 25, 50]);
  });

  it('never lets two crops share a line', () => {
    const lines = [line(0), line(25), line(90), line(115), line(180), line(205)];
    const chunks = chunkLines(lines, 300, { maxLines: 2 });
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].top).toBeGreaterThanOrEqual(chunks[i - 1].top + chunks[i - 1].height - 1);
    }
  });

  it('is the same every time for the same page', () => {
    const lines = [line(0), line(25), line(90), line(115), line(180)];
    expect(chunkLines(lines, 300, { maxLines: 6 })).toEqual(
      chunkLines(lines, 300, { maxLines: 6 }),
    );
  });

  it('falls back to overlapping tiles when there are no lines to go by', () => {
    const t = tiles(1000, 20, 6);
    expect(t.length).toBeGreaterThan(1);
    expect(t[1].top).toBeLessThan(t[0].top + t[0].height); // they overlap
    expect(t[t.length - 1].top + t[t.length - 1].height).toBe(1000);
  });
});

describe('notebook paper', () => {
  const rules = Array.from({ length: 20 }, (_, i) => line(40 + i * 40, 6));

  it('recognises evenly pitched thin rules as ruled paper, and prose as not', () => {
    expect(isRuled(rules)).toBe(true);
    const prose = [
      line(0),
      line(25),
      line(50),
      line(130),
      line(155),
      line(260),
      line(285),
      line(310),
    ];
    expect(isRuled(prose)).toBe(false);
  });

  it('turns the spaces between rules into lines, keeping only those with writing in them', () => {
    // Writing in the 3rd and 4th spaces only.
    const written = new Set([2, 3]);
    const lines = ruledLines(rules, 900, (top) =>
      written.has(Math.round((top - 46) / 40) + 1) ? 500 : 5,
    );
    expect(lines.length).toBe(2);
  });
});

describe('growing a crop into a stroke it cut', () => {
  it('moves an edge through inked rows and stops at the first quiet one', () => {
    const rowInk = new Array(100).fill(0);
    for (let y = 20; y < 40; y++) rowInk[y] = 50; // the line
    for (let y = 40; y < 46; y++) rowInk[y] = 20; // a denominator below it
    const grown = growToQuiet({ top: 20, height: 20 }, rowInk, 30);
    expect(grown.top).toBe(20);
    expect(grown.top + grown.height).toBe(46);
  });

  it('never grows further than it is allowed to', () => {
    const rowInk = new Array(100).fill(50);
    const grown = growToQuiet({ top: 40, height: 10 }, rowInk, 5);
    expect(grown).toEqual({ top: 35, height: 20 });
  });
});
