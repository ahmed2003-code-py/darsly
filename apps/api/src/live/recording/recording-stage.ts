/** What the page shows for a recording — never the raw status or reason. */
export type RecordingStage =
  'REQUESTED' | 'CAPTURING' | 'FINALIZING' | 'PROCESSING' | 'READY' | 'FAILED';
/** Why it failed, in terms a teacher can act on. Technical reasons stay in `error`. */
export type RecordingFailure = 'NOT_STARTED' | 'NOTHING_RECORDED' | 'PROCESSING_FAILED';

export function recordingStage(r: {
  status: string;
  stopRequestedAt: Date | null;
  error: string | null;
}): { stage: RecordingStage; failure: RecordingFailure | null } {
  switch (r.status) {
    case 'REQUESTED':
      return { stage: 'REQUESTED', failure: null };
    case 'RECORDING':
      return { stage: r.stopRequestedAt ? 'FINALIZING' : 'CAPTURING', failure: null };
    case 'STOPPING':
    case 'UPLOADING':
      return { stage: 'FINALIZING', failure: null };
    case 'PROCESSING':
      return { stage: 'PROCESSING', failure: null };
    case 'READY':
      return { stage: 'READY', failure: null };
    default: {
      const e = r.error ?? '';
      const failure: RecordingFailure = /NOT_CLAIMED|NEVER_STARTED|STOPPED_BEFORE_START/.test(e)
        ? 'NOT_STARTED'
        : /NO_MEDIA/.test(e)
          ? 'NOTHING_RECORDED'
          : 'PROCESSING_FAILED';
      return { stage: 'FAILED', failure };
    }
  }
}
