import { Prisma } from '@prisma/client';
import { GamificationService } from './gamification.service';

/**
 * The engine's rules, in isolation: what pays, what refuses to pay twice, and
 * what stops paying once a student is plainly farming rather than learning.
 */

const RULES: Record<string, any> = {
  LESSON_COMPLETED: { event: 'LESSON_COMPLETED', xp: 25, coins: 10, dailyCap: 300, perEntityLimit: 1, isActive: true },
  QUIZ_COMPLETED: { event: 'QUIZ_COMPLETED', xp: 20, coins: 5, dailyCap: 60, perEntityLimit: 0, isActive: true },
  MISSION_COMPLETED: { event: 'MISSION_COMPLETED', xp: 50, coins: 25, dailyCap: 0, perEntityLimit: 1, isActive: true },
  LEVEL_UP: { event: 'LEVEL_UP', xp: 0, coins: 0, dailyCap: 0, perEntityLimit: 1, isActive: true },
  RETIRED: { event: 'RETIRED', xp: 10, coins: 0, dailyCap: 0, perEntityLimit: 1, isActive: false },
};

const TIERS = [
  { level: 1, minXp: 0, nameAr: 'مبتدئ', nameEn: 'Starter', icon: 'egg', coinReward: 0 },
  { level: 2, minXp: 100, nameAr: 'مستكشف', nameEn: 'Explorer', icon: 'explore', coinReward: 25 },
  { level: 3, minXp: 500, nameAr: 'دارس', nameEn: 'Learner', icon: 'menu_book', coinReward: 50 },
];

function makeCtx(opts: { agg?: any; priorSameEntity?: number; xpSpentToday?: number } = {}) {
  const agg = opts.agg ?? { studentId: 's1', xp: 0, level: 1, coins: 0, bestRank: null };
  const created: any[] = [];

  const tx: any = {
    gamificationEvent: {
      create: jest.fn((args: any) => {
        created.push(args.data);
        return Promise.resolve(args.data);
      }),
    },
    studentGamification: {
      upsert: jest.fn((args: any) => {
        const xpInc = args.update?.xp?.increment ?? 0;
        agg.xp += xpInc;
        return Promise.resolve({ ...agg });
      }),
    },
    leaderboardEntry: { upsert: jest.fn().mockResolvedValue({}) },
  };

  const prisma: any = {
    $transaction: jest.fn((fn: any) => fn(tx)),
    gamificationEvent: {
      count: jest.fn().mockResolvedValue(opts.priorSameEntity ?? 0),
      aggregate: jest.fn().mockResolvedValue({ _sum: { xpAwarded: opts.xpSpentToday ?? 0 } }),
      create: jest.fn().mockResolvedValue({}),
    },
    studentGamification: {
      findUnique: jest.fn(() => Promise.resolve({ ...agg })),
      // Mirrors the real guarded write: the promotion only takes once.
      updateMany: jest.fn((args: any) => {
        const target = args?.data?.level;
        if (target != null && agg.level >= target) return Promise.resolve({ count: 0 });
        if (target != null) agg.level = target;
        return Promise.resolve({ count: 1 });
      }),
      update: jest.fn().mockResolvedValue({}),
      upsert: jest.fn().mockResolvedValue({ ...agg }),
    },
    studentProfile: { findUnique: jest.fn().mockResolvedValue({ userId: 'u1' }) },
    rewardRedemption: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
    lesson: { findUnique: jest.fn() },
    lessonProgress: { count: jest.fn() },
  };

  const config: any = {
    rule: jest.fn((e: string) => Promise.resolve(RULES[e]?.isActive ? RULES[e] : null)),
    levelFor: jest.fn((xp: number) => {
      let t = TIERS[0];
      for (const x of TIERS) if (xp >= x.minXp) t = x;
      return Promise.resolve(t);
    }),
  };
  const achievements: any = { evaluate: jest.fn().mockResolvedValue([]) };
  const missions: any = { advance: jest.fn().mockResolvedValue([]) };
  const leaderboard: any = { bump: jest.fn().mockResolvedValue(undefined) };
  const notifications: any = { create: jest.fn().mockResolvedValue({}) };

  const svc = new GamificationService(prisma, config, achievements, missions, leaderboard, notifications);
  return { svc, prisma, tx, created, agg, achievements, missions, leaderboard, notifications, config };
}

const lessonEvent = (over: any = {}) => ({
  studentId: 's1',
  type: 'LESSON_COMPLETED' as const,
  key: 'LESSON_COMPLETED:s1:l1',
  tenantId: 't1',
  courseId: 'c1',
  entityType: 'lesson',
  entityId: 'l1',
  ...over,
});

