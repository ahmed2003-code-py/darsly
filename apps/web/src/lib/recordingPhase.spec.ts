import {
  booleanRecording,
  PENDING_TIMEOUT_MS,
  recordingAction,
  recordingPhase,
  type ServerRecording,
} from './recordingPhase';

const rec = (over: Partial<ServerRecording> = {}): ServerRecording => ({
  id: 'r1',
  stage: 'REQUESTED',
  failure: null,
  intent: true,
  captureStartedAt: null,
  ...over,
});
const T = 1_000_000;

describe('the record button follows the recorder, not a stale boolean', () => {
  it('walks the whole lifecycle from the server stage', () => {
    expect(recordingPhase(null, null).phase).toBe('IDLE');
    expect(recordingPhase(rec(), null).phase).toBe('STARTING');
    // Claimed, but no media yet: still starting — not "recording".
    expect(recordingPhase(rec({ stage: 'CAPTURING' }), null).phase).toBe('STARTING');
    expect(recordingPhase(rec({ stage: 'CAPTURING', captureStartedAt: 'x' }), null).phase).toBe(
      'RECORDING',
    );
    expect(recordingPhase(rec({ stage: 'FINALIZING', intent: false }), null).phase).toBe(
      'STOPPING',
    );
    expect(recordingPhase(rec({ stage: 'PROCESSING', intent: false }), null).phase).toBe(
      'PROCESSING',
    );
    expect(recordingPhase(rec({ stage: 'READY', intent: false }), null).phase).toBe('COMPLETED');
  });

  it('a press is never undone by a read from before it', () => {
    // Pressed "record"; the answer came back, the classroom has not re-read yet.
    const pending = { kind: 'start' as const, at: T, prevId: null, recId: 'r2' };
    expect(recordingPhase(null, pending, T + 500)).toMatchObject({
      phase: 'STARTING',
      settled: false,
    });
    // An older recording of this run is still the latest the page knows of.
    expect(
      recordingPhase(rec({ id: 'r1', stage: 'READY', intent: false }), pending, T + 500).phase,
    ).toBe('STARTING');
    // Caught up.
    expect(recordingPhase(rec({ id: 'r2' }), pending, T + 900)).toMatchObject({
      phase: 'STARTING',
      settled: true,
    });

    const stop = { kind: 'stop' as const, at: T, prevId: 'r2' };
    const stillOn = rec({ id: 'r2', stage: 'CAPTURING', captureStartedAt: 'x' });
    expect(recordingPhase(stillOn, stop, T + 500)).toMatchObject({
      phase: 'STOPPING',
      settled: false,
    });
    expect(
      recordingPhase({ ...stillOn, intent: false, stage: 'FINALIZING' }, stop, T + 900),
    ).toMatchObject({ phase: 'STOPPING', settled: true });
  });

  it('a press the server never confirms gives way to the server', () => {
    const pending = { kind: 'start' as const, at: T, prevId: null };
    expect(recordingPhase(null, pending, T + PENDING_TIMEOUT_MS + 1)).toMatchObject({
      phase: 'IDLE',
      settled: true,
    });
  });

  it('a recorder that never started is shown as failed — with the transcript still kept', () => {
    const failed = rec({ stage: 'FAILED', failure: 'NOT_STARTED', intent: true });
    const v = recordingPhase(failed, null);
    expect(v).toMatchObject({ phase: 'FAILED', failure: 'NOT_STARTED', intent: true });
    // The teacher's "record" stands, so the button stops it.
    expect(recordingAction(v)).toBe('stop');
    // Once stopped, the button can try again.
    expect(recordingAction(recordingPhase({ ...failed, intent: false }, null))).toBe('start');
  });

  it('a recorder that gave up mid-class is a failure, not "stopping"', () => {
    expect(recordingPhase(rec({ stage: 'FINALIZING', intent: true }), null)).toMatchObject({
      phase: 'FAILED',
      failure: 'INTERRUPTED',
    });
  });

  it('what the button does in each phase', () => {
    const a = (stage: string, intent: boolean, cap: string | null = null) =>
      recordingAction(recordingPhase(rec({ stage, intent, captureStartedAt: cap }), null));
    expect(recordingAction(recordingPhase(null, null))).toBe('start');
    expect(a('REQUESTED', true)).toBe('stop');
    expect(a('CAPTURING', true, 'x')).toBe('stop');
    expect(a('FINALIZING', false)).toBeNull();
    expect(a('PROCESSING', false)).toBe('start');
    expect(a('READY', false)).toBe('start');
  });

  it('a class whose provider only says on/off is held the same way', () => {
    const pending = { kind: 'start' as const, at: T, prevId: null };
    expect(recordingPhase(booleanRecording(false), pending, T + 100).phase).toBe('STARTING');
    expect(recordingPhase(booleanRecording(true), pending, T + 200)).toMatchObject({
      phase: 'RECORDING',
      settled: true,
    });
  });
});
