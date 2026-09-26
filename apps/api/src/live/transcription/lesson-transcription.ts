import type { LiveTranscriptionMode } from '@prisma/client';
import { AiJobError } from '../../academy-site/ai/ai-job.error';

/**
 * Transcribing a Darsly-hosted lesson.
 *
 * Cloudflare carries media only — no provider transcribes the class the way
 * Daily's Deepgram did — so the words come from audio Darsly captures itself:
 * the teacher's browser mixes their microphone with the students allowed to
 * speak and uploads it in self-contained pieces while the class runs
 * (LiveAudioSegment). After the class, one job turns the pieces into text.
 *
 * Two switches, on purpose:
 *  - LIVE_TRANSCRIPTION_ENABLED (global, OFF by default): whether Darsly may
 *    transcribe at all — every run is a paid call;
 *  - the session's transcriptionMode: OFF, MANUAL (the teacher switches
 *    capture on and off in the classroom) or AUTO_WHEN_RECORDING (capture
 *    follows the recording). New sessions take LIVE_TRANSCRIPTION_DEFAULT_MODE.
 * LIVE_STT_MODEL picks the model (gpt-4o-mini-transcribe unless a benchmark
 * says otherwise — see scripts/transcription-bench).
 */
export function transcriptionConfig(env: NodeJS.ProcessEnv = process.env) {
  const mode = env.LIVE_TRANSCRIPTION_DEFAULT_MODE?.trim().toUpperCase();
  const retention = Number(env.LIVE_AUDIO_RETENTION_HOURS);
  return {
    enabled: env.LIVE_TRANSCRIPTION_ENABLED === 'true' && !!env.OPENAI_API_KEY?.trim(),
    model: env.LIVE_STT_MODEL?.trim() || 'gpt-4o-mini-transcribe',
    apiKey: env.OPENAI_API_KEY?.trim() || '',
    defaultMode: (mode === 'OFF' || mode === 'MANUAL' || mode === 'AUTO_WHEN_RECORDING'
      ? mode
      : 'AUTO_WHEN_RECORDING') as LiveTranscriptionMode,
    /** How long audio that did NOT become a transcript is kept (failed, abandoned). */
    audioRetentionHours: Number.isFinite(retention) && retention > 0 ? retention : 24,
  };
}

/**
 * Whether the teacher's page should be capturing the lesson's words right now.
 * The one place this is decided — the classroom's badge, the page's capture
 * and the upload's acceptance all ask here.
 */
export function captureActive(x: {
  enabled: boolean;
  mode: LiveTranscriptionMode;
  captureOnAt: Date | null;
  captureOffAt: Date | null;
  recording: boolean;
}): boolean {
  if (!x.enabled || x.mode === 'OFF') return false;
  if (x.mode === 'AUTO_WHEN_RECORDING') return x.recording;
  return !!x.captureOnAt && (!x.captureOffAt || x.captureOffAt < x.captureOnAt);
}

/** Upload bounds: a 3-minute piece of 32 kbps Opus is under 1 MB. */
export const AUDIO_SEGMENT_MAX_BYTES = 8 * 1024 * 1024;
/** A piece shorter than this carries no header worth trusting. */
export const AUDIO_SEGMENT_MIN_BYTES = 200;
/** More pieces than this in a minute from one class is not a classroom. */
export const AUDIO_PIECES_PER_MINUTE = 8;
/**
 * A piece is numbered by the second it started (Unix seconds): unique across a
 * teacher reloading the page mid-class (a counter would restart at 0 and
 * overwrite the first pieces), and in the order it was spoken. Anything not
 * plausibly "during this class" is refused.
 */
export function validPieceSeq(seq: number, nowMs = Date.now()): boolean {
  const now = Math.floor(nowMs / 1000);
  return Number.isInteger(seq) && seq >= now - 24 * 3600 && seq <= now + 600;
}
/** WebM/Opus from Chrome, Firefox, Android; MP4/AAC from Safari. */
export const audioExt = (mimetype: string | undefined) =>
  /mp4|m4a|aac/i.test(mimetype ?? '') ? 'm4a' : 'webm';
