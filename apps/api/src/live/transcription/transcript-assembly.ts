import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { assembleTranscript, sttUsdPerMin } from './lesson-transcription';
import { estimateMs } from './stt-guards';
import { computeCoverage, type Coverage } from './coverage';

/** Told when a class's words changed (a new revision) — queues its summary. */
export type TranscriptChanged = (x: {
  sessionId: string;
  status: 'READY' | 'PARTIAL';
  revision: number;
}) => Promise<void>;

export interface TranscriptMeta {
  pieces: number;
  transcribed: number;
  silent: number;
  skipped: number;
  failed: number;
  partial: boolean;
  /**
   * Why a FAILED transcript has no words: nothing was said, nothing could be
   * transcribed, or the transcription provider refused the account itself.
   */
  reason: 'NO_SPEECH' | 'ALL_FAILED' | 'PROVIDER_UNAVAILABLE' | 'NOT_CAPTURED' | null;
  /** Pieces that failed because the provider refused the account (audio kept: a retry can recover them). */
  providerUnavailable: number;
  /** Distinct microphones with words (per-speaker capture); 0 for a mixed transcript. */
  speakers: number;
  audioSeconds: number;
  /**
   * How much of what the teacher asked to keep the words cover (coverage.ts).
   * A transcript with a gap, a piece that never arrived, or a tab whose audio
   * was not running is PARTIAL, never READY.
   */
  coverage?: Coverage;
  /** Runs of the class (a class reopened inside its window has more than one). */
  runs?: number;
  model: string;
  estUsd: number;
  revision: number;
  jobId: string | null;
  finishedAt: string;
}

/**
 * Decide a class's transcript from its pieces — the one place READY, PARTIAL
 * and FAILED are decided:
 *
 *  READY    every known piece is accounted for (words, silence, or a skip of
 *           a sub-2 s tail / a title echo), at least one has words, AND the
 *           pieces cover what the teacher asked to keep (coverage.ts).
 *  PARTIAL  words exist, but a piece failed for good, or the coverage has a
 *           gap, a piece the tab made never arrived, or its audio did not run.
 *  FAILED   no words at all: nothing was said, every piece failed, or nothing
 *           was captured of a lesson that asked to be (NOT_CAPTURED).
 *
 * Every run of the class counts: a class reopened inside its window is one
 * transcript, its runs in the order they were spoken.
 *
 * A piece neither transcribed nor failed means the work is not done: the
 * transcript is NOT decided (returns PENDING) unless `giveUpPending` (the
 * queue's last attempt, or recovery) marks them failed first.
 *
 * The write is conditional: by the job that holds the class's lease, or —
 * with no job (recovery) — only while nobody holds it. `transcriptRevision`
 * goes up whenever the words change, which is what makes an older summary
 * stale.
 */
