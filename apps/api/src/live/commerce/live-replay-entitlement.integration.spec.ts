import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { assertLiveReplayKey } from '../../playback/live-replay-access';
import { LiveReplayService } from '../replay/live-replay.service';
import { paidReplayVerdict } from './replay-entitlement';
import { commerceStack, commerceWorld, fundWallet } from './testing';

/**
 * Replay entitlement for paid seats: the frozen policy, the window, and a
 * refund revoking it — checked on the key endpoint's own function, which is
 * asked for every segment key, not only when a replay starts.
 */
const prisma = new PrismaService();
let available = true;
let S: ReturnType<typeof commerceStack>;

beforeAll(async () => {
  try {
    await prisma.onModuleInit();
    await prisma.livePurchase.count();
    S = commerceStack(prisma);
  } catch {
    available = false;
  }
});
afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
});
const guard = () => {
  if (!available) console.warn('skipping: no database reachable at DATABASE_URL');
  return available;
};

describe('paidReplayVerdict', () => {
  const s = { startsAt: new Date('2026-09-01T10:00:00Z'), durationMin: 60, endedAt: new Date('2026-09-01T11:00:00Z') };
  const at = (iso: string) => new Date(iso).getTime();
  it('keeps free bookings on their old rules', () => {
    expect(paidReplayVerdict(null, s)).toEqual({ ok: true });
  });
  it('reads the frozen policy and window', () => {
    const p = (replayPolicy: string, replayDays: number | null = null, status = 'DELIVERED') => ({ status, replayPolicy, replayDays });
    expect(paidReplayVerdict(p('INCLUDED_FOREVER'), s, at('2030-01-01T00:00:00Z')).ok).toBe(true);
    expect(paidReplayVerdict(p('NONE'), s).ok).toBe(false);
    expect(paidReplayVerdict(p('INCLUDED_DAYS', 7), s, at('2026-09-08T10:59:00Z')).ok).toBe(true);
    expect(paidReplayVerdict(p('INCLUDED_DAYS', 7), s, at('2026-09-08T11:01:00Z'))).toEqual({ ok: false, reason: 'replay window over' });
    for (const st of ['REFUNDED', 'CANCELLED_BY_STUDENT', 'CANCELLED_BY_TEACHER', 'OVERSOLD', 'PAYMENT_PENDING', 'HELD']) {
      expect(paidReplayVerdict(p('INCLUDED_FOREVER', null, st), s).ok).toBe(false);
    }
  });
});

async function replayWorld(opts: { replayPolicy: 'NONE' | 'INCLUDED_FOREVER' | 'INCLUDED_DAYS'; replayDays?: number | null; endedDaysAgo?: number }) {
  const w = await commerceWorld(prisma, {
    replayPolicy: opts.replayPolicy,
    replayDays: opts.replayDays ?? null,
    startsInMs: 2 * 86_400_000,
  });
  const st = w.students[0];
  await fundWallet(prisma, S.ledger, st.sp.id, 50_000);
  const p = await S.commerce.payWithWallet(st.user.id, w.session.id);
  const endedAt = new Date(Date.now() - (opts.endedDaysAgo ?? 0) * 86_400_000);
  await prisma.liveSession.update({
    where: { id: w.session.id },
    data: {
      status: 'ENDED',
      startsAt: new Date(endedAt.getTime() - 3600_000),
      startedAt: new Date(endedAt.getTime() - 3600_000),
      endedAt,
      recordingVisibility: 'STUDENTS',
    },
  });
  const claims = { sid: '', wm: `DRS-L-${randomUUID().slice(0, 8)}`, uid: st.user.id, aid: `asset-${randomUUID()}` };
  const r = await prisma.liveReplaySession.create({
    data: {
      watermarkId: claims.wm,
      liveSessionId: w.session.id,
      recordingId: `rec-${randomUUID()}`,
      videoAssetId: claims.aid,
      userId: st.user.id,
      role: 'STUDENT',
      tenantId: w.tp.id,
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  claims.sid = r.id;
  return { w, st, p, claims: claims as any };
}

describe('Paid replay on Postgres (the key endpoint’s check)', () => {
  it('a seat with replay included may fetch keys; one without may not', async () => {
    if (!guard()) return;
    const yes = await replayWorld({ replayPolicy: 'INCLUDED_FOREVER' });
    await expect(assertLiveReplayKey(prisma as any, yes.claims)).resolves.toBeUndefined();
    const no = await replayWorld({ replayPolicy: 'NONE' });
    await expect(assertLiveReplayKey(prisma as any, no.claims)).rejects.toThrow(/replay not included/);
  });

  it('INCLUDED_DAYS: inside the window yes, after it no', async () => {
    if (!guard()) return;
    const inside = await replayWorld({ replayPolicy: 'INCLUDED_DAYS', replayDays: 3, endedDaysAgo: 1 });
    await expect(assertLiveReplayKey(prisma as any, inside.claims)).resolves.toBeUndefined();
    const after = await replayWorld({ replayPolicy: 'INCLUDED_DAYS', replayDays: 3, endedDaysAgo: 5 });
    await expect(assertLiveReplayKey(prisma as any, after.claims)).rejects.toThrow(/window over/);
  });

  it('a refund revokes the replay, even one already running', async () => {
    if (!guard()) return;
    const r = await replayWorld({ replayPolicy: 'INCLUDED_FOREVER' });
    await expect(assertLiveReplayKey(prisma as any, r.claims)).resolves.toBeUndefined();
    await S.commerce.adminRefund(r.p.id, 'admin');
    await expect(assertLiveReplayKey(prisma as any, r.claims)).rejects.toThrow();
  });

  it('the teacher’s own sharing switch still rules: an unshared recording stays unshared', async () => {
    if (!guard()) return;
    const r = await replayWorld({ replayPolicy: 'INCLUDED_FOREVER' });
    await prisma.liveSession.update({ where: { id: r.w.session.id }, data: { recordingVisibility: 'PRIVATE' } });
    await expect(assertLiveReplayKey(prisma as any, r.claims)).rejects.toThrow(/not shared/);
  });

  it('starting a replay is refused for a seat that does not include it', async () => {
    if (!guard()) return;
    const r = await replayWorld({ replayPolicy: 'NONE' });
    const replays = new LiveReplayService(prisma, S.live, {} as any);
    await expect(replays.start({ sub: r.st.user.id }, r.w.session.id, {})).rejects.toMatchObject({
      response: { code: 'REPLAY_NOT_INCLUDED' },
    });
  });

  it('a live purchase never grants course access', async () => {
    if (!guard()) return;
    const r = await replayWorld({ replayPolicy: 'INCLUDED_FOREVER' });
    expect(await prisma.enrollment.count({ where: { studentId: r.st.sp.id } })).toBe(0);
  });
});