/** The declared type must be audio (or WebM, which some browsers label video). */
export const acceptableAudioMime = (mimetype: string | undefined) =>
  /^(audio\/(webm|mp4|x-m4a|m4a|aac|ogg)|video\/webm)(;.*)?$/i.test((mimetype ?? '').trim());
/**
 * What the bytes really are — the declared type is the browser's word, the
 * header is the file's. WebM starts with the EBML magic; MP4 has `ftyp` at 4.
 */
export function sniffAudio(buf: Buffer): 'webm' | 'm4a' | null {
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x1a45dfa3) return 'webm';
  if (buf.length >= 8 && buf.toString('latin1', 4, 8) === 'ftyp') return 'm4a';
  return null;
}
/** Pieces may still be arriving just after the class ends (the last flush). */
export const LAST_PIECE_GRACE_MS = 45_000;
/** …and just after capture is switched off (the piece being written is flushed). */
export const CAPTURE_OFF_GRACE_MS = 90_000;
/** OFFICIAL list price per audio minute (USD), for the cost record. */
export const STT_USD_PER_MIN: Record<string, number> = {
  'gpt-4o-mini-transcribe': 0.003,
  'gpt-4o-transcribe': 0.006,
};
export const sttUsdPerMin = (model: string) => STT_USD_PER_MIN[model] ?? 0.006;

export type SpeechToText = (
  audio: Buffer,
  filename: string,
  opts?: { prompt?: string },
) => Promise<string>;

/**
 * OpenAI's transcription endpoint, Arabic. A refusal of the request (4xx) is
 * terminal — retrying the same audio will be refused again; an outage or a
 * timeout is retried by the job queue.
 *
 * `prompt` carries the lesson's title: the model spells a subject's own terms
 * (often English inside Egyptian Arabic) better when it knows the subject.
 */
export function openAiSpeechToText(cfg = transcriptionConfig()): SpeechToText {
  return async (audio, filename, opts) => {
    const form = new FormData();
    const type = filename.endsWith('.m4a') ? 'audio/mp4' : 'audio/webm';
    form.append('file', new Blob([new Uint8Array(audio)], { type }), filename);
    form.append('model', cfg.model);
    form.append('language', 'ar');
    form.append('response_format', 'json');
    if (opts?.prompt) form.append('prompt', opts.prompt.slice(0, 400));
    let res: Response;
    try {
      res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      throw new AiJobError(`Transcription unreachable: ${(e as Error).name}`, 'RETRYABLE');
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new AiJobError(
        `Transcription refused (${res.status}): ${body}`,
        res.status >= 500 || res.status === 429 ? 'RETRYABLE' : 'TERMINAL',
      );
    }
    const j = (await res.json()) as { text?: string };
    return (j.text ?? '').trim();
  };
}

/** Storage key for one piece — under source/, never served. */
export const audioKey = (sessionId: string, roomName: string, seq: number, ext = 'webm') =>
  `source/live-audio/${sessionId}/${roomName}/${seq}.${ext}`;
export const audioPrefix = (sessionId: string) => `source/live-audio/${sessionId}/`;

/** One entry of the assembled transcript. */
export interface TranscriptSegment {
  /** Seconds from the start of the class (the piece's start). */
  startSec: number;
  durationSec: number | null;
  text: string;
}

/**
 * The pieces, in the order they were spoken, as one transcript.
 *
 * Deterministic: ordered by the piece's start second, never by arrival. The
 * pieces do not overlap (each is its own recording, one after the other), so
 * there is no repeated text at the boundaries to strip. Silent pieces and
 * pieces that failed simply leave a gap — the timestamps say where.
 */
export function assembleTranscript(
  pieces: { seq: number; durationMs: number | null; text: string | null }[],
  classStartSec: number,
): { segments: TranscriptSegment[]; text: string } {
  const segments = [...pieces]
    .sort((a, b) => a.seq - b.seq)
    .filter((p) => p.text?.trim())
    .map((p) => ({
      startSec: Math.max(0, p.seq - classStartSec),
      durationSec: p.durationMs ? Math.round(p.durationMs / 1000) : null,
      text: p.text!.trim(),
    }));
  return { segments, text: segments.map((s) => s.text).join('\n\n') };
}
