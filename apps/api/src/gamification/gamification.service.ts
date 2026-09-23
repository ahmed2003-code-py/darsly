import { Injectable, Logger } from '@nestjs/common';
import { Prisma, StudentGamification } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AchievementsService } from './achievements.service';
import { GamificationConfigService } from './gamification.config.service';
import { LeaderboardService } from './leaderboard.service';
import { MissionsService } from './missions.service';
import { cairoHour, dayKey, isCairoWeekend, startOfCairoDay } from './period.util';
import {
  EMPTY_OUTCOME,
  EVENT_COUNTER,
  GamificationEventType,
  GamificationOutcome,
  RecordEventInput,
  STREAK_MILESTONES,
  UnlockedAchievement,
} from './gamification.types';

/**
 * The engine.
 *
 * One method — `record` — is the only way XP or coins ever come into existence,
 * and every learning flow in the product calls it with a description of what
 * the student actually did. That single door is what makes the rest tractable:
 * idempotency, daily caps, level-ups, missions, achievements and leaderboards
 * are all enforced in one place instead of at a dozen call sites that each have
 * to remember.
 *
 * Two guarantees the callers depend on:
 *
 *  - **It never throws.** A lesson must finish, a quiz must grade and a
 *    certificate must issue whether or not the points system is having a good
 *    day. Failures are logged and swallowed; learning is the product, XP is the
 *    decoration.
 *  - **It never double-pays.** The award is written behind a unique key derived
 *    from the action itself, so retries, duplicated heartbeats and
 *    double-submits collapse to one.
 */
/** At most this many gamification alerts a day, however good the day was. */
const DAILY_NOTIFICATION_CAP = 2;

