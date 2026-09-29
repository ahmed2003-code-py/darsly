import { randomUUID } from 'crypto';
import { databaseReady } from '../common/testing/db-available';
import { AchievementsService } from '../gamification/achievements.service';
import { ensureGamificationReferenceData } from '../gamification/gamification-reference-data';
import { GamificationConfigService } from '../gamification/gamification.config.service';
import { GamificationService } from '../gamification/gamification.service';
import { LeaderboardService } from '../gamification/leaderboard.service';
import { MissionsService } from '../gamification/missions.service';
import { PrismaService } from '../prisma/prisma.service';
import { LiveBonusService } from './bonus/live-bonus.service';
import {
  classroom,
  classroomWorld,
  codeOf,
  confirmedGuest,
  enterRoom,
  type ClassroomWorld,
} from './testing/classroom';

/**
 * Live V1 Phase D on a real PostgreSQL: "مكافأة". Points go through the one
 * door of the gamification economy (GamificationEvent + StudentGamification),
 * exactly once per click, within the rule's limits even under two teacher
 * tabs — and never touch money.
 */
const prisma = new PrismaService();
let available = true;
let engine: GamificationService;
let config: GamificationConfigService;

beforeAll(async () => {
  available = await databaseReady(prisma, [
    'gamificationEvent',
    'studentGamification',
    'xpRule',
    'liveSession',
  ]);
  if (!available) return;
  await prisma.onModuleInit();
  await ensureGamificationReferenceData(prisma);
  config = new GamificationConfigService(prisma);
  engine = new GamificationService(
    prisma,
    config,
    new AchievementsService(prisma),
    new MissionsService(prisma),
    new LeaderboardService(prisma),
    { create: async () => ({}), pushUnread: () => undefined } as never,
  );
}, 60_000);
afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
});
const guard = () => {
  if (!available) console.warn('skipping: no database reachable at DATABASE_URL');
  return available;
};

function build() {
  const c = classroom(prisma, { gamification: engine });
  const bonus = new LiveBonusService(prisma, c.live, c.rtc, engine, config, c.realtime as never);
  return { ...c, bonus };
}
const grant = (
  b: LiveBonusService,
  w: ClassroomWorld,
  actor: string,
  student: string,
  points: number,
  requestId = randomUUID(),
) =>
  b.grant(actor, w.ls.id, {
    studentUserId: student,
    points,
    reasonKey: 'CORRECT_ANSWER',
    requestId,
  });

async function inClass(c: ReturnType<typeof build>, w: ClassroomWorld) {
  for (const s of w.s) await enterRoom(prisma, c, w, s.id);
}
const wallet = async (studentId: string) =>
  (await prisma.studentGamification.findUnique({ where: { studentId } })) ?? { coins: 0, xp: 0 };

/** Every money table, counted — and the ledger's sums. */
async function moneySnapshot() {
  const [payments, txns, entries, walletTxns, topups, payouts, refunds, sums] = await Promise.all([
    prisma.payment.count(),
    prisma.ledgerTransaction.count(),
    prisma.ledgerEntry.count(),
    prisma.walletTransaction.count(),
    prisma.walletTopup.count(),
    prisma.payoutRequest.count(),
    prisma.refund.count(),
    prisma.ledgerEntry.groupBy({ by: ['direction'], _sum: { amountCents: true } }),
  ]);
  return {
    payments,
    txns,
    entries,
    walletTxns,
    topups,
    payouts,
    refunds,
    sums: JSON.stringify(sums),
  };
}

