import { VideoJobConfig } from './video-job.config';
import { VideoJobError } from './video-job.service';
import { VideoJobWorker } from './video-job.worker';

/**
 * What the worker decides, as opposed to what the queue decides.
 *
 * Two behaviours here are the reason this change exists at all: a shutdown
 * that waits for the encode it is holding, and a failure that is not shown to
 * the teacher until it is actually final.
 */
const job = (over: Record<string, unknown> = {}) => ({
  id: 'job1',
  videoAssetId: 'asset1',
  attempts: 1,
  ...over,
}) as any;

function makeWorker(over: { concurrency?: number } = {}) {
  const jobs = {
    claimNext: jest.fn().mockResolvedValue(null),
    renewLease: jest.fn().mockResolvedValue(undefined),
    succeed: jest.fn().mockResolvedValue(undefined),
    fail: jest.fn().mockResolvedValue(false),
  } as any;
  const processing = {
    process: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
  } as any;
  const config = { workerEnabled: true, workerConcurrency: over.concurrency ?? 1 } as VideoJobConfig;
  const worker = new VideoJobWorker(config, jobs, processing);
  jest.spyOn(worker['logger'], 'log').mockImplementation(() => undefined);
  jest.spyOn(worker['logger'], 'warn').mockImplementation(() => undefined);
  jest.spyOn(worker['logger'], 'error').mockImplementation(() => undefined);
  return { worker, jobs, processing, config };
}

describe('VideoJobWorker', () => {
  afterEach(() => jest.useRealTimers());

  it('does not start polling when disabled', () => {
    const { worker, config } = makeWorker();
    (config as any).workerEnabled = false;

    worker.onModuleInit();

    expect(worker['timer']).toBeNull();
  });

  describe('running a job', () => {
    it('packages the asset and marks the job succeeded', async () => {
      const { worker, jobs, processing } = makeWorker();

      await worker['run'](job());

      expect(processing.process).toHaveBeenCalledWith('asset1');
      expect(jobs.succeed).toHaveBeenCalledWith('job1');
      expect(processing.markFailed).not.toHaveBeenCalled();
    });

    it('keeps the lease alive while a long encode runs', async () => {
      jest.useFakeTimers();
      const { worker, jobs, processing } = makeWorker();
      let finish: () => void = () => undefined;
      processing.process.mockReturnValue(new Promise<void>((r) => (finish = r)));

      const running = worker['run'](job());
      await jest.advanceTimersByTimeAsync(5 * 60_000);
      expect(jobs.renewLease).toHaveBeenCalled();

      finish();
      await running;
      // And the heartbeat stops once the work is done.
      const callsAtEnd = jobs.renewLease.mock.calls.length;
      await jest.advanceTimersByTimeAsync(10 * 60_000);
      expect(jobs.renewLease.mock.calls.length).toBe(callsAtEnd);
    });

    /**
     * The asset is the teacher's view of this. A job with retries left has not
     * failed yet, and writing FAILED here would put an error on their screen
     * that the next attempt silently contradicts.
     */
    it('does NOT mark the asset failed while retries remain', async () => {
      const { worker, jobs, processing } = makeWorker();
      jobs.fail.mockResolvedValue(true); // will retry
      processing.process.mockRejectedValue(new Error('storage timeout'));

      await worker['run'](job());

      expect(jobs.fail).toHaveBeenCalledWith('job1', {
        message: 'storage timeout',
        errorClass: 'RETRYABLE',
      });
      expect(processing.markFailed).not.toHaveBeenCalled();
    });

    it('marks the asset failed once the job is given up on', async () => {
      const { worker, jobs, processing } = makeWorker();
      jobs.fail.mockResolvedValue(false); // no retries left
      processing.process.mockRejectedValue(new Error('still broken'));

      await worker['run'](job());

      expect(processing.markFailed).toHaveBeenCalledWith('asset1');
    });

    it('honours a TERMINAL classification from the processing service', async () => {
      const { worker, jobs, processing } = makeWorker();
      processing.process.mockRejectedValue(new VideoJobError('corrupt source', 'TERMINAL'));

      await worker['run'](job());

      expect(jobs.fail).toHaveBeenCalledWith('job1', {
        message: 'corrupt source',
        errorClass: 'TERMINAL',
      });
    });

    it('treats an unclassified error as retryable rather than throwing work away', async () => {
      const { worker, jobs, processing } = makeWorker();
      processing.process.mockRejectedValue(new Error('who knows'));

      await worker['run'](job());

      expect(jobs.fail.mock.calls[0][1].errorClass).toBe('RETRYABLE');
    });
  });

  describe('shutdown', () => {
    it('stops the poll timer', async () => {
      const { worker } = makeWorker();
      worker.onModuleInit();
      expect(worker['timer']).not.toBeNull();

      await worker.onModuleDestroy();

      expect(worker['timer']).toBeNull();
    });

    /**
     * The whole point of enabling shutdown hooks: a redeploy that kills ffmpeg
     * halfway throws away everything it had done. The lease makes that
     * recoverable, but recoverable still costs the teacher minutes.
     */
    it('waits for an in-flight encode before resolving', async () => {
      const { worker, processing } = makeWorker();
      let finish: () => void = () => undefined;
      processing.process.mockReturnValue(new Promise<void>((r) => (finish = r)));

      const running = worker['run'](job());
      worker['active'] = 1;
      void running.finally(() => (worker['active'] = 0));

      let drained = false;
      const drain = worker.onModuleDestroy().then(() => (drained = true));

      await new Promise((r) => setTimeout(r, 50));
      expect(drained).toBe(false); // still waiting on the encode

      finish();
      await drain;
      expect(drained).toBe(true);
    });

    it('gives up after the drain timeout rather than blocking the deploy forever', async () => {
      jest.useFakeTimers();
      const { worker } = makeWorker();
      worker['active'] = 1; // never completes

      const drain = worker.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(31_000);

      await expect(drain).resolves.toBeUndefined();
      // The abandoned job is safe: its lease expires and another replica takes it.
      expect(worker['logger'].warn).toHaveBeenCalledWith(expect.stringContaining('lease'));
    });

    it('claims nothing new once stopping', async () => {
      const { worker, jobs } = makeWorker();
      jobs.claimNext.mockResolvedValue(job());
      worker['stopping'] = true;

      await worker['tick']();

      expect(jobs.claimNext).not.toHaveBeenCalled();
    });
  });
});