@Injectable()
export class GamificationService {
  private readonly logger = new Logger(GamificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: GamificationConfigService,
    private readonly achievements: AchievementsService,
    private readonly missions: MissionsService,
    private readonly leaderboard: LeaderboardService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Safe entry point. Returns what happened; returns nothing on any failure. */
  async record(input: RecordEventInput): Promise<GamificationOutcome> {
    try {
      return await this.recordOrThrow(input);
    } catch (e) {
      this.logger.error(
        `gamification event ${input.type} failed for ${input.studentId}: ${(e as Error).message}`,
      );
      return EMPTY_OUTCOME;
    }
  }

  /** The real implementation. Throws — used directly by tests. */
  async recordOrThrow(input: RecordEventInput): Promise<GamificationOutcome> {
    const rule = await this.config.rule(input.type);
    if (!rule) return EMPTY_OUTCOME;

    let xp = input.xpOverride ?? rule.xp;
    let coins = input.coinsOverride ?? rule.coins;

    // ── Anti-farming, before anything is written ────────────────────────────
    //
    // The unique key already stops the same action paying twice. These two
    // guards stop *different* actions of the same shape being farmed: a lesson
    // re-completed under a fresh key, or twenty quiz attempts in an afternoon.
    if (rule.perEntityLimit > 0 && input.entityId) {
      const already = await this.prisma.gamificationEvent.count({
        where: { studentId: input.studentId, type: input.type, entityId: input.entityId },
      });
      if (already >= rule.perEntityLimit) return EMPTY_OUTCOME;
    }
    if (rule.dailyCap > 0 && xp > 0) {
      const since = startOfCairoDay();
      const spent = await this.prisma.gamificationEvent.aggregate({
        where: { studentId: input.studentId, type: input.type, createdAt: { gte: since } },
        _sum: { xpAwarded: true },
      });
      const remaining = rule.dailyCap - (spent._sum.xpAwarded ?? 0);
      // Past the cap the work still counts toward missions and progress — it
      // just stops paying. The student did the lesson; they only stop farming.
      xp = Math.max(0, Math.min(xp, remaining));
    }

    const boost = xp > 0 ? await this.consumeBoost(input.studentId, input.type) : null;
    if (boost) xp = Math.round(xp * boost.multiplier);

    // ── The award itself ────────────────────────────────────────────────────
    let agg: StudentGamification;
    try {
      agg = await this.prisma.$transaction(async (tx) => {
        await tx.gamificationEvent.create({
          data: {
            studentId: input.studentId,
            tenantId: input.tenantId ?? null,
            courseId: input.courseId ?? null,
            type: input.type,
            entityType: input.entityType ?? null,
            entityId: input.entityId ?? null,
            xpAwarded: xp,
            coinsAwarded: coins,
            idempotencyKey: input.key,
            meta: (input.meta ?? {}) as Prisma.InputJsonValue,
          },
        });

        const counter = EVENT_COUNTER[input.type];
        const create: Record<string, unknown> = {
          studentId: input.studentId,
          xp,
          coins: Math.max(0, coins),
          coinsEarned: Math.max(0, coins),
          ...(counter ? { [counter]: 1 } : {}),
        };
        const update: Record<string, unknown> = {
          xp: { increment: xp },
          coins: { increment: coins },
          ...(coins > 0 ? { coinsEarned: { increment: coins } } : {}),
          ...(coins < 0 ? { coinsSpent: { increment: -coins } } : {}),
          ...(counter ? { [counter]: { increment: 1 } } : {}),
        };
        const row = await tx.studentGamification.upsert({
          where: { studentId: input.studentId },
          create: create as Prisma.StudentGamificationUncheckedCreateInput,
          update: update as Prisma.StudentGamificationUncheckedUpdateInput,
        });

        await this.leaderboard.bump(tx, {
          studentId: input.studentId,
          tenantId: input.tenantId,
          courseId: input.courseId,
          xp,
        });
        return row;
      });
    } catch (e) {
      // The unique key did its job: this exact action has already been paid.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
        return EMPTY_OUTCOME;
      throw e;
    }

    // ── Everything the award set off ────────────────────────────────────────
    const outcome: GamificationOutcome = {
      awarded: true,
      xp,
      coins,
      totalXp: agg.xp,
      level: agg.level,
      leveledUp: false,
      achievements: [],
      missions: [],
    };

    // A level-up payout is worth zero XP, so it can never cross another tier —
    // and letting it check would be a cycle with no natural end.
    const levelled = input.type === 'LEVEL_UP' ? null : await this.applyLevel(agg);
    if (levelled) {
      outcome.leveledUp = true;
      outcome.level = levelled.level;
      outcome.levelNameAr = levelled.nameAr;
      outcome.levelNameEn = levelled.nameEn;
      agg = levelled.agg;
    }

    outcome.missions = await this.missions.advance(input.studentId, input.type);
    for (const m of outcome.missions) {
      const paid = await this.record({
        studentId: input.studentId,
        type: m.kind === 'WEEKLY' ? 'WEEKLY_QUEST_COMPLETED' : 'MISSION_COMPLETED',
        key: `MISSION:${m.id}`,
        tenantId: input.tenantId,
        entityType: 'mission',
        entityId: m.id,
        xpOverride: m.xpReward,
        coinsOverride: m.coinReward,
        meta: { template: m.template },
      });
      if (paid.awarded) {
        outcome.totalXp = paid.totalXp;
        if (paid.leveledUp) {
          outcome.leveledUp = true;
          outcome.level = paid.level;
          outcome.levelNameAr = paid.levelNameAr;
          outcome.levelNameEn = paid.levelNameEn;
        }
      }
    }

    // An achievement's own payout must not go looking for more achievements:
    // that is how a cascade becomes a recursion. Anything it would have
    // unlocked is picked up by the next real learning event.
    if (input.type !== 'ACHIEVEMENT_UNLOCKED' && input.type !== 'LEVEL_UP') {
      outcome.achievements = await this.grantAchievements(input.studentId, agg, input.tenantId);
      if (outcome.achievements.length) {
        const refreshed = await this.prisma.studentGamification.findUnique({
          where: { studentId: input.studentId },
        });
        if (refreshed) outcome.totalXp = refreshed.xp;
      }
    }

    return outcome;
  }

  /**
   * Unlock achievements and pay for them. The payment is itself a recorded
   * event, so an achievement's XP is as auditable as a lesson's.
   */
  private async grantAchievements(
    studentId: string,
    agg: StudentGamification,
    tenantId?: string | null,
  ): Promise<UnlockedAchievement[]> {
    const unlocked = await this.achievements.evaluate(studentId, agg);
    for (const a of unlocked) {
      if (a.xpReward || a.coinReward) {
        await this.record({
          studentId,
          type: 'ACHIEVEMENT_UNLOCKED',
          key: `ACHIEVEMENT:${studentId}:${a.key}`,
          tenantId,
          entityType: 'achievement',
          entityId: a.key,
          xpOverride: a.xpReward,
          coinsOverride: a.coinReward,
        });
      }
    }
    // Deliberately no notification per achievement. The interface already
    // celebrates these the moment they happen, and a student who finishes six
    // lessons in a sitting would otherwise collect six alerts for something
    // they just watched appear on screen. Notifications are for what happens
    // while nobody is looking.
    return unlocked;
  }

  /** Promote the student if their new total crosses a tier. */
  private async applyLevel(
    agg: StudentGamification,
  ): Promise<{ agg: StudentGamification; level: number; nameAr: string; nameEn: string } | null> {
    const tier = await this.config.levelFor(agg.xp);
    if (tier.level <= agg.level) return null;

    // Guarded on the old level so two concurrent awards can't both promote.
    const res = await this.prisma.studentGamification.updateMany({
      where: { studentId: agg.studentId, level: { lt: tier.level } },
      data: { level: tier.level, lastLevelUpAt: new Date() },
    });
    if (!res.count) return null;

    if (tier.coinReward > 0) {
      await this.record({
        studentId: agg.studentId,
        type: 'LEVEL_UP',
        key: `LEVEL_UP:${agg.studentId}:${tier.level}`,
        entityType: 'level',
        entityId: String(tier.level),
        xpOverride: 0,
        coinsOverride: tier.coinReward,
        meta: { level: tier.level },
      });
    }

    await this.notify(agg.studentId, {
      title: `🎉 وصلت للمستوى ${tier.level} — ${tier.nameAr}`,
      body:
        tier.coinReward > 0 ? `كسبت ${tier.coinReward} عملة مع الترقية.` : 'استمر، أنت في طريقك.',
      meta: { kind: 'level_up', level: tier.level, icon: tier.icon, coins: tier.coinReward },
    });

    const updated = await this.prisma.studentGamification.findUnique({
      where: { studentId: agg.studentId },
    });
    return updated
      ? { agg: updated, level: tier.level, nameAr: tier.nameAr, nameEn: tier.nameEn }
      : null;
  }

  /**
   * A streak milestone, awarded from the streak the platform already keeps on
   * StudentProfile. This engine never counts days itself — there is one streak
   * in this product and it does not live here.
   */
  async checkStreakMilestone(studentId: string, streak: number): Promise<GamificationOutcome> {
    if (!STREAK_MILESTONES.includes(streak)) return EMPTY_OUTCOME;
    const outcome = await this.record({
      studentId,
      type: 'STREAK_MILESTONE',
      key: `STREAK:${studentId}:${streak}`,
      entityType: 'streak',
      entityId: String(streak),
      // Longer streaks are worth more, but sub-linearly — a 365-day streak
      // should not be worth fifty lessons.
      xpOverride: Math.round(50 + streak * 2),
      coinsOverride: Math.round(25 + streak),
      meta: { streak },
    });
    if (outcome.awarded) {
      await this.notify(studentId, {
        title: `🔥 ${streak} يوم متتالي!`,
        body: `مواظبتك وصّلتك لـ ${streak} يوم — كسبت ${outcome.xp} نقطة.`,
        meta: { kind: 'streak', streak },
      });
    }
    return outcome;
  }

  /** Time-of-day and weekend counters, for the "when do you study" achievements. */
  async noteStudySession(studentId: string): Promise<void> {
    const hour = cairoHour();
    const data: Prisma.StudentGamificationUpdateInput = {};
    if (hour < 8) data.earlyBirdSessions = { increment: 1 };
    if (hour >= 0 && hour < 5) data.nightOwlSessions = { increment: 1 };
    if (isCairoWeekend()) data.weekendSessions = { increment: 1 };
    if (!Object.keys(data).length) return;
    // Only once per day per student — one long Saturday is one weekend session.
    const marker = `STUDY_WINDOW:${studentId}:${dayKey()}`;
    try {
      await this.prisma.gamificationEvent.create({
        data: {
          studentId,
          type: 'STUDY_WINDOW',
          idempotencyKey: marker,
          xpAwarded: 0,
          coinsAwarded: 0,
        },
      });
    } catch {
      return; // already noted today
    }
    await this.prisma.studentGamification
      .upsert({ where: { studentId }, create: { studentId }, update: data })
      .catch(() => undefined);
  }

  /** Consume one charge of an active XP boost, if the event qualifies. */
  private async consumeBoost(
    studentId: string,
    type: GamificationEventType,
  ): Promise<{ multiplier: number } | null> {
    if (type !== 'LESSON_COMPLETED') return null;
    const active = await this.prisma.rewardRedemption.findFirst({
      where: { studentId, status: 'ACTIVE', reward: { kind: 'XP_BOOST' } },
      orderBy: { createdAt: 'asc' },
    });
    if (!active) return null;
    const meta = (active.meta ?? {}) as { remaining?: number; multiplier?: number };
    const remaining = Number(meta.remaining ?? 0);
    const multiplier = Number(meta.multiplier ?? 1);
    if (remaining <= 0 || multiplier <= 1) {
      await this.prisma.rewardRedemption.update({
        where: { id: active.id },
        data: { status: 'FULFILLED' },
      });
      return null;
    }
    await this.prisma.rewardRedemption.update({
      where: { id: active.id },
      data: {
        meta: { ...meta, remaining: remaining - 1 } as Prisma.InputJsonValue,
        ...(remaining - 1 <= 0 ? { status: 'FULFILLED' } : {}),
      },
    });
    return { multiplier };
  }

  /**
   * Award the unit if this lesson was the last one left in it.
   *
   * Called from every place a lesson can be completed. Cheap — two counts —
   * and keyed on the unit, so the twentieth heartbeat after finishing it pays
   * nothing.
   */
  async checkUnitCompletion(studentId: string, lessonId: string): Promise<GamificationOutcome> {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      select: {
        unitId: true,
        unit: { select: { courseId: true, course: { select: { tenantId: true } } } },
      },
    });
    if (!lesson) return EMPTY_OUTCOME;

