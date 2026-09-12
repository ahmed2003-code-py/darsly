import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProgressService } from '../progress/progress.service';
import { AchievementsService } from './achievements.service';
import { GamificationConfigService } from './gamification.config.service';
import { GamificationService } from './gamification.service';
import { LeaderboardService } from './leaderboard.service';
import { MissionsService } from './missions.service';
import { dayKey } from './period.util';

/**
 * Everything the student-facing screens read, assembled in one place.
 *
 * The dashboard, the profile and the hub all want overlapping slices of the
 * same picture — level, streak, missions, rank — and asking each screen to
 * stitch six endpoints together is how they end up disagreeing with each other.
 * One snapshot, one shape, one round trip.
 */
@Injectable()
export class StudentGamificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: GamificationService,
    private readonly config: GamificationConfigService,
    private readonly achievements: AchievementsService,
    private readonly missions: MissionsService,
    private readonly leaderboard: LeaderboardService,
    private readonly progress: ProgressService,
  ) {}

  async studentIdOf(userId: string): Promise<string> {
    const s = await this.prisma.studentProfile.findUnique({ where: { userId }, select: { id: true } });
    if (!s) throw new BadRequestException('No student profile for this account');
    return s.id;
  }

  /** The whole learning profile in one read. */
  async snapshot(userId: string) {
    const studentId = await this.studentIdOf(userId);
    const [agg, profile, summary] = await Promise.all([
      this.engine.profile(studentId),
      this.prisma.studentProfile.findUnique({
        where: { id: studentId },
        select: { currentStreak: true, longestStreak: true, lastActivityDate: true },
      }),
      this.progress.summary(userId),
    ]);

    const [level, standing, missions, achievements, titles, accuracy, certificates] = await Promise.all([
      this.config.levelProgress(agg.xp),
      this.leaderboard.standing(studentId),
      this.missions.current(studentId),
      this.prisma.studentAchievement.findMany({
        where: { studentId },
        orderBy: { unlockedAt: 'desc' },
        take: 5,
        include: { achievement: true },
      }),
      this.prisma.studentTitle.findMany({ where: { studentId }, include: { title: true } }),
      this.prisma.quizAttempt.aggregate({
        where: { studentId, scorePct: { not: null } },
        _avg: { scorePct: true },
        _count: { _all: true },
      }),
      this.prisma.certificate.count({ where: { studentId } }),
    ]);

    const earnedCount = await this.prisma.studentAchievement.count({ where: { studentId } });
    const totalAchievements = await this.prisma.achievement.count({ where: { isActive: true } });

    // "At risk" is the honest version of a streak warning: the streak exists,
    // and nothing has counted toward it today yet.
    const lastActive = profile?.lastActivityDate ? dayKey(profile.lastActivityDate) : null;
    const streakAtRisk = (profile?.currentStreak ?? 0) > 0 && lastActive !== dayKey();

    return {
      xp: agg.xp,
      coins: agg.coins,
      coinsEarned: agg.coinsEarned,
      coinsSpent: agg.coinsSpent,
      level: {
        level: level.level.level,
        nameAr: level.level.nameAr,
        nameEn: level.level.nameEn,
        icon: level.level.icon,
        xpIntoLevel: level.xpIntoLevel,
        xpForNext: level.xpForNext,
        pct: level.pct,
        nextLevel: level.next ? { level: level.next.level, nameAr: level.next.nameAr, nameEn: level.next.nameEn } : null,
      },
      streak: {
        current: profile?.currentStreak ?? 0,
        longest: profile?.longestStreak ?? 0,
        freezes: agg.streakFreezes,
        atRisk: streakAtRisk,
      },
      weeklyGoal: {
        target: summary.weeklyGoalLessons,
        done: summary.lessonsCompletedThisWeek,
        pct: summary.weeklyGoalPct,
      },
      stats: {
        lessonsCompleted: agg.lessonsCompleted,
        quizzesPassed: agg.quizzesPassed,
        perfectQuizzes: agg.perfectQuizzes,
        coursesCompleted: agg.coursesCompleted,
        assignmentsDone: agg.assignmentsDone,
        liveAttended: agg.liveAttended,
        certificates,
        quizAccuracy: accuracy._count._all ? Math.round(accuracy._avg.scorePct ?? 0) : null,
        activeCourses: summary.activeCourses,
      },
      rank: {
        weekly: standing.rank,
        weeklyXp: standing.weeklyXp,
        division: standing.division.key,
        divisionIcon: standing.division.icon,
        best: agg.bestRank,
      },
      activeTitle: agg.activeTitle,
      titles: titles.map((t) => ({ key: t.titleKey, labelAr: t.title.labelAr, labelEn: t.title.labelEn, icon: t.title.icon })),
      achievements: {
        earned: earnedCount,
        total: totalAchievements,
        recent: achievements.map((a) => ({
          key: a.achievement.key,
          icon: a.achievement.icon,
          titleAr: a.achievement.titleAr,
          titleEn: a.achievement.titleEn,
          unlockedAt: a.unlockedAt,
        })),
      },
      missions: missions.map((m) => ({
        id: m.id,
        kind: m.kind,
        template: m.template,
        target: m.target,
        progress: m.progress,
        xpReward: m.xpReward,
        coinReward: m.coinReward,
        completed: !!m.completedAt,
      })),
    };
  }

  achievementBoard(userId: string) {
    return this.studentIdOf(userId).then((id) => this.achievements.board(id));
  }

  missionList(userId: string) {
    return this.studentIdOf(userId).then((id) => this.missions.current(id));
  }

  /**
   * The reward ledger, as the student's own history. Every line is an action
   * they took — which is the point: the numbers should always be explainable.
   */
  async activity(userId: string, limit = 30) {
    const studentId = await this.studentIdOf(userId);
    const rows = await this.prisma.gamificationEvent.findMany({
      where: { studentId, type: { not: 'STUDY_WINDOW' } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
    });
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      xp: r.xpAwarded,
      coins: r.coinsAwarded,
      entityType: r.entityType,
      meta: r.meta,
      at: r.createdAt,
    }));
  }

  /** Wear a title you have unlocked (or take it off). */
  async setTitle(userId: string, titleKey: string | null) {
    const studentId = await this.studentIdOf(userId);
    if (titleKey) {
      const owned = await this.prisma.studentTitle.findUnique({
        where: { studentId_titleKey: { studentId, titleKey } },
      });
      if (!owned) throw new NotFoundException('You have not unlocked this title');
    }
    await this.prisma.studentGamification.upsert({
      where: { studentId },
      create: { studentId, activeTitle: titleKey },
      update: { activeTitle: titleKey },
    });
    return { activeTitle: titleKey };
  }

  // ── Reward store ──────────────────────────────────────────────────────────

  /** Platform rewards plus any offered by an academy this student learns with. */
  async rewards(userId: string) {
    const studentId = await this.studentIdOf(userId);
    const [agg, enrollments] = await Promise.all([
      this.engine.profile(studentId),
      this.prisma.enrollment.findMany({
        where: { studentId, status: 'ACTIVE' },
        select: { tenantId: true },
        distinct: ['tenantId'],
      }),
    ]);
    const tenantIds = enrollments.map((e) => e.tenantId);
    const rows = await this.prisma.reward.findMany({
      where: { isActive: true, OR: [{ tenantId: null }, { tenantId: { in: tenantIds } }] },
      orderBy: [{ sortOrder: 'asc' }, { costCoins: 'asc' }],
    });
    return {
      coins: agg.coins,
      rewards: rows.map((r) => ({
        key: r.key,
        category: r.category,
        kind: r.kind,
        icon: r.icon,
        titleAr: r.titleAr,
        titleEn: r.titleEn,
        descAr: r.descAr,
        descEn: r.descEn,
        costCoins: r.costCoins,
        stock: r.stock,
        needsApproval: r.needsApproval,
        affordable: agg.coins >= r.costCoins,
      })),
    };
  }

  /**
   * Spend coins.
   *
   * The balance check and the debit are one conditional write, so two taps on a
   * slow connection cannot buy the same thing twice on one balance. Coins only
   * — nothing in this method can reach the real-money wallet, which lives in a
   * different module and a different table entirely.
   */
  async redeem(userId: string, rewardKey: string) {
    const studentId = await this.studentIdOf(userId);
    const reward = await this.prisma.reward.findUnique({ where: { key: rewardKey } });
    if (!reward || !reward.isActive) throw new NotFoundException('Reward not available');
    if (reward.stock != null && reward.stock <= 0) throw new BadRequestException('This reward is sold out');

    const payload = (reward.payload ?? {}) as Record<string, unknown>;

    const redemption = await this.prisma.$transaction(async (tx) => {
      const debit = await tx.studentGamification.updateMany({
        where: { studentId, coins: { gte: reward.costCoins } },
        data: { coins: { decrement: reward.costCoins }, coinsSpent: { increment: reward.costCoins } },
      });
      if (!debit.count) throw new BadRequestException('Not enough coins');

      if (reward.stock != null) {
        const took = await tx.reward.updateMany({
          where: { id: reward.id, stock: { gt: 0 } },
          data: { stock: { decrement: 1 } },
        });
        if (!took.count) throw new BadRequestException('This reward is sold out');
      }

      // A real-world prize is a promise, not an effect: it waits for an admin.
      const instant = reward.kind !== 'REAL' && !reward.needsApproval;
      const row = await tx.rewardRedemption.create({
        data: {
          studentId,
          rewardId: reward.id,
          costCoins: reward.costCoins,
          status: reward.kind === 'XP_BOOST' ? 'ACTIVE' : instant ? 'FULFILLED' : 'PENDING',
          meta:
            reward.kind === 'XP_BOOST'
              ? ({ remaining: Number(payload.lessons ?? 3), multiplier: Number(payload.multiplier ?? 2) } as Prisma.InputJsonValue)
              : ({} as Prisma.InputJsonValue),
        },
      });

      await tx.gamificationEvent.create({
        data: {
          studentId,
          type: 'REWARD_REDEEMED',
          entityType: 'reward',
          entityId: reward.key,
          xpAwarded: 0,
          coinsAwarded: -reward.costCoins,
          idempotencyKey: `REDEEM:${row.id}`,
          meta: { rewardKey: reward.key, kind: reward.kind } as Prisma.InputJsonValue,
        },
      });

      if (reward.kind === 'STREAK_FREEZE') {
        await tx.studentGamification.update({
          where: { studentId },
          data: { streakFreezes: { increment: Number(payload.count ?? 1) } },
        });
      }
      if (reward.kind === 'TITLE' && typeof payload.titleKey === 'string') {
        await tx.studentTitle
          .create({ data: { studentId, titleKey: payload.titleKey } })
          .catch(() => undefined);
      }
      return row;
    });

    const agg = await this.prisma.studentGamification.findUnique({ where: { studentId } });
    return {
      redeemed: true,
      status: redemption.status,
      coins: agg?.coins ?? 0,
      kind: reward.kind,
    };
  }
}