export async function finalizeTranscript(
  prisma: PrismaService,
  opts: {
    sessionId: string;
    roomName: string;
    jobId: string | null;
    model: string;
    giveUpPending: boolean;
    onChanged?: TranscriptChanged;
  },
): Promise<{
  status: 'READY' | 'PARTIAL' | 'FAILED' | 'PENDING' | 'LOST';
  meta: TranscriptMeta;
  changed: boolean;
}> {
  // Every run of the class, not only the one that just ended.
  const where = { sessionId: opts.sessionId };
  if (opts.giveUpPending) {
    await prisma.liveAudioSegment.updateMany({
      where: { ...where, text: null, error: null },
      data: { error: 'GAVE_UP: not transcribed after every retry' },
    });
  }
  const rows = await prisma.liveAudioSegment.findMany({ where, orderBy: { seq: 'asc' } });
  const session = await prisma.liveSession.findUniqueOrThrow({
    where: { id: opts.sessionId },
    select: { startedAt: true, endedAt: true, transcriptText: true, transcriptRevision: true },
  });
  const [spans, manifest, leases] = await Promise.all([
    prisma.liveCaptureSpan.findMany({ where }),
    prisma.liveAudioManifest.findMany({ where }),
    prisma.liveCaptureLease.findMany({
      where,
      select: { roomName: true, audioOk: true, audioProblem: true },
    }),
  ]);
  const failed = rows.filter((r) => r.error).length;
  const providerUnavailable = rows.filter((r) =>
    r.error?.startsWith('PROVIDER_UNAVAILABLE'),
  ).length;
  const pending = rows.filter((r) => r.text === null && !r.error).length;
  // The start of the first run: a reopened class's startedAt is its last
  // run's, and the earlier runs' pieces must not land before second zero.
  const classStartSec = Math.floor(
    Math.min(
      session.startedAt?.getTime() ?? Infinity,
      (rows[0]?.seq ?? Infinity) * 1000,
      ...spans.map((x) => x.startedAt.getTime()),
    ) / 1000,
  );
  const coverage = computeCoverage({
    spans,
    segments: rows,
    manifest,
    leases,
    openEndMs: session.endedAt?.getTime() ?? Date.now(),
    classStartSec: Number.isFinite(classStartSec) ? classStartSec : 0,
  });
  const { segments, text } = assembleTranscript(rows, classStartSec);
  const sentMs = rows.filter((r) => r.attempts > 0).reduce((n, r) => n + estimateMs(r), 0);
  const changed = (text || null) !== (session.transcriptText ?? null);
  const revision = changed ? session.transcriptRevision + 1 : session.transcriptRevision;
  const status: 'READY' | 'PARTIAL' | 'FAILED' = text
    ? failed || !coverage.complete
      ? 'PARTIAL'
      : 'READY'
    : 'FAILED';
  // Nothing at all, of a lesson that asked to be kept for more than a minute
  // and whose tab never even reported silence: capture did not run.
  const notCaptured =
    !text &&
    !failed &&
    coverage.expectedSec > 60 &&
    coverage.coveredSec === 0 &&
    !manifest.some((m) => m.state === 'SILENT');
  const meta: TranscriptMeta = {
    pieces: rows.length,
    transcribed: rows.filter((r) => !!r.text?.trim()).length,
    silent: rows.filter((r) => r.text === '' && !r.skipReason).length,
    skipped: rows.filter((r) => !!r.skipReason).length,
    failed,
    partial: status === 'PARTIAL',
    reason: text
      ? null
      : providerUnavailable
        ? 'PROVIDER_UNAVAILABLE'
        : failed
          ? 'ALL_FAILED'
          : notCaptured
            ? 'NOT_CAPTURED'
            : 'NO_SPEECH',
    providerUnavailable,
    speakers: new Set(
      rows
        .filter((r) => r.speakerKind && r.speakerKind !== 'UNKNOWN' && r.text?.trim())
        .map((r) => r.speakerUserId),
    ).size,
    audioSeconds: Math.round(rows.reduce((n, r) => n + estimateMs(r), 0) / 1000),
    coverage,
    runs: new Set([...rows.map((r) => r.roomName), ...spans.map((x) => x.roomName)]).size,
    model: opts.model,
    estUsd: Number(((sentMs / 60_000) * sttUsdPerMin(opts.model)).toFixed(4)),
    revision,
    jobId: opts.jobId,
    finishedAt: new Date().toISOString(),
  };
  if (pending) return { status: 'PENDING', meta, changed: false };

  const owner: Prisma.LiveSessionWhereInput = opts.jobId
    ? { transcriptLeaseJobId: opts.jobId }
    : { OR: [{ transcriptLeaseJobId: null }, { transcriptLeaseUntil: { lt: new Date() } }] };
  const w = await prisma.liveSession.updateMany({
    where: { id: opts.sessionId, ...owner },
    data: {
      transcriptStatus: status,
      transcriptMeta: meta as unknown as Prisma.InputJsonValue,
      transcriptRevision: revision,
      ...(changed
        ? {
            transcriptText: text || null,
            transcriptSegments: text
              ? (segments as unknown as Prisma.InputJsonValue)
              : Prisma.DbNull,
          }
        : {}),
    },
  });
  if (w.count === 0) return { status: 'LOST', meta, changed: false };
  if (changed && status !== 'FAILED' && opts.onChanged) {
    await opts.onChanged({ sessionId: opts.sessionId, status, revision }).catch(() => undefined);
  }
  return { status, meta, changed };
}
