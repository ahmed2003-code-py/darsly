import type { RecordingStage } from './recording/recording-stage';

/**
 * What a finished lesson's transcript and summary are doing — as two separate
 * things, because they are: the summary is written *from* the transcript, and
 * a summary that "failed" only because the words are not ready yet is not a
 * failure a teacher should be shown.
 *
 * Daily transcribed during the class (Deepgram, through Daily) and the summary
 * job fetches those words itself, so a Daily summary may be asked for at any
 * time. Cloudflare carries media only: a Cloudflare lesson's words come from
 * the audio Darsly captured during the class (LIVE_TRANSCRIBE, when switched
 * on) — not from its recording, which is a separate thing — so its summary
 * waits for a transcript that exists.
 */
export type TranscriptStage =
  /** The class is still running; its words are turned into text after it ends. */
  | 'WAITING_FOR_CLASS_END'
  /** Kept for older clients; no longer produced (the transcript does not wait for the recording). */
  | 'WAITING_FOR_RECORDING'
  /** Being fetched or produced now. */
  | 'TRANSCRIBING'
  | 'READY'
  /** Captured by the provider during the class; fetched when a summary is asked for (Daily). */
  | 'AT_PROVIDER'
  | 'FAILED'
  /** There will be none — see `reason`. */
  | 'UNAVAILABLE';

export type TranscriptUnavailable =
  | 'NO_RECORDING'
  | 'NO_TRANSCRIPTION'
  | 'TRANSCRIPTION_OFF'
  | 'NOTHING_SAID'
  /** Transcription was on, but nothing was captured (never switched on, or silence). */
  | 'NOTHING_CAPTURED';

export type SummaryStage =
  'WAITING_FOR_TRANSCRIPT' | 'NOT_STARTED' | 'GENERATING' | 'READY' | 'FAILED' | 'UNAVAILABLE';

export interface PipelineInput {
  provider: 'DAILY' | 'CLOUDFLARE';
  transcriptStatus: string;
  hasTranscriptText: boolean;
  summaryStatus: string;
  summaryError: string | null;
  /** The latest recording's stage (Cloudflare), or null when there is none. */
  recordingStage: RecordingStage | null;
  /** Cloudflare: transcription may run for this class (global switch on, mode not OFF). */
  transcriptionOn?: boolean;
  /** The class has not ended yet. */
  classRunning?: boolean;
}

export function pipelineStages(x: PipelineInput): {
  transcript: { stage: TranscriptStage; reason: TranscriptUnavailable | null };
  summary: { stage: SummaryStage; canGenerate: boolean };
} {
  let transcript: { stage: TranscriptStage; reason: TranscriptUnavailable | null };
  if (x.hasTranscriptText || x.transcriptStatus === 'READY') {
    transcript = { stage: 'READY', reason: null };
  } else if (x.provider === 'DAILY') {
    if (x.transcriptStatus === 'FAILED' || x.summaryError === 'TRANSCRIPTION_UNAVAILABLE') {
      transcript = { stage: 'UNAVAILABLE', reason: 'TRANSCRIPTION_OFF' };
    } else if (x.summaryError === 'NO_TRANSCRIPT') {
      transcript = { stage: 'UNAVAILABLE', reason: 'NOTHING_SAID' };
    } else if (x.summaryStatus === 'PROCESSING') {
      transcript = { stage: 'TRANSCRIBING', reason: null };
    } else {
      transcript = { stage: 'AT_PROVIDER', reason: null };
    }
  } else if (x.transcriptStatus === 'PROCESSING') {
    // The lesson's own audio (captured in the teacher's browser) is being
    // transcribed — it does not wait for the recording.
    transcript = { stage: 'TRANSCRIBING', reason: null };
  } else if (x.transcriptStatus === 'FAILED') {
    transcript = { stage: 'FAILED', reason: null };
  } else if (!x.transcriptionOn) {
    transcript = { stage: 'UNAVAILABLE', reason: 'TRANSCRIPTION_OFF' };
  } else if (x.classRunning) {
    transcript = { stage: 'WAITING_FOR_CLASS_END', reason: null };
  } else {
    transcript = { stage: 'UNAVAILABLE', reason: 'NOTHING_CAPTURED' };
  }

  let summary: { stage: SummaryStage; canGenerate: boolean };
  if (x.summaryStatus === 'READY') {
    summary = { stage: 'READY', canGenerate: false };
  } else if (x.summaryStatus === 'PROCESSING') {
    summary = { stage: 'GENERATING', canGenerate: false };
  } else if (x.provider === 'CLOUDFLARE' && transcript.stage !== 'READY') {
    // Never asked for, never failed: it is waiting, or it cannot happen.
    summary = {
      stage:
        transcript.stage === 'UNAVAILABLE' || transcript.stage === 'FAILED'
          ? 'UNAVAILABLE'
          : 'WAITING_FOR_TRANSCRIPT',
      canGenerate: false,
    };
  } else if (x.provider === 'DAILY' && transcript.stage === 'UNAVAILABLE') {
    summary = { stage: 'UNAVAILABLE', canGenerate: false };
  } else if (x.summaryStatus === 'FAILED') {
    summary = { stage: 'FAILED', canGenerate: true };
  } else {
    summary = { stage: 'NOT_STARTED', canGenerate: true };
  }
  return { transcript, summary };
}