    const live = { deletedAt: null, unitId: lesson.unitId };
    const [total, done] = await Promise.all([
      this.prisma.lesson.count({ where: live }),
      this.prisma.lessonProgress.count({
        where: { studentId, completedAt: { not: null }, lesson: live },
      }),
    ]);
    if (total === 0 || done < total) return EMPTY_OUTCOME;

    return this.record({
      studentId,
      type: 'UNIT_COMPLETED',
      key: `UNIT_COMPLETED:${studentId}:${lesson.unitId}`,
      tenantId: lesson.unit.course.tenantId,
      courseId: lesson.unit.courseId,
      entityType: 'unit',
      entityId: lesson.unitId,
    });
  }

  /** Create the aggregate row on demand — a student who never earned has none. */
  async profile(studentId: string): Promise<StudentGamification> {
    return this.prisma.studentGamification.upsert({
      where: { studentId },
      create: { studentId },
      update: {},
    });
  }

  /**
   * Send a gamification notification, or don't.
   *
   * Two rules keep this from becoming noise. Only genuinely rare events reach
   * it at all — a level-up happens about ten times in a student's life, a
   * streak milestone seven — and even those are capped per day, so a student
   * who crosses three tiers in one sitting is congratulated once, not three
   * times. The cap is counted from the notifications themselves, so it holds
   * across restarts and across instances.
   */
  private async notify(
    studentId: string,
    input: { title: string; body: string; meta: Record<string, unknown> },
  ): Promise<void> {
    const userId = await this.userIdOf(studentId);
    if (!userId) return;
    try {
      const todayCount = await this.prisma.notification.count({
        where: {
          userId,
          createdAt: { gte: startOfCairoDay() },
          meta: { path: ['gamified'], equals: true },
        },
      });
      if (todayCount >= DAILY_NOTIFICATION_CAP) return;
      await this.notifications.create({
        userId,
        type: 'ANNOUNCEMENT',
        title: input.title,
        body: input.body,
        meta: { ...input.meta, gamified: true },
      });
    } catch {
      // A missed congratulation is never worth failing a lesson over.
    }
  }

  private async userIdOf(studentId: string): Promise<string> {
    const s = await this.prisma.studentProfile.findUnique({
      where: { id: studentId },
      select: { userId: true },
    });
    return s?.userId ?? '';
  }
}
