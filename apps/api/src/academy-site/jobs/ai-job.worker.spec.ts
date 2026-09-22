import { AiJobWorker } from './ai-job.worker';

/**
 * Shutdown behaviour for the AI worker.
 *
 * It already claimed jobs safely across replicas and already retried them —
 * what it did not do is wait. `onModuleDestroy` cleared the poll timer and
 * returned, so every redeploy abandoned whatever was mid-flight. The lease
 * makes that recoverable, but a generation most of the way through an OpenAI
 * call is re-run from the start and paid for twice.
 */
function makeWorker() {
  const config = { enabled: true, workerEnabled: true, workerConcurrency: 3 } as any;
  const jobs = { claimNext: jest.fn().mockResolvedValue(null) } as any;
  const worker = new AiJobWorker(config, jobs, []);
  jest.spyOn(worker['logger'], 'log').mockImplementation(() => undefined);
  jest.spyOn(worker['logger'], 'warn').mockImplementation(() => undefined);
  jest.spyOn(worker['logger'], 'error').mockImplementation(() => undefined);
  return { worker, jobs, config };
}

describe('AiJobWorker — shutdown', () => {
  afterEach(() => jest.useRealTimers());

  it('clears the poll timer', async () => {
    const { worker } = makeWorker();
    worker.onModuleInit();
    expect(worker['timer']).not.toBeNull();

    await worker.onModuleDestroy();

    expect(worker['timer']).toBeNull();
  });

  it('returns immediately when nothing is in flight', async () => {
    const { worker } = makeWorker();

    await expect(worker.onModuleDestroy()).resolves.toBeUndefined();
  });

  it('waits for an in-flight job rather than abandoning it', async () => {
    const { worker } = makeWorker();
    worker['active'] = 1;

    let drained = false;
    const drain = worker.onModuleDestroy().then(() => (drained = true));

    await new Promise((r) => setTimeout(r, 60));
    expect(drained).toBe(false);

    worker['active'] = 0;
    await drain;
    expect(drained).toBe(true);
  });

  it('gives up after the drain timeout instead of blocking the deploy', async () => {
    jest.useFakeTimers();
    const { worker } = makeWorker();
    worker['active'] = 1; // never finishes

    const drain = worker.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(31_000);

    await expect(drain).resolves.toBeUndefined();
    // Abandoning is safe — the lease is what makes it so, and the log says so.
    expect(worker['logger'].warn).toHaveBeenCalledWith(expect.stringContaining('lease'));
  });

  /**
   * Draining is pointless if the same tick immediately claims something new.
   */
  it('claims no further work once stopping', async () => {
    const { worker, jobs } = makeWorker();
    jobs.claimNext.mockResolvedValue({ id: 'j1', type: 'SITE_GENERATE' });
    worker['stopping'] = true;

    await worker['tick']();

    expect(jobs.claimNext).not.toHaveBeenCalled();
  });
});
