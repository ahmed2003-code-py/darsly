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
 * OFF by default: every run is a paid call. LIVE_TRANSCRIPTION_ENABLED=true
 * switches it on; LIVE_STT_MODEL picks the model (gpt-4o-mini-transcribe
 * unless a benchmark says otherwise — see scripts/transcription-bench).
 */
export function transcriptionConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    enabled: env.LIVE_TRANSCRIPTION_ENABLED === 'true' && !!env.OPENAI_API_KEY?.trim(),
    model: env.LIVE_STT_MODEL?.trim() || 'gpt-4o-mini-transcribe',
    apiKey: env.OPENAI_API_KEY?.trim() || '',
  };
}

/** Upload bounds: a 3-minute piece of 32 kbps Opus is under 1 MB. */
export const AUDIO_SEGMENT_MAX_BYTES = 8 * 1024 * 1024;
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
/** Pieces may still be arriving just after the class ends (the last flush). */
export const LAST_PIECE_GRACE_MS = 45_000;
/** OFFICIAL list price per audio minute (USD), for the cost log line. */
export const STT_USD_PER_MIN: Record<string, number> = {
  'gpt-4o-mini-transcribe': 0.003,
  'gpt-4o-transcribe': 0.006,
};

export type SpeechToText = (audio: Buffer, filename: string) => Promise<string>;

/**
 * OpenAI's transcription endpoint, Arabic. A refusal of the request (4xx) is
 * terminal — retrying the same audio will be refused again; an outage or a
 * timeout is retried by the job queue.
 */
export function openAiSpeechToText(cfg = transcriptionConfig()): SpeechToText {
  return async (audio, filename) => {
    const form = new FormData();
    const type = filename.endsWith('.m4a') ? 'audio/mp4' : 'audio/webm';
    form.append('file', new Blob([new Uint8Array(audio)], { type }), filename);
    form.append('model', cfg.model);
    form.append('language', 'ar');
    form.append('response_format', 'json');
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
