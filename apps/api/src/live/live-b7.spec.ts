import { LIVE_SESSION_RULES, validateLiveSession } from '@darsly/shared-types';
import { pipelineStages } from './live-pipeline';
import { recordingStage } from './recording/recording-stage';

/** Checkpoint B.7: the rules a teacher meets, and the stages a lesson goes through. */

const NOW = Date.UTC(2026, 8, 26, 10, 0, 0);
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const ok = { title: 'مراجعة الفيزياء', startsAt: at(60), durationMin: 60, capacity: '' };
const codes = (x: Parameters<typeof validateLiveSession>[0]) =>
  validateLiveSession(x, NOW).map((e) => `${e.field}:${e.code}`);

describe('live session rules (shared by the API and the form)', () => {
  it('accepts a normal session', () => {
    expect(codes(ok)).toEqual([]);
    expect(codes({ ...ok, capacity: 30, description: 'x'.repeat(1000) })).toEqual([]);
  });

  it('names every broken field, in form order', () => {
    expect(codes({ title: '', startsAt: '', durationMin: '', capacity: 'abc' })).toEqual([
      'title:TITLE_REQUIRED',
      'startsAt:STARTS_AT_REQUIRED',
      'durationMin:DURATION_INVALID',
      'capacity:CAPACITY_INVALID',
    ]);
  });

  it('holds duration to the authoritative bounds', () => {
    const R = LIVE_SESSION_RULES;
    expect(codes({ ...ok, durationMin: R.durationMin })).toEqual([]);
    expect(codes({ ...ok, durationMin: R.durationMin - 1 })).toEqual([
      'durationMin:DURATION_TOO_SHORT',
    ]);
    expect(validateLiveSession({ ...ok, durationMin: 2 }, NOW)[0].params).toEqual({
      min: R.durationMin,
    });
    expect(codes({ ...ok, durationMin: R.durationMax + 1 })).toEqual([
      'durationMin:DURATION_TOO_LONG',
    ]);
    expect(codes({ ...ok, durationMin: '1.5' })).toEqual(['durationMin:DURATION_INVALID']);
  });

  it('refuses a start in the past, with a little grace for "now"', () => {
    expect(codes({ ...ok, startsAt: at(-2) })).toEqual([]);
    expect(codes({ ...ok, startsAt: at(-(LIVE_SESSION_RULES.pastGraceMin + 1)) })).toEqual([
      'startsAt:STARTS_AT_PAST',
    ]);
    expect(codes({ ...ok, startsAt: 'not a date' })).toEqual(['startsAt:STARTS_AT_INVALID']);
  });

  it('checks title length and capacity bounds', () => {
    expect(codes({ ...ok, title: ' a ' })).toEqual(['title:TITLE_TOO_SHORT']);
    expect(codes({ ...ok, title: 'x'.repeat(161) })).toEqual(['title:TITLE_TOO_LONG']);
    expect(codes({ ...ok, capacity: 0 })).toEqual(['capacity:CAPACITY_TOO_SMALL']);
    expect(codes({ ...ok, capacity: 100_001 })).toEqual(['capacity:CAPACITY_TOO_LARGE']);
    expect(codes({ ...ok, capacity: null })).toEqual([]);
  });
});

describe('recording stages (never a raw status)', () => {
  const r = (
    status: string,
    extra: Partial<{ stopRequestedAt: Date | null; error: string | null }> = {},
  ) => recordingStage({ status, stopRequestedAt: null, error: null, ...extra });
  it('maps statuses to what a teacher is told', () => {
    expect(r('REQUESTED').stage).toBe('REQUESTED');
    expect(r('RECORDING').stage).toBe('CAPTURING');
    expect(r('RECORDING', { stopRequestedAt: new Date() }).stage).toBe('FINALIZING');
    expect(r('UPLOADING').stage).toBe('FINALIZING');
    expect(r('PROCESSING').stage).toBe('PROCESSING');
    expect(r('READY').stage).toBe('READY');
  });
  it('turns technical reasons into three a teacher can act on', () => {
    expect(r('FAILED', { error: 'NOT_CLAIMED' }).failure).toBe('NOT_STARTED');
    expect(r('FAILED', { error: 'NEVER_STARTED' }).failure).toBe('NOT_STARTED');
    expect(r('FAILED', { error: 'NO_MEDIA' }).failure).toBe('NOTHING_RECORDED');
    expect(r('FAILED', { error: 'PACKAGING_FAILED' }).failure).toBe('PROCESSING_FAILED');
    expect(r('FAILED', { error: 'FINALIZE: ffmpeg exited 1' }).failure).toBe('PROCESSING_FAILED');
  });
});

