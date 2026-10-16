import { randomUUID } from 'crypto';
import { databaseReady } from '../../common/testing/db-available';
import { PrismaService } from '../../prisma/prisma.service';
import { AiJobService } from './ai-job.service';

/**
 * Two "Generate" requests in the same instant (a double click, two tabs) on a
 * real PostgreSQL: exactly one job is queued, the other is told one is
 * already running. The check and the create used to be two steps, and both
 * requests found nothing running.
 */
const prisma = new PrismaService();
let available = true;

beforeAll(async () => {
  available = await databaseReady(prisma, ['aiJob', 'academy']);
  if (!available) return;
  await prisma.onModuleInit();
}, 30_000);
afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
});
const guard = () => {
  if (!available) console.warn('skipping: no database reachable at DATABASE_URL');
  return available;
};

async function academy() {
  const k = randomUUID().slice(0, 8);
  const owner = await prisma.user.create({
    data: { role: 'TEACHER', fullName: `T ${k}`, email: `aj-${k}@it.test` },
  });
  return prisma.academy.create({
    data: { slug: `aj-${k}`, name: `A ${k}`, ownerUserId: owner.id },
  });
}

/**
 * A service whose "is anything running?" answer arrives a beat late — the
 * window two HTTP requests race through. Without the lock every request
 * passes the check inside it; with it, the second waits for the first.
 */
function service() {
  const jobs = new AiJobService(prisma, { enabled: true, monthlyBudgetCents: 0 } as never);
  const late =
    <A extends unknown[]>(fn: (...a: A) => Promise<boolean>) =>
    async (...a: A) => {
      const busy = await fn(...a);
      await new Promise((r) => setTimeout(r, 60));
      return busy;
    };
  jobs.hasActiveJob = late(jobs.hasActiveJob.bind(jobs));
  jobs.hasActiveJobFor = late(jobs.hasActiveJobFor.bind(jobs));
  return jobs;
}

describe('AiJobService.enqueue under concurrency', () => {
  it('two simultaneous requests for one academy queue one job', async () => {
    if (!guard()) return;
    const a = await academy();
    const jobs = service();
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => jobs.enqueue(a.id, 'SITE_GENERATE', { pageKey: 'home' })),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(3);
    for (const r of refused) {
      expect((r.reason as { getResponse(): { code: string } }).getResponse().code).toBe(
        'AI_JOB_ACTIVE',
      );
    }
    expect(await prisma.aiJob.count({ where: { academyId: a.id } })).toBe(1);
  });

  it('the same piece of work is queued once; different pieces both queue', async () => {
    if (!guard()) return;
    const a = await academy();
    const jobs = service();
    const k1 = randomUUID();
    const k2 = randomUUID();
    const same = { sameInput: { path: 'liveSessionId', equals: k1 } };
    const results = await Promise.allSettled([
      jobs.enqueue(a.id, 'LIVE_SUMMARY', { liveSessionId: k1 }, same),
      jobs.enqueue(a.id, 'LIVE_SUMMARY', { liveSessionId: k1 }, same),
      jobs.enqueue(
        a.id,
        'LIVE_SUMMARY',
        { liveSessionId: k2 },
        { sameInput: { path: 'liveSessionId', equals: k2 } },
      ),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'fulfilled', 'rejected']);
    expect(await prisma.aiJob.count({ where: { academyId: a.id } })).toBe(2);
  });

  it('a finished job no longer blocks the next one', async () => {
    if (!guard()) return;
    const a = await academy();
    const jobs = service();
    const first = await jobs.enqueue(a.id, 'SITE_GENERATE', {});
    await prisma.aiJob.update({ where: { id: first.id }, data: { status: 'FAILED' } });
    await expect(jobs.enqueue(a.id, 'SITE_GENERATE', {})).resolves.toMatchObject({
      status: 'QUEUED',
    });
  });
});
