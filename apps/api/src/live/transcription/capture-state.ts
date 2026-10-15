import type { LiveTranscriptionMode, PrismaClient } from '@prisma/client';
import { captureActive, transcriptionConfig } from './lesson-transcription';

type Db = Pick<PrismaClient, 'liveSession' | 'liveRecording'>;

/** A capturing tab silent this long has gone (closed, crashed, offline): another may take over. */
export const CAPTURE_LEASE_TTL_MS = 30_000;

export interface CaptureState {
  /** Transcription may happen for this lesson at all (global switch on, mode not OFF). */
  available: boolean;
  mode: LiveTranscriptionMode;
  /** The teacher's page should be capturing right now. */
  active: boolean;
  /** When capture last stopped (manual off, or the recording stopping) — for the flush grace. */
  lastOffAt: Date | null;
  /** Capture has run at some point in this class. */
  everOn: boolean;
}

/**
 * Whether the teacher asked for this run to be recorded and has not asked it
 * to stop — the intent, read off the latest recording of the run.
 *
 * Intent, not health. The video recorder is a separate service: a recorder
 * that never claimed the request (NOT_CLAIMED), or gave up mid-class, is a
 * missing video — and used to switch the lesson's audio capture off as well,
 * because capture followed the recording row's *status*. A transcript now
 * ends only when the teacher stops it (stopRequestedAt) or the class ends.
 */
export function recordingIntent(r: { stopRequestedAt: Date | null } | null | undefined): boolean {
  return !!r && !r.stopRequestedAt;
}

/**
 * Whether a class's words are being captured, read from the database — the
 * one answer the classroom badge, the teacher's page and the audio upload all
 * use. AUTO_WHEN_RECORDING follows the teacher's recording intent for this
 * run: capture starts when recording is asked for and stops when it is asked
 * to stop — whatever the video recorder managed in between.
 */
export async function transcriptCaptureState(
  db: Db,
  sessionId: string,
  roomName: string | null,
): Promise<CaptureState> {
  const cfg = transcriptionConfig();
  const s = await db.liveSession.findUnique({
    where: { id: sessionId },
    select: { transcriptionMode: true, transcriptCaptureOnAt: true, transcriptCaptureOffAt: true },
  });
  const mode = s?.transcriptionMode ?? 'OFF';
  let recording = false;
  let recordingOffAt: Date | null = null;
  let recordedThisRun = false;
  if (cfg.enabled && mode === 'AUTO_WHEN_RECORDING' && roomName) {
    const r = await db.liveRecording.findFirst({
      where: { sessionId, roomName },
      orderBy: { createdAt: 'desc' },
      select: { status: true, stopRequestedAt: true, stoppedAt: true },
    });
    recordedThisRun = !!r;
    recording = recordingIntent(r);
    recordingOffAt = r ? (r.stopRequestedAt ?? null) : null;
  }
  const active = captureActive({
    enabled: cfg.enabled,
    mode,
    captureOnAt: s?.transcriptCaptureOnAt ?? null,
    captureOffAt: s?.transcriptCaptureOffAt ?? null,
    recording,
  });
  return {
    available: cfg.enabled && mode !== 'OFF',
    mode,
    active,
    lastOffAt: mode === 'MANUAL' ? (s?.transcriptCaptureOffAt ?? null) : recordingOffAt,
    everOn: mode === 'MANUAL' ? !!s?.transcriptCaptureOnAt : recordedThisRun,
  };
}

type SpanDb = Pick<PrismaClient, 'liveSession' | 'liveRecording' | 'liveCaptureSpan'>;

/**
 * Keep this run's capture spans in step with the capture state: open one when
 * capture is on and none is open, close the open one when it is off. Called
 * after every change that can move it (record, stop, MANUAL on/off, a sweep),
 * so the spans are the history of the teacher's intent — what a transcript's
 * completeness is measured against (transcript-assembly.ts). Idempotent.
 */
export async function syncCaptureSpans(
  db: SpanDb,
  sessionId: string,
  roomName: string | null,
): Promise<CaptureState | null> {
  if (!roomName) return null;
  const capture = await transcriptCaptureState(db, sessionId, roomName);
  const open = await db.liveCaptureSpan.findFirst({
    where: { sessionId, roomName, endedAt: null },
    orderBy: { startedAt: 'desc' },
  });
  if (capture.active && !open) {
    await db.liveCaptureSpan.create({
      data: {
        sessionId,
        roomName,
        source: capture.mode === 'MANUAL' ? 'MANUAL' : 'RECORDING',
      },
    });
  } else if (!capture.active && open) {
    const at =
      capture.lastOffAt && capture.lastOffAt > open.startedAt ? capture.lastOffAt : new Date();
    await db.liveCaptureSpan.updateMany({
      where: { id: open.id, endedAt: null },
      data: { endedAt: at },
    });
  }
  return capture;
}

/** The class ended: every span of the run still open ends with it. */
export function closeCaptureSpans(
  db: Pick<PrismaClient, 'liveCaptureSpan'>,
  sessionId: string,
  roomName: string,
  endedAt: Date,
) {
  return db.liveCaptureSpan.updateMany({
    where: { sessionId, roomName, endedAt: null },
    data: { endedAt },
  });
}
