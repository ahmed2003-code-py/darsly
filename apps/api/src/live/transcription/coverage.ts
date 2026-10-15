import { estimateMs } from './stt-guards';

/**
 * Whether a transcript covers the lesson the teacher asked to keep.
 *
 * "Every piece the server received was transcribed" is not the same as "the
 * lesson was transcribed": a piece lost in the browser — an upload given up
 * on, a tab closed mid-piece, audio that never actually ran — left no row on
 * the server, so nothing knew it was missing and the transcript was READY with
 * a hole in it. This compares three things:
 *
 *  - expected: the capture spans (capture-state.ts) — when the teacher had
 *    capture on, which is the teacher's intent, not the recorder's health;
 *  - covered:  the pieces that were transcribed or deliberately skipped, plus
 *    the pieces the capturing tab reported as silent (nothing to send);
 *  - owed:     pieces the tab says it made (the manifest) that never arrived,
 *    or that it gave up on, and any tab that reported its audio not running.
 *
 * Seams between pieces and the moment it takes capture to start are tolerated;
 * anything longer is a gap, reported as minutes and seconds from the start of
 * the class. A run whose tab never sent a manifest (a page from before this
 * existed) cannot be judged for gaps and is reported as such, not failed.
 */

/** Gaps shorter than this are seams between pieces, not lost speech. */
export const GAP_TOLERANCE_MS = 15_000;
/** Capture starts a moment after it is asked for (the page hears of it, claims, starts). */
export const START_GRACE_MS = 20_000;
/** …and the last piece ends a moment before the span is closed. */
export const END_GRACE_MS = 10_000;

export interface CoverageSpan {
  roomName: string;
  startedAt: Date;
  endedAt: Date | null;
}
export interface CoverageSegment {
  roomName: string;
  seq: number;
  durationMs: number | null;
  sizeBytes: number;
  text: string | null;
  error: string | null;
}
export interface CoverageManifest {
  roomName: string;
  seq: number;
  durationMs: number;
  state: string;
}
export interface CoverageLease {
  roomName: string;
  audioOk: boolean;
  audioProblem: string | null;
}

export interface Coverage {
  expectedSec: number;
  coveredSec: number;
  /** Seconds from the start of the class. */
  gaps: { fromSec: number; toSec: number }[];
  /** Pieces the tab made that never arrived. */
  missingPieces: number;
  /** Pieces whose upload was refused for good. */
  droppedPieces: number;
  /** A capturing tab said its audio was not running. */
  audioProblems: string[];
  /** Runs that could not be judged for gaps (no manifest from their tab). */
  unjudgedRuns: number;
  complete: boolean;
}

type Interval = [number, number];

function merge(xs: Interval[]): Interval[] {
  const sorted = xs.filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  const out: Interval[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function subtract(from: Interval[], minus: Interval[]): Interval[] {
  const cut = merge(minus);
  const out: Interval[] = [];
  for (const [a0, b] of from) {
    let a = a0;
    for (const [c, d] of cut) {
      if (d <= a || c >= b) continue;
      if (c > a) out.push([a, c]);
      a = Math.max(a, d);
      if (a >= b) break;
    }
    if (a < b) out.push([a, b]);
  }
  return out;
}

const total = (xs: Interval[]) => xs.reduce((n, [a, b]) => n + (b - a), 0);

export function computeCoverage(x: {
  spans: CoverageSpan[];
  segments: CoverageSegment[];
  manifest: CoverageManifest[];
  leases: CoverageLease[];
  /** Where an open span ends (the class's end, or now). */
  openEndMs: number;
  classStartSec: number;
}): Coverage {
  const runs = new Set(x.spans.map((s) => s.roomName));
  const judged = new Set([...runs].filter((r) => x.manifest.some((m) => m.roomName === r)));
  const expected = merge(
    x.spans.map((s) => [s.startedAt.getTime(), s.endedAt?.getTime() ?? x.openEndMs] as Interval),
  );
  const covered = merge([
    ...x.segments
      .filter((p) => p.text !== null)
      .map((p) => [p.seq * 1000, p.seq * 1000 + estimateMs(p)] as Interval),
    ...x.manifest
      .filter((m) => m.state === 'SILENT')
      .map((m) => [m.seq * 1000, m.seq * 1000 + m.durationMs] as Interval),
  ]);
  // Gaps are judged only for runs whose tab sent a manifest, inside a span
  // trimmed by the start and end grace, and only when longer than a seam.
  const judgedSpans = merge(
    x.spans
      .filter((s) => judged.has(s.roomName))
      .map((s) => {
        const a = s.startedAt.getTime() + START_GRACE_MS;
        const b = (s.endedAt?.getTime() ?? x.openEndMs) - END_GRACE_MS;
        return [a, b] as Interval;
      }),
  );
  const holes = subtract(judgedSpans, covered).filter(([a, b]) => b - a >= GAP_TOLERANCE_MS);
  const arrived = new Set(x.segments.map((p) => `${p.roomName}:${p.seq}`));
  const missingPieces = x.manifest.filter(
    (m) => m.state === 'QUEUED' && !arrived.has(`${m.roomName}:${m.seq}`),
  ).length;
  const droppedPieces = x.manifest.filter(
    (m) => m.state === 'DROPPED' && !arrived.has(`${m.roomName}:${m.seq}`),
  ).length;
  const audioProblems = [
    ...new Set(
      x.leases.filter((l) => !l.audioOk).map((l) => l.audioProblem ?? 'AUDIO_NOT_RUNNING'),
    ),
  ];
  const expectedMs = total(expected);
  const coveredMs = total(subtract(expected, subtract(expected, covered)));
  return {
    expectedSec: Math.round(expectedMs / 1000),
    coveredSec: Math.round(coveredMs / 1000),
    gaps: holes.map(([a, b]) => ({
      fromSec: Math.max(0, Math.round(a / 1000 - x.classStartSec)),
      toSec: Math.max(0, Math.round(b / 1000 - x.classStartSec)),
    })),
    missingPieces,
    droppedPieces,
    audioProblems,
    unjudgedRuns: runs.size - judged.size,
    complete: !holes.length && !missingPieces && !droppedPieces && !audioProblems.length,
  };
}