describe('GamificationService', () => {
  it('pays the configured XP and coins for a real learning event', async () => {
    const { svc, created, leaderboard } = makeCtx();
    const out = await svc.recordOrThrow(lessonEvent());

    expect(out.awarded).toBe(true);
    expect(out.xp).toBe(25);
    expect(out.coins).toBe(10);
    expect(created[0]).toMatchObject({ type: 'LESSON_COMPLETED', xpAwarded: 25, tenantId: 't1', courseId: 'c1' });
    // The board is updated in the same transaction as the award.
    expect(leaderboard.bump).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ xp: 25, tenantId: 't1' }));
  });

  it('pays nothing when the same action is reported twice', async () => {
    const { svc, tx } = makeCtx();
    tx.gamificationEvent.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dupe', { code: 'P2002', clientVersion: '5' }),
    );
    const out = await svc.recordOrThrow(lessonEvent());
    expect(out.awarded).toBe(false);
    expect(out.xp).toBe(0);
  });

  it('refuses a second award for the same entity even under a different key', async () => {
    // The heartbeat is idempotent by key, but a caller that invents a new key
    // for the same lesson must still not be able to pay twice.
    const { svc, tx } = makeCtx({ priorSameEntity: 1 });
    const out = await svc.recordOrThrow(lessonEvent({ key: 'LESSON_COMPLETED:s1:l1:retry' }));
    expect(out.awarded).toBe(false);
    expect(tx.gamificationEvent.create).not.toHaveBeenCalled();
  });

  it('trims XP to what is left of the daily cap, and keeps the event', async () => {
    // 50 of the 60-XP daily quiz cap already spent: the attempt is worth 10.
    const { svc, created } = makeCtx({ xpSpentToday: 50 });
    const out = await svc.recordOrThrow({
      studentId: 's1',
      type: 'QUIZ_COMPLETED',
      key: 'QUIZ_COMPLETED:s1:a9',
      entityType: 'quiz',
      entityId: 'a9',
    });
    expect(out.xp).toBe(10);
    expect(created[0].xpAwarded).toBe(10);
  });

  it('stops paying entirely once the cap is spent, but still records the work', async () => {
    const { svc, created, missions } = makeCtx({ xpSpentToday: 60 });
    const out = await svc.recordOrThrow({
      studentId: 's1',
      type: 'QUIZ_COMPLETED',
      key: 'QUIZ_COMPLETED:s1:a10',
      entityType: 'quiz',
      entityId: 'a10',
    });
    expect(out.xp).toBe(0);
    expect(created[0].xpAwarded).toBe(0);
    // The student did the quiz — it still counts toward today's mission.
    expect(missions.advance).toHaveBeenCalled();
  });

  it('ignores an event whose rule has been switched off', async () => {
    const { svc, tx } = makeCtx();
    const out = await svc.recordOrThrow({ studentId: 's1', type: 'RETIRED' as any, key: 'x' });
    expect(out.awarded).toBe(false);
    expect(tx.gamificationEvent.create).not.toHaveBeenCalled();
  });

  it('promotes the student when the new total crosses a tier, once', async () => {
    const { svc, prisma, notifications } = makeCtx({ agg: { studentId: 's1', xp: 90, level: 1, coins: 0 } });
    const out = await svc.recordOrThrow(lessonEvent()); // 90 + 25 = 115 → level 2

    expect(out.leveledUp).toBe(true);
    expect(out.level).toBe(2);
    expect(out.levelNameEn).toBe('Explorer');
    // Guarded on the old level, so two concurrent awards cannot both promote.
    expect(prisma.studentGamification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { studentId: 's1', level: { lt: 2 } } }),
    );
    expect(notifications.create).toHaveBeenCalled();
  });

  it('does not promote when the tier is unchanged', async () => {
    const { svc } = makeCtx({ agg: { studentId: 's1', xp: 10, level: 1, coins: 0 } });
    const out = await svc.recordOrThrow(lessonEvent());
    expect(out.leveledUp).toBe(false);
  });

  it('pays a mission the moment the event completes it', async () => {
    const { svc, missions, created } = makeCtx();
    missions.advance.mockResolvedValueOnce([
      { id: 'm1', template: 'DAILY_ONE_LESSON', kind: 'DAILY', xpReward: 50, coinReward: 25 },
    ]);
    const out = await svc.recordOrThrow(lessonEvent());

    expect(out.missions).toHaveLength(1);
    const missionAward = created.find((c) => c.type === 'MISSION_COMPLETED');
    expect(missionAward).toMatchObject({ xpAwarded: 50, coinsAwarded: 25, idempotencyKey: 'MISSION:m1' });
  });

  it('multiplies a lesson award while an XP boost is running, and spends a charge', async () => {
    const { svc, prisma } = makeCtx();
    prisma.rewardRedemption.findFirst.mockResolvedValue({
      id: 'r1',
      meta: { remaining: 2, multiplier: 2 },
    });
    const out = await svc.recordOrThrow(lessonEvent());

    expect(out.xp).toBe(50); // 25 × 2
    expect(prisma.rewardRedemption.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ meta: { remaining: 1, multiplier: 2 } }) }),
    );
  });

  it('never lets a failure reach the learning flow that called it', async () => {
    const { svc, prisma } = makeCtx();
    prisma.$transaction.mockRejectedValueOnce(new Error('database is on fire'));
    await expect(svc.record(lessonEvent())).resolves.toMatchObject({ awarded: false });
  });

  it('only rewards streak lengths that are actual milestones', async () => {
    const { svc, created } = makeCtx();
    const nothing = await svc.checkStreakMilestone('s1', 6);
    expect(nothing.awarded).toBe(false);
    expect(created).toHaveLength(0);
  });
});
