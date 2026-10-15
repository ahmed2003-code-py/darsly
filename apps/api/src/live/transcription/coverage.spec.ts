import { computeCoverage, GAP_TOLERANCE_MS } from './coverage';

/**
 * A transcript is complete only when its pieces cover what the teacher asked
 * to keep. These are the cases that used to come out READY with a hole.
 */
const T0 = Date.UTC(2026, 9, 15, 9, 0, 0);
const sec = (s: number) => new Date(T0 + s * 1000);
const seq = (s: number) => Math.floor(T0 / 1000) + s;
const piece = (
  startSec: number,
  lenSec: number,
  roomName = 'r1',
  text: string | null = 'words',
) => ({
  roomName,
  seq: seq(startSec),
  durationMs: lenSec * 1000,
  sizeBytes: 1000,
  text,
  error: null,
});
const silent = (startSec: number, lenSec: number, roomName = 'r1') => ({
  roomName,
  seq: seq(startSec),
  durationMs: lenSec * 1000,
  state: 'SILENT',
});
const base = {
  leases: [] as { roomName: string; audioOk: boolean; audioProblem: string | null }[],
  openEndMs: T0 + 3600_000,
  classStartSec: Math.floor(T0 / 1000),
};

describe('transcript coverage', () => {
  const span = { roomName: 'r1', startedAt: sec(0), endedAt: sec(600) };

  it('is complete when pieces (and reported silence) cover the span', () => {
    const c = computeCoverage({
      ...base,
      spans: [span],
      segments: [piece(2, 180), piece(182, 180), piece(362, 120)],
      // 482–600: the tab heard nothing and said so.
      manifest: [silent(482, 118), { ...silent(2, 180), state: 'QUEUED' }],
    });
    expect(c.complete).toBe(true);
    expect(c.gaps).toEqual([]);
    expect(c.coveredSec).toBeGreaterThan(590);
  });

  it('reports a gap where a piece never arrived and the tab never said why', () => {
    const c = computeCoverage({
      ...base,
      spans: [span],
      segments: [piece(2, 180), piece(362, 238)],
      manifest: [silent(600, 1)],
    });
    expect(c.complete).toBe(false);
    expect(c.gaps).toEqual([{ fromSec: 182, toSec: 362 }]);
  });

  it('tolerates seams between pieces and the moment capture takes to start', () => {
    const c = computeCoverage({
      ...base,
      spans: [span],
      segments: [piece(12, 180), piece(192 + GAP_TOLERANCE_MS / 1000 - 3, 395)],
      manifest: [silent(0, 1)],
    });
    expect(c.gaps).toEqual([]);
    expect(c.complete).toBe(true);
  });

  it('counts a piece the tab made but never delivered, and one refused for good', () => {
    const c = computeCoverage({
      ...base,
      spans: [span],
      segments: [piece(2, 598)],
      manifest: [
        { roomName: 'r1', seq: seq(100), durationMs: 30_000, state: 'QUEUED' },
        { roomName: 'r1', seq: seq(200), durationMs: 30_000, state: 'DROPPED' },
        // Delivered: not missing.
        { roomName: 'r1', seq: seq(2), durationMs: 598_000, state: 'QUEUED' },
      ],
    });
    expect(c.missingPieces).toBe(1);
    expect(c.droppedPieces).toBe(1);
    expect(c.complete).toBe(false);
  });

  it('is never complete when the capturing tab said its audio was not running', () => {
    const c = computeCoverage({
      ...base,
      spans: [span],
      segments: [piece(2, 598)],
      manifest: [silent(0, 1)],
      leases: [{ roomName: 'r1', audioOk: false, audioProblem: 'AUDIO_CONTEXT_SUSPENDED' }],
    });
    expect(c.audioProblems).toEqual(['AUDIO_CONTEXT_SUSPENDED']);
    expect(c.complete).toBe(false);
  });

  it('does not count a failed piece as covered', () => {
    const c = computeCoverage({
      ...base,
      spans: [span],
      segments: [piece(2, 300), { ...piece(302, 298), text: null, error: 'BAD_AUDIO' }],
      manifest: [silent(0, 1)],
    });
    expect(c.gaps.length).toBe(1);
  });

  it('judges every run of a reopened class, and each against its own span', () => {
    const c = computeCoverage({
      ...base,
      spans: [span, { roomName: 'r2', startedAt: sec(1200), endedAt: sec(1500) }],
      segments: [piece(2, 598), piece(1202, 100, 'r2')],
      manifest: [silent(0, 1), silent(1302, 198, 'r2')],
    });
    expect(c.complete).toBe(true);
    expect(c.expectedSec).toBe(900);
  });

  it('does not fail a run whose tab sent no manifest (a page from before), but says so', () => {
    const c = computeCoverage({
      ...base,
      spans: [span],
      segments: [piece(2, 100)],
      manifest: [],
    });
    expect(c.unjudgedRuns).toBe(1);
    expect(c.gaps).toEqual([]);
  });

  it('has nothing to judge when nobody asked to keep anything (an older class)', () => {
    const c = computeCoverage({ ...base, spans: [], segments: [piece(0, 60)], manifest: [] });
    expect(c.complete).toBe(true);
    expect(c.expectedSec).toBe(0);
  });

  it('measures an open span to the end of the class', () => {
    const c = computeCoverage({
      ...base,
      openEndMs: T0 + 300_000,
      spans: [{ roomName: 'r1', startedAt: sec(0), endedAt: null }],
      segments: [piece(2, 120)],
      manifest: [silent(0, 1)],
    });
    expect(c.expectedSec).toBe(300);
    expect(c.gaps).toEqual([{ fromSec: 122, toSec: 290 }]);
  });
});
