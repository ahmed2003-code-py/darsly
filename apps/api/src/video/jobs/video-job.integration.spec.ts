import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { VideoJobService } from './video-job.service';

/**
 * The claims a mocked Prisma would happily agree with, and only Postgres can
 * settle.
 *
 * Deduplication is a partial unique index. Safe claiming across replicas is
 * `FOR UPDATE SKIP LOCKED`. Crash recovery is a lease comparison inside that
 * same statement. Every one of them is a property of the database, so they are
 * exercised against a real one — and skipped, not failed, when there isn't one,
 * the way `gamification.integration.spec.ts` already does.
 */
const prisma = new PrismaService();
let available = true;
let svc: VideoJobService;

const created: string[] = [];

async function makeAsset(status: 'UPLOADING' | 'PROCESSING' | 'READY' = 'PROCESSING') {
  const asset = await prisma.videoAsset.create({
    data: { tenantId: `t-${randomUUID().slice(0, 8)}`, originalKey: `source/${randomUUID()}.mp4`, status },
  });
  created.push(asset.id);
  return asset;
}

beforeAll(async () => {
  try {
    await prisma.$connect();
    // Probe the table this suite actually needs, not just connectivity: a
    // database that is reachable but behind on migrations should skip here
    // rather than fail every test with a column error.
    await prisma.videoJob.count();
  } catch {
    available = false;
  }
});

afterAll(async () => {
  if (available && created.length) {
    // VideoJob rows cascade with the asset.
    await prisma.videoAsset.deleteMany({ where: { id: { in: created } } }).catch(() => undefined);
  }
  await prisma.$disconnect().catch(() => undefined);
});

const guard = () => {
  if (!available) {
    // eslint-disable-next-line no-console
    console.warn('skipping: no database reachable at DATABASE_URL');
  }
  return available;
};