describe('Live Bonus', () => {
  it('a +5 for a correct answer: coins and XP through the economy, one event, the student told', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const c = build();
    await inClass(c, w);
    const rule = await prisma.xpRule.findUniqueOrThrow({ where: { event: 'LIVE_BONUS' } });
    const before = await wallet(w.sp[0].id);
    const out = await grant(c.bonus, w, w.teacher.id, w.s[0].id, 5);
    expect(out).toMatchObject({
      granted: true,
      duplicate: false,
      studentTotal: 5,
      classTotal: 5,
      studentRemaining: 15,
    });
    const after = await wallet(w.sp[0].id);
    expect(after.coins - before.coins).toBe(5 * rule.coins);
    expect(after.xp - before.xp).toBe(5 * rule.xp);
    const ev = await prisma.gamificationEvent.findMany({
      where: { studentId: w.sp[0].id, type: 'LIVE_BONUS' },
    });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      entityType: 'liveSession',
      entityId: w.ls.id,
      coinsAwarded: 5 * rule.coins,
    });
    expect(ev[0].meta).toMatchObject({
      points: 5,
      reasonKey: 'CORRECT_ANSWER',
      grantedBy: w.teacher.id,
    });
    expect(c.events).toContainEqual(
      expect.objectContaining({
        to: 'user',
        id: w.s[0].id,
        event: 'live:bonus',
        payload: expect.objectContaining({ points: 5, total: 5 }),
      }),
    );
    // The panel shows it on the row; the student sees their own total.
    const st = await c.rtc.state(w.teacher.id, w.ls.id);
    expect(st.participants.find((p) => p.userId === w.s[0].id)?.bonus).toBe(5);
    expect((await c.rtc.state(w.s[0].id, w.ls.id)).me.bonus).toBe(5);
  });

  it('never touches money: Payment, ledger, wallet, top-ups, payouts, refunds all unchanged', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const c = build();
    await inClass(c, w);
    const before = await moneySnapshot();
    const gamBefore = await prisma.gamificationEvent.count();
    await grant(c.bonus, w, w.teacher.id, w.s[0].id, 3);
    await grant(c.bonus, w, w.teacher.id, w.s[1].id, 10);
    expect(await moneySnapshot()).toEqual(before);
    expect(await prisma.gamificationEvent.count()).toBeGreaterThanOrEqual(gamBefore + 2);
  });

  it('the same click again (network retry, double-submit) is one award', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const c = build();
    await inClass(c, w);
    const id = randomUUID();
    const results = await Promise.all(
      [1, 2, 3].map(() => grant(c.bonus, w, w.teacher.id, w.s[0].id, 2, id)),
    );
    expect(results.filter((r) => r.granted)).toHaveLength(1);
    expect(results.filter((r) => r.duplicate)).toHaveLength(2);
    expect(
      await prisma.gamificationEvent.count({
        where: { studentId: w.sp[0].id, type: 'LIVE_BONUS' },
      }),
    ).toBe(1);
    // Two deliberate clicks are two awards.
    await grant(c.bonus, w, w.teacher.id, w.s[0].id, 2);
    expect(
      await prisma.gamificationEvent.count({
        where: { studentId: w.sp[0].id, type: 'LIVE_BONUS' },
      }),
    ).toBe(2);
  });

  it('caps hold under concurrency: two teacher tabs racing for the last points of a student', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const c = build();
    await inClass(c, w);
    await grant(c.bonus, w, w.teacher.id, w.s[0].id, 10);
    await grant(c.bonus, w, w.teacher.id, w.s[0].id, 6); // 16 of 20
    const racing = await Promise.allSettled(
      Array.from({ length: 6 }, () => grant(c.bonus, w, w.teacher.id, w.s[0].id, 2)),
    );
    const ok = racing.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBe(2); // 16 + 2 + 2 = 20
    expect(
      racing
        .filter((r) => r.status === 'rejected')
        .every((r) => (r as PromiseRejectedResult).reason?.response?.code === 'BONUS_STUDENT_CAP'),
    ).toBe(true);
    const total = await prisma.$queryRaw<{ p: bigint }[]>`
      SELECT SUM((meta->>'points')::int) AS p FROM "GamificationEvent" WHERE type='LIVE_BONUS' AND "entityId"=${w.ls.id}`;
    expect(Number(total[0].p)).toBe(20);
  });

  it('the class total is capped too, and every limit comes from the rule an admin can change', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const c = build();
    await inClass(c, w);
    await prisma.xpRule.update({
      where: { event: 'LIVE_BONUS' },
      data: { maxPerEntity: 12, maxPerAward: 7 },
    });
    config.invalidate();
    try {
      expect(await codeOf(grant(c.bonus, w, w.teacher.id, w.s[0].id, 8))).toBe('BONUS_INVALID');
      await grant(c.bonus, w, w.teacher.id, w.s[0].id, 7);
      await grant(c.bonus, w, w.teacher.id, w.s[1].id, 5);
      expect(await codeOf(grant(c.bonus, w, w.teacher.id, w.s[2].id, 1))).toBe('BONUS_CLASS_CAP');
      // Switched off by the admin: refused, nothing paid.
      await prisma.xpRule.update({ where: { event: 'LIVE_BONUS' }, data: { isActive: false } });
      config.invalidate();
      expect(await codeOf(grant(c.bonus, w, w.teacher.id, w.s[2].id, 1))).toBe('BONUS_DISABLED');
    } finally {
      await prisma.xpRule.update({
        where: { event: 'LIVE_BONUS' },
        data: { maxPerEntity: 300, maxPerAward: 10, isActive: true },
      });
      config.invalidate();
    }
  });

  it('who: a moderator only — never a student, never an assistant without live.manage', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const c = build();
    await inClass(c, w);
    expect(await codeOf(grant(c.bonus, w, w.s[1].id, w.s[0].id, 1))).toBe('NOT_A_MODERATOR');
    expect(await codeOf(grant(c.bonus, w, w.assistant.id, w.s[0].id, 1))).toBe('NOT_A_MODERATOR');
    expect(
      await prisma.gamificationEvent.count({ where: { type: 'LIVE_BONUS', entityId: w.ls.id } }),
    ).toBe(0);
  });

  it('to whom: a guest has no points balance (and none is made); an absent student and an outsider are refused', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma, { accessMode: 'FREE' });
    const c = build();
    const g = await confirmedGuest(prisma, w, 'ضيف');
    await enterRoom(prisma, c, w, g.id);
    const profilesBefore = await prisma.studentProfile.count();
    const e = await grant(c.bonus, w, w.teacher.id, g.id, 1).catch((x) => x);
    expect(e.response).toMatchObject({ code: 'BONUS_NOT_ELIGIBLE', reason: 'GUEST' });
    expect(await prisma.studentProfile.count()).toBe(profilesBefore);
    // Booked but never in the room.
    const absent = await grant(c.bonus, w, w.teacher.id, w.s[0].id, 1).catch((x) => x);
    expect(absent.response).toMatchObject({ code: 'BONUS_NOT_ELIGIBLE', reason: 'NOT_PRESENT' });
    const outsider = await grant(c.bonus, w, w.teacher.id, w.outsider.id, 1).catch((x) => x);
    expect(outsider.response).toMatchObject({
      code: 'BONUS_NOT_ELIGIBLE',
      reason: 'NOT_A_STUDENT',
    });
    // The panel knows who is a guest (so the action is disabled with a reason).
    const st = await c.rtc.state(w.teacher.id, w.ls.id);
    expect(st.participants.find((p) => p.userId === g.id)?.guest).toBe(true);
  });

  it("the class's record: history, and bonus on each attendance row", async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const c = build();
    await inClass(c, w);
    await grant(c.bonus, w, w.teacher.id, w.s[0].id, 2);
    await c.bonus.grant(w.teacher.id, w.ls.id, {
      studentUserId: w.s[0].id,
      points: 3,
      reason: '  حل السؤال بطريقة جميلة ',
      requestId: randomUUID(),
    });
    const h = await c.bonus.history(w.ls.id);
    expect(h.map((x) => x.points)).toEqual([3, 2]);
    expect(h[0]).toMatchObject({
      reason: 'حل السؤال بطريقة جميلة',
      grantedByName: w.teacher.fullName,
      studentUserId: w.s[0].id,
    });
    const row = (await c.live.attendanceFor(w.scope, w.ls.id)).rows.find(
      (r) => r.userId === w.s[0].id,
    );
    expect(row?.bonusPoints).toBe(5);
  });
});
