import type { LiveTranscriptionMode, PrismaClient } from '@prisma/client';
import { captureActive, transcriptionConfig } from './lesson-transcription';

type Db = Pick<PrismaClient, 'liveSession' | 'liveRecording'>;

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
 * Whether a class's words are being captured, read from the database — the
 * one answer the classroom badge, the teacher's page and the audio upload all
 * use. AUTO_WHEN_RECORDING follows the latest recording of this run: capture
 * starts when recording is asked for and stops when it is asked to stop.
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
    recording =
      !!r && ['REQUESTED', 'RECORDING', 'STOPPING'].includes(r.status) && !r.stopRequestedAt;
    recordingOffAt = r ? (r.stopRequestedAt ?? r.stoppedAt ?? null) : null;
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