describe('VideoJob against a real database', () => {
  /**
   * Claiming is deliberately global — the oldest due job anywhere wins, which
   * is what makes several replicas share one queue. That makes every test here
   * a potential thief of the previous test's leftovers, so each starts from a
   * queue containing only its own job. Scoped to the assets this suite made,
   * never a blanket delete.
   */
  beforeEach(async () => {
    if (available && created.length) {
      await prisma.videoJob.deleteMany({ where: { videoAssetId: { in: created } } });
    }
    svc = new VideoJobService(prisma);
    jest.spyOn(svc['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(svc['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(svc['logger'], 'error').mockImplementation(() => undefined);
  });

  it('enqueues a claimable job', async () => {
    if (!guard()) return;
    const asset = await makeAsset();

    const job = await svc.enqueue(asset.id, asset.tenantId);

    expect(job.status).toBe('QUEUED');
    expect(job.attempts).toBe(0);
  });

  /**
   * The index, not the application, is what makes this true — which is why it
   * cannot be proved with a mock.
   */
  it('refuses a second live job for the same asset, and hands back the first', async () => {
    if (!guard()) return;
    const asset = await makeAsset();

    const first = await svc.enqueue(asset.id, asset.tenantId);
    const second = await svc.enqueue(asset.id, asset.tenantId);

    expect(second.id).toBe(first.id);
    expect(await prisma.videoJob.count({ where: { videoAssetId: asset.id } })).toBe(1);
  });

  it('two simultaneous enqueues still produce exactly one job', async () => {
    if (!guard()) return;
    const asset = await makeAsset();

    const [a, b] = await Promise.all([
      svc.enqueue(asset.id, asset.tenantId),
      svc.enqueue(asset.id, asset.tenantId),
    ]);

    expect(a.id).toBe(b.id);
    expect(await prisma.videoJob.count({ where: { videoAssetId: asset.id } })).toBe(1);
  });

  it('allows a fresh job once the previous one has finished', async () => {
    if (!guard()) return;
    const asset = await makeAsset();
    const first = await svc.enqueue(asset.id, asset.tenantId);
    await svc.succeed(first.id);

    const second = await svc.enqueue(asset.id, asset.tenantId);

    // The unique index is partial, so a finished job never blocks a re-run.
    expect(second.id).not.toBe(first.id);
    expect(await prisma.videoJob.count({ where: { videoAssetId: asset.id } })).toBe(2);
  });

  it('claims a due job, marking it RUNNING with a lease and an incremented attempt', async () => {
    if (!guard()) return;
    const asset = await makeAsset();
    await svc.enqueue(asset.id, asset.tenantId);

    const claimed = await svc.claimNext(60_000);

    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe('RUNNING');
    expect(claimed!.attempts).toBe(1);
    expect(claimed!.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  /**
   * SKIP LOCKED is the whole reason several Railway replicas can run this
   * worker at once. Without it the second claimer blocks on the first's row
   * lock and then takes the same job.
   */
  it('two concurrent claimers never take the same job', async () => {
    if (!guard()) return;
    const asset = await makeAsset();
    const job = await svc.enqueue(asset.id, asset.tenantId);

    const [a, b] = await Promise.all([svc.claimNext(60_000), svc.claimNext(60_000)]);

    const got = [a, b].filter((j) => j?.id === job.id);
    expect(got).toHaveLength(1);
  });

  it('does not claim a job whose backoff has not elapsed', async () => {
    if (!guard()) return;
    const asset = await makeAsset();
    const job = await svc.enqueue(asset.id, asset.tenantId);
    await prisma.videoJob.update({
      where: { id: job.id },
      data: { nextRunAt: new Date(Date.now() + 60_000) },
    });

    const claimed = await svc.claimNext(60_000);

    expect(claimed?.id).not.toBe(job.id);
  });

  /**
   * The crash case, which is the defect this whole change exists to fix: a
   * worker that claimed the job and died — a redeploy mid-ffmpeg, an OOM kill
   * — leaves a RUNNING row nobody is working on. Once the lease lapses it has
   * to become somebody else's.
   */
  it('re-claims a RUNNING job whose lease expired, and counts the attempt', async () => {
    if (!guard()) return;
    const asset = await makeAsset();
    const job = await svc.enqueue(asset.id, asset.tenantId);
    await svc.claimNext(60_000); // a worker takes it…
    await prisma.videoJob.update({
      where: { id: job.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) }, // …and dies
    });

    const reclaimed = await svc.claimNext(60_000);

    expect(reclaimed!.id).toBe(job.id);
    expect(reclaimed!.attempts).toBe(2);
  });

  it('does not steal a RUNNING job whose lease is still alive', async () => {
    if (!guard()) return;
    const asset = await makeAsset();
    const job = await svc.enqueue(asset.id, asset.tenantId);
    await svc.claimNext(60_000);

    const stolen = await svc.claimNext(60_000);

    expect(stolen?.id).not.toBe(job.id);
  });

  it('a heartbeat pushes the lease out, keeping a long encode safe', async () => {
    if (!guard()) return;
    const asset = await makeAsset();
    const job = await svc.enqueue(asset.id, asset.tenantId);
    const claimed = await svc.claimNext(10_000);

    await svc.renewLease(job.id, 120_000);

    const after = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.leaseExpiresAt!.getTime()).toBeGreaterThan(claimed!.leaseExpiresAt!.getTime());
  });

  it('a retry becomes claimable again once its backoff has passed', async () => {
    if (!guard()) return;
    const asset = await makeAsset();
    const job = await svc.enqueue(asset.id, asset.tenantId);
    await svc.claimNext(60_000);

    const willRetry = await svc.fail(job.id, { message: 'blip', errorClass: 'RETRYABLE' });
    expect(willRetry).toBe(true);

    // Not yet — the backoff is still running.
    expect((await svc.claimNext(60_000))?.id).not.toBe(job.id);

    await prisma.videoJob.update({ where: { id: job.id }, data: { nextRunAt: new Date(Date.now() - 1) } });
    expect((await svc.claimNext(60_000))?.id).toBe(job.id);
  });

  it('a requeued dead job starts over with a clean slate', async () => {
    if (!guard()) return;
    const asset = await makeAsset();
    const job = await svc.enqueue(asset.id, asset.tenantId);
    await svc.claimNext(60_000);
    await svc.fail(job.id, { message: 'corrupt', errorClass: 'TERMINAL' });

    const requeued = await svc.requeue(job.id);

    expect(requeued.status).toBe('QUEUED');
    expect(requeued.attempts).toBe(0);
    expect(requeued.error).toBeNull();
    expect((await svc.claimNext(60_000))?.id).toBe(job.id);
  });

  it('deleting the asset takes its jobs with it', async () => {
    if (!guard()) return;
    const asset = await makeAsset();
    await svc.enqueue(asset.id, asset.tenantId);

    await prisma.videoAsset.delete({ where: { id: asset.id } });

    expect(await prisma.videoJob.count({ where: { videoAssetId: asset.id } })).toBe(0);
  });
});
