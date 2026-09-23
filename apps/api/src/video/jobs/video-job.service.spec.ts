import { Prisma } from '@prisma/client';
import { MAX_ATTEMPTS, VideoJobService } from './video-job.service';

/**
 * The parts of the queue that are decisions rather than database behaviour:
 * how a duplicate enqueue is answered, when a failure earns another attempt,
 * and how long it waits. The claiming itself is a property of Postgres and is
 * proved against a real one in `video-job.integration.spec.ts`.
 */
function prismaError(code: string) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code,
    clientVersion: '5.22.0',
  });
}

function makePrisma() {
  return {
    videoJob: {
      create: jest.fn(async ({ data }: any) => ({ id: 'job1', attempts: 0, ...data })),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(async ({ data }: any) => ({ id: 'job1', ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $queryRaw: jest.fn(),
  } as any;
}

describe('VideoJobService', () => {
  let prisma: any;
  let svc: VideoJobService;

  beforeEach(() => {
    prisma = makePrisma();
    svc = new VideoJobService(prisma);
    jest.spyOn(svc['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(svc['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(svc['logger'], 'error').mockImplementation(() => undefined);
  });

  describe('enqueue', () => {
    it('writes a QUEUED PACKAGE job for the asset', async () => {
      const job = await svc.enqueue('asset1', 'tenant1');

      expect(prisma.videoJob.create).toHaveBeenCalledWith({
        data: { videoAssetId: 'asset1', tenantId: 'tenant1', type: 'PACKAGE', status: 'QUEUED' },
      });
      expect(job.status).toBe('QUEUED');
    });

    /**
     * Deduplication is the database's answer, not the application's: a
     * read-then-write check is exactly what two concurrent uploads would both
     * pass. The partial unique index rejects the second insert, and this is
     * how that rejection is turned into "here is the job you already have".
     */
    it('returns the existing live job instead of creating a second one', async () => {
      const existing = { id: 'job-existing', videoAssetId: 'asset1', status: 'RUNNING' };
      prisma.videoJob.create.mockRejectedValueOnce(prismaError('P2002'));
      prisma.videoJob.findFirst.mockResolvedValueOnce(existing);

      const job = await svc.enqueue('asset1', 'tenant1');

      expect(job).toBe(existing);
      expect(prisma.videoJob.findFirst).toHaveBeenCalledWith({
        where: { videoAssetId: 'asset1', status: { in: ['QUEUED', 'RUNNING'] } },
      });
    });

    it('rethrows a P2002 that is not an active-job collision rather than inventing a job', async () => {
      prisma.videoJob.create.mockRejectedValueOnce(prismaError('P2002'));
      prisma.videoJob.findFirst.mockResolvedValueOnce(null);

      await expect(svc.enqueue('asset1', 'tenant1')).rejects.toBeInstanceOf(
        Prisma.PrismaClientKnownRequestError,
      );
    });

    it('uses the caller transaction when one is given, so asset and job commit together', async () => {
      const tx = { videoJob: { create: jest.fn().mockResolvedValue({ id: 'jobTx' }) } } as any;

      await svc.enqueue('asset1', 'tenant1', tx);

      expect(tx.videoJob.create).toHaveBeenCalled();
      expect(prisma.videoJob.create).not.toHaveBeenCalled();
    });
  });

  describe('fail — retry, backoff, and giving up', () => {
    it('re-queues a RETRYABLE failure with exponential backoff', async () => {
      // attempts is incremented by the claim, so 1 means "first attempt just ran".
      prisma.videoJob.findUnique.mockResolvedValue({ id: 'job1', attempts: 1 });
      const before = Date.now();

      const willRetry = await svc.fail('job1', { message: 'storage timeout', errorClass: 'RETRYABLE' });

      expect(willRetry).toBe(true);
      const data = prisma.videoJob.update.mock.calls[0][0].data;
      expect(data.status).toBe('QUEUED');
      expect(data.leaseExpiresAt).toBeNull();
      // 30s for the first retry.
      expect((data.nextRunAt as Date).getTime() - before).toBeGreaterThanOrEqual(29_000);
      expect((data.nextRunAt as Date).getTime() - before).toBeLessThan(35_000);
    });

    it('doubles the wait on each subsequent attempt', async () => {
      prisma.videoJob.findUnique.mockResolvedValue({ id: 'job1', attempts: 2 });
      const before = Date.now();

      await svc.fail('job1', { message: 'again', errorClass: 'RETRYABLE' });

      const data = prisma.videoJob.update.mock.calls[0][0].data;
      expect((data.nextRunAt as Date).getTime() - before).toBeGreaterThanOrEqual(59_000);
      expect((data.nextRunAt as Date).getTime() - before).toBeLessThan(65_000);
    });

    it('stops retrying once the attempt cap is reached', async () => {
      prisma.videoJob.findUnique.mockResolvedValue({ id: 'job1', attempts: MAX_ATTEMPTS });

      const willRetry = await svc.fail('job1', { message: 'still broken', errorClass: 'RETRYABLE' });

      expect(willRetry).toBe(false);
      expect(prisma.videoJob.update.mock.calls[0][0].data.status).toBe('FAILED');
    });

    /**
     * A corrupt source is corrupt on every attempt. Retrying it three times
     * burns a CPU core three times to reach the same answer.
     */
    it('never retries a TERMINAL failure, even on the first attempt', async () => {
      prisma.videoJob.findUnique.mockResolvedValue({ id: 'job1', attempts: 1 });

      const willRetry = await svc.fail('job1', { message: 'corrupt source', errorClass: 'TERMINAL' });

      expect(willRetry).toBe(false);
      expect(prisma.videoJob.update.mock.calls[0][0].data.status).toBe('FAILED');
    });

    it('truncates a runaway error message rather than storing it whole', async () => {
      prisma.videoJob.findUnique.mockResolvedValue({ id: 'job1', attempts: MAX_ATTEMPTS });

      await svc.fail('job1', { message: 'x'.repeat(5_000), errorClass: 'TERMINAL' });

      expect((prisma.videoJob.update.mock.calls[0][0].data.error as string).length).toBe(1_000);
    });
  });

  describe('lease', () => {
    it('renews only a job that is still RUNNING', async () => {
      await svc.renewLease('job1', 60_000);

      expect(prisma.videoJob.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'job1', status: 'RUNNING' } }),
      );
    });
  });

  describe('requeue — the dead-letter path', () => {
    it('resets attempts and clears the error so a dead job can run again', async () => {
      await svc.requeue('job1');

      const data = prisma.videoJob.update.mock.calls[0][0].data;
      expect(data).toMatchObject({ status: 'QUEUED', attempts: 0, error: null, errorClass: null });
    });
  });
});
