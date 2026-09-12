import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AchievementsService } from './achievements.service';
import { GamificationConfigService } from './gamification.config.service';
import { GamificationService } from './gamification.service';
import { LeaderboardService } from './leaderboard.service';
import { MissionsService } from './missions.service';
import { GamificationAnalyticsService } from './gamification-analytics.service';
import { StudentGamificationService } from './student-gamification.service';

/**
 * The claims that cannot be proven with mocks.
 *
 * Idempotency, concurrent double-awards and atomic coin spending are all
 * properties of the *database* — a unique index, a conditional update, a
 * transaction boundary — and a mocked Prisma will happily agree with whatever
 * the code believes. These run against a real Postgres and skip themselves
 * when there isn't one, so the suite stays green on a machine without a
 * database while still being the thing that actually checks the guarantees.
 */

const prisma = new PrismaService();
let available = true;

// `describe.skip` needs to be decided synchronously, so connectivity is probed
// in beforeAll and every test bails early if the probe failed.
const guard = () => {
  if (!available) {
    // eslint-disable-next-line no-console
    console.warn('skipping: no database reachable at DATABASE_URL');
  }
  return available;
};

let engine: GamificationService;
let students: StudentGamificationService;
let leaderboard: LeaderboardService;
let config: GamificationConfigService;
let analytics: GamificationAnalyticsService;

const ids: { users: string[]; students: string[] } = { users: [], students: [] };

async function makeStudent(): Promise<string> {
  const user = await prisma.user.create({
    data: { role: 'STUDENT', fullName: `QA ${randomUUID().slice(0, 8)}`, email: `qa-${randomUUID()}@example.test` },
  });
  const student = await prisma.studentProfile.create({ data: { userId: user.id } });
  ids.users.push(user.id);
  ids.students.push(student.id);
  return student.id;
}

beforeAll(async () => {
  try {
    await prisma.$connect();
    await prisma.xpRule.count();
  } catch {
    available = false;
    return;
  }
  await prisma.onModuleInit();
  config = new GamificationConfigService(prisma);
  leaderboard = new LeaderboardService(prisma);
  const achievements = new AchievementsService(prisma);
  const missions = new MissionsService(prisma);
  const notifications: any = { create: jest.fn().mockResolvedValue({}), pushUnread: jest.fn() };
  engine = new GamificationService(prisma, config, achievements, missions, leaderboard, notifications);
  const progress: any = {
    summary: jest.fn().mockResolvedValue({
      currentStreak: 0, longestStreak: 0, weeklyGoalLessons: 5,
      lessonsCompletedThisWeek: 0, weeklyGoalPct: 0, totalLessonsCompleted: 0, activeCourses: 0,
    }),
  };
  students = new StudentGamificationService(prisma, engine, config, achievements, missions, leaderboard, progress);
  analytics = new GamificationAnalyticsService(prisma);
}, 30_000);

afterAll(async () => {
  if (available && ids.users.length) {
    // A real delete, on purpose. `User` is a soft-delete model now, so
    // `deleteMany` would only stamp `deletedAt` and leave every QA row in the
    // database for ever. Raw SQL bypasses the middleware; the FK cascade takes
    // StudentProfile and everything hanging off it.
    await prisma
      .$executeRawUnsafe(`DELETE FROM "User" WHERE id = ANY($1::text[])`, ids.users)
      .catch(() => undefined);
  }
  await prisma.$disconnect().catch(() => undefined);
});

