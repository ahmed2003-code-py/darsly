import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { assembleTranscript, sttUsdPerMin } from './lesson-transcription';
import { estimateMs } from './stt-guards';

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
  /** Why a FAILED transcript has no words: nothing was said, or nothing could be transcribed. */
  reason: 'NO_SPEECH' | 'ALL_FAILED' | null;
  audioSeconds: number;
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
 *           a sub-2 s tail / a title echo) and at least one has words.
 *  PARTIAL  words exist, but at least one piece failed for good.
 *  FAILED   no words at all: nothing was said, or every piece failed.
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
): Promise<{ status: 'READY' | 'PARTIAL' | 'FAILED' | 'PENDING' | 'LOST'; meta: TranscriptMeta; changed: boolean }> {
  const where = { sessionId: opts.sessionId, roomName: opts.roomName };
  if (opts.giveUpPending) {
    await prisma.liveAudioSegment.updateMany({
      where: { ...where, text: null, error: null },
      data: { error: 'GAVE_UP: not transcribed after every retry' },
    });
  }
  const rows = await prisma.liveAudioSegment.findMany({ where, orderBy: { seq: 'asc' } });
  const session = await prisma.liveSession.findUniqueOrThrow({
    where: { id: opts.sessionId },
    select: { startedAt: true, transcriptText: true, transcriptRevision: true },
  });
  const failed = rows.filter((r) => r.error).length;
  const pending = rows.filter((r) => r.text === null && !r.error).length;
  const classStartSec = Math.floor((session.startedAt?.getTime() ?? (rows[0]?.seq ?? 0) * 1000) / 1000);
  const { segments, text } = assembleTranscript(rows, classStartSec);
  const sentMs = rows.filter((r) => r.attempts > 0).reduce((n, r) => n + estimateMs(r), 0);
  const changed = (text || null) !== (session.transcriptText ?? null);
  const revision = changed ? session.transcriptRevision + 1 : session.transcriptRevision;
  const status: 'READY' | 'PARTIAL' | 'FAILED' = text ? (failed ? 'PARTIAL' : 'READY') : 'FAILED';
  const meta: TranscriptMeta = {
    pieces: rows.length,
    transcribed: rows.filter((r) => !!r.text?.trim()).length,
    silent: rows.filter((r) => r.text === '' && !r.skipReason).length,
    skipped: rows.filter((r) => !!r.skipReason).length,
    failed,
    partial: status === 'PARTIAL',
    reason: text ? null : failed ? 'ALL_FAILED' : 'NO_SPEECH',
    audioSeconds: Math.round(rows.reduce((n, r) => n + estimateMs(r), 0) / 1000),
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
            transcriptSegments: text ? (segments as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
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
