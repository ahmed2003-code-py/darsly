/**
 * What the record button says — one explicit lifecycle instead of a stale
 * boolean.
 *
 *   IDLE → STARTING → RECORDING → STOPPING → PROCESSING → COMPLETED | FAILED
 *
 * The button used to show `state.recording`, a boolean the classroom re-reads
 * a moment after every change. Pressing "record" disabled the button for the
 * request, then the button went back to "record" (the boolean had not been
 * re-read yet), then flipped to "stop" when it was — and a request no
 * recorder ever took quietly turned the badge off two minutes later.
 *
 * Now the phase comes from the recorder's real stage (sent by the server for
 * the teacher), and a press is held as `pending` until the server's state has
 * caught up with it — so a stale read can never visibly undo what the teacher
 * just did. A pending press that the server never confirms gives way to the
 * server after PENDING_TIMEOUT_MS.
 */
export type RecordingPhase =
  'IDLE' | 'STARTING' | 'RECORDING' | 'STOPPING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

/** The run's latest recording, as the server reports it (RtcState.recordingState). */
export interface ServerRecording {
  id: string;
  /** REQUESTED · CAPTURING · FINALIZING · PROCESSING · READY · FAILED */
  stage: string;
  /** NOT_STARTED · NOTHING_RECORDED · PROCESSING_FAILED */
  failure: string | null;
  /** The teacher's "record" stands. */
  intent: boolean;
  captureStartedAt: string | null;
}

export interface PendingPress {
  kind: 'start' | 'stop';
  at: number;
  /** The latest recording when the button was pressed. */
  prevId: string | null;
  /** The recording the start created (from its answer), once known. */
  recId?: string;
}

export const PENDING_TIMEOUT_MS = 20_000;

export interface PhaseView {
  phase: RecordingPhase;
  failure: string | null;
  /** The teacher's "record" stands — the lesson's audio is kept on its account. */
  intent: boolean;
  /** The press has been confirmed by the server (or given up on): drop it. */
  settled: boolean;
}

export function serverPhase(r: ServerRecording | null | undefined): PhaseView {
  if (!r) return { phase: 'IDLE', failure: null, intent: false, settled: true };
  const v = (phase: RecordingPhase, failure: string | null = null): PhaseView => ({
    phase,
    failure,
    intent: r.intent,
    settled: true,
  });
  if (r.stage === 'FAILED') return v('FAILED', r.failure ?? 'PROCESSING_FAILED');
  if (r.intent) {
    if (r.stage === 'REQUESTED') return v('STARTING');
    if (r.stage === 'CAPTURING') return v(r.captureStartedAt ? 'RECORDING' : 'STARTING');
    // The recorder gave up mid-class and is saving what it had; the teacher's
    // "record" still stands (the transcript goes on): said as a failure.
    if (r.stage === 'FINALIZING' || r.stage === 'PROCESSING') return v('FAILED', 'INTERRUPTED');
    if (r.stage === 'READY') return v('COMPLETED');
  }
  if (r.stage === 'REQUESTED' || r.stage === 'CAPTURING' || r.stage === 'FINALIZING')
    return v('STOPPING');
  if (r.stage === 'PROCESSING') return v('PROCESSING');
  if (r.stage === 'READY') return v('COMPLETED');
  return v('IDLE');
}

/** The phase to show: the server's, unless a press it has not caught up with yet. */
export function recordingPhase(
  r: ServerRecording | null | undefined,
  pending: PendingPress | null,
  now = Date.now(),
): PhaseView {
  const server = serverPhase(r);
  if (!pending) return server;
  if (now - pending.at > PENDING_TIMEOUT_MS) return { ...server, settled: true };
  if (pending.kind === 'start') {
    const seen = !!r && (pending.recId ? r.id === pending.recId : r.id !== pending.prevId);
    return seen ? server : { phase: 'STARTING', failure: null, intent: true, settled: false };
  }
  // A stop is confirmed once the server no longer has the intent.
  return !r || !r.intent
    ? server
    : { phase: 'STOPPING', failure: null, intent: false, settled: false };
}

/** Whether the button starts or stops a recording in this phase (null: wait). */
export function recordingAction(v: PhaseView): 'start' | 'stop' | null {
  if (v.phase === 'STARTING' || v.phase === 'RECORDING') return 'stop';
  if (v.phase === 'FAILED' && v.intent) return 'stop';
  if (v.phase === 'STOPPING') return null;
  return 'start';
}

/**
 * For a class with no stage from the server (Daily): the boolean, held the
 * same way, so a press is not undone by a stale read either.
 */
export function booleanRecording(recording: boolean): ServerRecording | null {
  return recording
    ? { id: 'daily', stage: 'CAPTURING', failure: null, intent: true, captureStartedAt: 'now' }
    : null;
}