describe('gamification against a real database', () => {
  it('seeds an economy the engine can actually run on', async () => {
    if (!guard()) return;
    const [rules, tiers, achievements] = await Promise.all([
      prisma.xpRule.count(),
      prisma.levelTier.count(),
      prisma.achievement.count(),
    ]);
    expect(rules).toBeGreaterThan(0);
    expect(tiers).toBeGreaterThan(0);
    expect(achievements).toBeGreaterThan(0);
  });

  it('keeps the badges students already earned', async () => {
    if (!guard()) return;
    // The six keys the old computed-badge screen used. Losing one would mean a
    // student opening the app to find an achievement gone.
    const legacy = ['first_enroll', 'streak_7', 'dedicated', 'quiz_ace', 'first_certificate', 'scholar'];
    const found = await prisma.achievement.findMany({ where: { key: { in: legacy } }, select: { key: true } });
    expect(found.map((f) => f.key).sort()).toEqual([...legacy].sort());
  });

  it('pays a lesson once, however many times it is reported', async () => {
    if (!guard()) return;
    const studentId = await makeStudent();
    const event = {
      studentId,
      type: 'LESSON_COMPLETED' as const,
      key: `LESSON_COMPLETED:${studentId}:lesson-x`,
      tenantId: 'tenant-a',
      courseId: 'course-a',
      entityType: 'lesson',
      entityId: 'lesson-x',
    };

    const first = await engine.recordOrThrow(event);
    const second = await engine.recordOrThrow(event);
    const third = await engine.recordOrThrow(event);

    expect(first.awarded).toBe(true);
    expect(second.awarded).toBe(false);
    expect(third.awarded).toBe(false);

    // `xp` is what this event paid; the balance also carries the achievement
    // that finishing a first lesson unlocks, which is its own ledger entry.
    const lessonRule = await prisma.xpRule.findUnique({ where: { event: 'LESSON_COMPLETED' } });
    expect(first.xp).toBe(lessonRule!.xp);
    expect(first.achievements.map((a) => a.key)).toContain('first_lesson');

    const agg = await prisma.studentGamification.findUnique({ where: { studentId } });
    expect(agg!.lessonsCompleted).toBe(1);
    expect(agg!.xp).toBe(first.totalXp);

    // Exactly one lesson award on the ledger, whatever the caller did.
    const lessonEvents = await prisma.gamificationEvent.count({
      where: { studentId, type: 'LESSON_COMPLETED' },
    });
    expect(lessonEvents).toBe(1);
  });

  it('pays once even when the same completion arrives twice at the same moment', async () => {
    if (!guard()) return;
    const studentId = await makeStudent();
    const event = {
      studentId,
      type: 'LESSON_COMPLETED' as const,
      key: `LESSON_COMPLETED:${studentId}:lesson-race`,
      tenantId: 'tenant-a',
      entityType: 'lesson',
      entityId: 'lesson-race',
    };

    // Two heartbeats landing together — the unique index is the arbiter.
    const results = await Promise.all([engine.record(event), engine.record(event), engine.record(event)]);
    expect(results.filter((r) => r.awarded)).toHaveLength(1);

    const events = await prisma.gamificationEvent.count({
      where: { studentId, type: 'LESSON_COMPLETED' },
    });
    expect(events).toBe(1);
  });

  it('stops paying for the same quiz once the daily cap is spent', async () => {
    if (!guard()) return;
    const studentId = await makeStudent();
    const rule = await prisma.xpRule.findUnique({ where: { event: 'QUIZ_COMPLETED' } });
    const cap = rule!.dailyCap;

    let paid = 0;
    // Far more attempts than the cap can cover.
    for (let i = 0; i < 12; i++) {
      const out = await engine.recordOrThrow({
        studentId,
        type: 'QUIZ_COMPLETED',
        key: `QUIZ_COMPLETED:${studentId}:attempt-${i}`,
        entityType: 'quiz',
        entityId: `attempt-${i}`,
      });
      paid += out.xp;
    }
    expect(paid).toBe(cap);

    const agg = await prisma.studentGamification.findUnique({ where: { studentId } });
    expect(agg!.xp).toBe(cap);
  });

  it('promotes through levels as the ledger grows, and never twice for one tier', async () => {
    if (!guard()) return;
    const studentId = await makeStudent();
    const tier2 = await prisma.levelTier.findUnique({ where: { level: 2 } });

    let levelUps = 0;
    for (let i = 0; i < 12; i++) {
      const out = await engine.recordOrThrow({
        studentId,
        type: 'LESSON_COMPLETED',
        key: `LESSON_COMPLETED:${studentId}:l-${i}`,
        entityType: 'lesson',
        entityId: `l-${i}`,
      });
      if (out.leveledUp) levelUps++;
    }

    const agg = await prisma.studentGamification.findUnique({ where: { studentId } });
    expect(agg!.xp).toBeGreaterThanOrEqual(tier2!.minXp);
    expect(agg!.level).toBeGreaterThanOrEqual(2);
    // One promotion per tier crossed, not one per event after crossing it.
    const levelEvents = await prisma.gamificationEvent.count({ where: { studentId, type: 'LEVEL_UP' } });
    expect(levelEvents).toBeLessThanOrEqual(levelUps);
  });

  it('unlocks an achievement exactly once when its threshold is crossed', async () => {
    if (!guard()) return;
    const studentId = await makeStudent();

    for (let i = 0; i < 11; i++) {
      await engine.recordOrThrow({
        studentId,
        type: 'LESSON_COMPLETED',
        key: `LESSON_COMPLETED:${studentId}:ach-${i}`,
        entityType: 'lesson',
        entityId: `ach-${i}`,
      });
    }

    const held = await prisma.studentAchievement.findMany({
      where: { studentId },
      include: { achievement: { select: { key: true } } },
    });
    const keys = held.map((h) => h.achievement.key);
    expect(keys).toContain('first_lesson'); // 1 lesson
    expect(keys).toContain('dedicated'); // 10 lessons
    // No duplicates — the (student, achievement) unique holds.
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('ranks a board and reports the caller’s own position', async () => {
    if (!guard()) return;
    const tenantId = `tenant-${randomUUID().slice(0, 8)}`;
    const a = await makeStudent();
    const b = await makeStudent();

    // a earns more than b.
    for (let i = 0; i < 3; i++) {
      await engine.recordOrThrow({
        studentId: a, type: 'LESSON_COMPLETED', key: `LESSON_COMPLETED:${a}:b-${i}`,
        tenantId, entityType: 'lesson', entityId: `b-${i}`,
      });
    }
    await engine.recordOrThrow({
      studentId: b, type: 'LESSON_COMPLETED', key: `LESSON_COMPLETED:${b}:b-0`,
      tenantId, entityType: 'lesson', entityId: `b-0`,
    });

    const board = await leaderboard.board({ scope: 'ACADEMY', scopeId: tenantId, period: 'WEEKLY', studentId: b });
    expect(board.top[0].studentId).toBe(a);
    expect(board.me!.studentId).toBe(b);
    expect(board.me!.rank).toBe(2);
    // The gap to the next rank up, which is the only actionable number here.
    expect(board.toNextRank).toBeGreaterThan(0);
  });

  it('keeps one academy’s board out of another’s', async () => {
    if (!guard()) return;
    const tenantA = `tenant-${randomUUID().slice(0, 8)}`;
    const tenantB = `tenant-${randomUUID().slice(0, 8)}`;
    const a = await makeStudent();
    const b = await makeStudent();

    await engine.recordOrThrow({
      studentId: a, type: 'LESSON_COMPLETED', key: `LESSON_COMPLETED:${a}:iso`,
      tenantId: tenantA, entityType: 'lesson', entityId: 'iso',
    });
    await engine.recordOrThrow({
      studentId: b, type: 'LESSON_COMPLETED', key: `LESSON_COMPLETED:${b}:iso`,
      tenantId: tenantB, entityType: 'lesson', entityId: 'iso',
    });

    const boardA = await leaderboard.board({ scope: 'ACADEMY', scopeId: tenantA, period: 'WEEKLY' });
    const idsOnA = boardA.top.map((r) => r.studentId);
    expect(idsOnA).toContain(a);
    expect(idsOnA).not.toContain(b);
  });

  it('reports engagement for one academy without counting another’s', async () => {
    if (!guard()) return;
    const mine = `tenant-${randomUUID().slice(0, 8)}`;
    const theirs = `tenant-${randomUUID().slice(0, 8)}`;
    const a = await makeStudent();
    const b = await makeStudent();

    await engine.recordOrThrow({
      studentId: a, type: 'LESSON_COMPLETED', key: `LESSON_COMPLETED:${a}:an-1`,
      tenantId: mine, entityType: 'lesson', entityId: 'an-1',
    });
    for (const n of [1, 2]) {
      await engine.recordOrThrow({
        studentId: b, type: 'LESSON_COMPLETED', key: `LESSON_COMPLETED:${b}:an-${n}`,
        tenantId: theirs, entityType: 'lesson', entityId: `an-${n}`,
      });
    }

    const view = await analytics.overview(mine);
    expect(view.activeLearners.month).toBe(1); // not 2
    expect(view.last30Days.lessonsCompleted).toBe(1); // not 3
    // And the shape a brand-new academy gets is three honest "no cohort" rows,
    // never an empty list the interface would render as a bare heading.
    const fresh = await analytics.overview(`tenant-${randomUUID().slice(0, 8)}`);
    expect(fresh.retention.map((r) => r.day)).toEqual([1, 7, 30]);
    expect(fresh.retention.every((r) => r.eligible === 0)).toBe(true);
  });

  it('spends coins atomically — two taps cannot buy one balance twice', async () => {
    if (!guard()) return;
    const studentId = await makeStudent();
    const user = await prisma.studentProfile.findUnique({ where: { id: studentId }, select: { userId: true } });
    const reward = await prisma.reward.findUnique({ where: { key: 'streak_freeze' } });

    // Fund exactly one purchase.
    await prisma.studentGamification.upsert({
      where: { studentId },
      create: { studentId, coins: reward!.costCoins },
      update: { coins: reward!.costCoins },
    });

    const results = await Promise.allSettled([
      students.redeem(user!.userId, 'streak_freeze'),
      students.redeem(user!.userId, 'streak_freeze'),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);

    const agg = await prisma.studentGamification.findUnique({ where: { studentId } });
    expect(agg!.coins).toBe(0);
    expect(agg!.streakFreezes).toBe(1);
    // The debit is on the ledger too, as a negative amount.
    const spend = await prisma.gamificationEvent.findFirst({ where: { studentId, type: 'REWARD_REDEEMED' } });
    expect(spend!.coinsAwarded).toBe(-reward!.costCoins);
  });

  it('never lets coins touch the real-money wallet', async () => {
    if (!guard()) return;
    const studentId = await makeStudent();
    await engine.recordOrThrow({
      studentId, type: 'LESSON_COMPLETED', key: `LESSON_COMPLETED:${studentId}:money`,
      entityType: 'lesson', entityId: 'money',
    });
    // Coins were earned…
    const agg = await prisma.studentGamification.findUnique({ where: { studentId } });
    expect(agg!.coins).toBeGreaterThan(0);
    // …and the wallet that holds actual piasters never moved.
    const wallet = await prisma.walletTransaction.count({ where: { studentId } });
    expect(wallet).toBe(0);
  });
});
