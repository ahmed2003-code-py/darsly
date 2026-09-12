import { Injectable, Logger } from '@nestjs/common';
import { Prisma, StudentGamification } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UnlockedAchievement } from './gamification.types';

/**
 * Achievement evaluation.
 *
 * Achievements are rows, not code: each names a *metric* and a threshold, and
 * this service knows how to read every metric. Adding "complete 200 lessons"
 * is an INSERT; it needs no deploy and no new branch here.
 *
 * Most metrics are counters already denormalised onto StudentGamification, so
 * the common case costs one row read. The handful that cannot be counters —
 * certificates, enrolments, subjects, the best rank ever held — are read only
 * when an achievement actually depends on them.
 */
@Injectable()
export class AchievementsService {
  private readonly logger = new Logger(AchievementsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Unlock everything this student now qualifies for.
   *
   * Idempotent by the (studentId, achievementId) unique index: an achievement
   * already held is skipped, and a concurrent double-unlock loses the race
   * quietly rather than paying twice.
   */
  async evaluate(studentId: string, agg: StudentGamification): Promise<UnlockedAchievement[]> {
    const [defs, held] = await Promise.all([
      this.prisma.achievement.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }),
      this.prisma.studentAchievement.findMany({ where: { studentId }, select: { achievementId: true } }),
    ]);
    const heldIds = new Set(held.map((h) => h.achievementId));
    const pending = defs.filter((d) => !heldIds.has(d.id));
    if (!pending.length) return [];

    const metrics = await this.metrics(studentId, agg, new Set(pending.map((p) => p.metric)));
    const unlocked: UnlockedAchievement[] = [];

    for (const def of pending) {
      const value = metrics[def.metric];
      if (value == null) continue;
      // Rank is the one metric where smaller is better: "top 10" means rank ≤ 10.
      const reached = def.metric === 'bestRank' ? value > 0 && value <= def.threshold : value >= def.threshold;
      if (!reached) continue;

      try {
        await this.prisma.studentAchievement.create({
          data: { studentId, achievementId: def.id },
        });
      } catch (e) {
        // Someone else unlocked it in a parallel request — that is a success.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
        throw e;
      }

      if (def.titleKey) {
        await this.prisma.studentTitle
          .create({ data: { studentId, titleKey: def.titleKey } })
          .catch(() => undefined); // already held, or the title was removed
      }

      unlocked.push({
        key: def.key,
        icon: def.icon,
        titleAr: def.titleAr,
        titleEn: def.titleEn,
        xpReward: def.xpReward,
        coinReward: def.coinReward,
        titleKey: def.titleKey,
      });
    }
    return unlocked;
  }

  /** Read only the metrics some pending achievement actually asks about. */
  private async metrics(
    studentId: string,
    agg: StudentGamification,
    wanted: Set<string>,
  ): Promise<Record<string, number>> {
    const out: Record<string, number> = {
      lessonsCompleted: agg.lessonsCompleted,
      quizzesPassed: agg.quizzesPassed,
      perfectQuizzes: agg.perfectQuizzes,
      coursesCompleted: agg.coursesCompleted,
      assignmentsDone: agg.assignmentsDone,
      liveAttended: agg.liveAttended,
      reviewsWritten: agg.reviewsWritten,
      missionsCompleted: agg.missionsCompleted,
      earlyBirdSessions: agg.earlyBirdSessions,
      nightOwlSessions: agg.nightOwlSessions,
      weekendSessions: agg.weekendSessions,
      xp: agg.xp,
      level: agg.level,
      bestRank: agg.bestRank ?? 0,
    };

    if (wanted.has('certificates')) {
      out.certificates = await this.prisma.certificate.count({ where: { studentId } });
    }
    if (wanted.has('enrollments')) {
      out.enrollments = await this.prisma.enrollment.count({ where: { studentId } });
    }
    if (wanted.has('streakBest')) {
      const p = await this.prisma.studentProfile.findUnique({
        where: { id: studentId },
        select: { currentStreak: true, longestStreak: true },
      });
      out.streakBest = Math.max(p?.currentStreak ?? 0, p?.longestStreak ?? 0);
    }
    if (wanted.has('distinctSubjects')) {
      const rows = await this.prisma.enrollment.findMany({
        where: { studentId },
        select: { course: { select: { subjectId: true } } },
      });
      out.distinctSubjects = new Set(rows.map((r) => r.course.subjectId).filter(Boolean)).size;
    }
    return out;
  }

  /**
   * The full board for a student: everything on offer, what they hold, and how
   * far along they are on what they don't. This is what replaced the six
   * hard-coded badges — same keys, so nothing a student already earned
   * disappears.
   */
  async board(studentId: string) {
    const agg = await this.prisma.studentGamification.findUnique({ where: { studentId } });
    const [defs, held] = await Promise.all([
      this.prisma.achievement.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }),
      this.prisma.studentAchievement.findMany({ where: { studentId } }),
    ]);
    const heldAt = new Map(held.map((h) => [h.achievementId, h.unlockedAt]));

    const blank = { lessonsCompleted: 0, quizzesPassed: 0, perfectQuizzes: 0, coursesCompleted: 0,
      assignmentsDone: 0, liveAttended: 0, reviewsWritten: 0, missionsCompleted: 0, earlyBirdSessions: 0,
      nightOwlSessions: 0, weekendSessions: 0, xp: 0, level: 1, bestRank: null } as unknown as StudentGamification;
    const metrics = await this.metrics(studentId, agg ?? blank, new Set(defs.map((d) => d.metric)));

    return defs.map((d) => {
      const value = metrics[d.metric] ?? 0;
      const earned = heldAt.has(d.id);
      // A rank achievement has no honest "62% of the way there" — you either
      // reached the position or you did not.
      const progress =
        d.metric === 'bestRank'
          ? earned || (value > 0 && value <= d.threshold) ? d.threshold : 0
          : Math.min(value, d.threshold);
      return {
        key: d.key,
        category: d.category,
        icon: d.icon,
        titleAr: d.titleAr,
        titleEn: d.titleEn,
        descAr: d.descAr,
        descEn: d.descEn,
        threshold: d.threshold,
        progress,
        earned,
        unlockedAt: heldAt.get(d.id) ?? null,
        xpReward: d.xpReward,
        coinReward: d.coinReward,
      };
    });
  }
}