describe('transcript and summary are separate stages', () => {
  const base = {
    transcriptStatus: 'NOT_STARTED',
    hasTranscriptText: false,
    summaryStatus: 'NOT_STARTED',
    summaryError: null,
    recordingStage: null,
  } as const;

  it('Cloudflare: the summary waits while the recording it would come from is being made', () => {
    const s = pipelineStages({ ...base, provider: 'CLOUDFLARE', recordingStage: 'PROCESSING' });
    expect(s.transcript.stage).toBe('WAITING_FOR_RECORDING');
    expect(s.summary).toEqual({ stage: 'WAITING_FOR_TRANSCRIPT', canGenerate: false });
  });

  it('Cloudflare: a failed NO_TRANSCRIPT job is not shown as a failure — there was nothing to summarise', () => {
    const s = pipelineStages({
      ...base,
      provider: 'CLOUDFLARE',
      summaryStatus: 'FAILED',
      summaryError: 'NO_TRANSCRIPT',
    });
    expect(s.transcript).toEqual({ stage: 'UNAVAILABLE', reason: 'NO_RECORDING' });
    expect(s.summary).toEqual({ stage: 'UNAVAILABLE', canGenerate: false });
    const withRec = pipelineStages({ ...base, provider: 'CLOUDFLARE', recordingStage: 'READY' });
    expect(withRec.transcript.reason).toBe('NO_TRANSCRIPTION');
  });

  it('Cloudflare: with a transcript the summary can be asked for, then generates, then is ready', () => {
    const t = { ...base, provider: 'CLOUDFLARE' as const, hasTranscriptText: true };
    expect(pipelineStages(t).summary).toEqual({ stage: 'NOT_STARTED', canGenerate: true });
    expect(pipelineStages({ ...t, summaryStatus: 'PROCESSING' }).summary.stage).toBe('GENERATING');
    expect(pipelineStages({ ...t, summaryStatus: 'READY' }).summary.stage).toBe('READY');
    expect(pipelineStages({ ...t, summaryStatus: 'FAILED' }).summary).toEqual({
      stage: 'FAILED',
      canGenerate: true,
    });
  });

  it('Daily keeps working as before: words are at the provider until the summary fetches them', () => {
    const d = { ...base, provider: 'DAILY' as const };
    expect(pipelineStages(d).transcript.stage).toBe('AT_PROVIDER');
    expect(pipelineStages(d).summary).toEqual({ stage: 'NOT_STARTED', canGenerate: true });
    expect(pipelineStages({ ...d, summaryStatus: 'PROCESSING' }).transcript.stage).toBe(
      'TRANSCRIBING',
    );
    const off = pipelineStages({
      ...d,
      summaryStatus: 'FAILED',
      summaryError: 'TRANSCRIPTION_UNAVAILABLE',
    });
    expect(off.transcript).toEqual({ stage: 'UNAVAILABLE', reason: 'TRANSCRIPTION_OFF' });
    expect(off.summary.stage).toBe('UNAVAILABLE');
    // A retryable failure stays retryable.
    expect(
      pipelineStages({ ...d, summaryStatus: 'FAILED', summaryError: 'TRANSCRIPT_PENDING' }).summary,
    ).toEqual({ stage: 'FAILED', canGenerate: true });
  });
});
