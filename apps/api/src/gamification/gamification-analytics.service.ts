import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { startOfCairoDay, startOfCairoWeek } from './period.util';

/**
 * Engagement, measured rather than asserted.
 *
 * Every number here is counted from events that actually happened. There is no
 * projection, no "estimated reach", and nothing that reads impressively while
 * meaning nothing — a teacher deciding whether this is working deserves the
 * real figure, including when the real figure is zero.
 *
 * Everything is scoped by `tenantId`. Passing null is the platform-wide view
 * and is only ever reachable from an admin route.
 */
@Injectable()
export class GamificationAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(tenantId: string | null) {
    const scope: Prisma.GamificationEventWhereInput = tenantId ? { tenantId } : {};
    const now = Date.now();
    const since = (days: number) => new Date(now - days * 86_400_000);

    const [active1, active7, active30, byType, missions, retention, top] = await Promise.all([
      this.activeLearners(scope, startOfCairoDay()),
      this.activeLearners(scope, since(7)),
      this.activeLearners(scope, since(30)),
      this.prisma.gamificationEvent.groupBy({
        by: ['type'],
        where: { ...scope, createdAt: { gte: since(30) } },
        _count: { _all: true },
        _sum: { xpAwarded: true },
      }),
      this.missionCompletion(tenantId),
      this.retention(tenantId),
      this.topLearners(tenantId),
    ]);

    const counts: Record<string, number> = {};
    let xpAwarded = 0;
    for (const row of byType) {
      counts[row.type] = row._count._all;
      xpAwarded += row._sum.xpAwarded ?? 0;
    }

    return {
      activeLearners: { today: active1, week: active7, month: active30 },
      /** Of the students active this week, how many were also active last week. */
      returning: await this.returningLearners(scope),
      last30Days: {
        xpAwarded,
        lessonsCompleted: counts.LESSON_COMPLETED ?? 0,
        quizzesPassed: counts.QUIZ_PASSED ?? 0,
        perfectQuizzes: counts.QUIZ_PERFECT ?? 0,
        coursesCompleted: counts.COURSE_COMPLETED ?? 0,
        assignments: counts.ASSIGNMENT_SUBMITTED ?? 0,
        liveAttended: counts.LIVE_ATTENDED ?? 0,
        missionsCompleted: (counts.MISSION_COMPLETED ?? 0) + (counts.WEEKLY_QUEST_COMPLETED ?? 0),
      },
      missions,
      retention,
      streaks: await this.streaks(tenantId),
      topLearners: top,
    };
  }

  private async activeLearners(scope: Prisma.GamificationEventWhereInput, since: Date): Promise<number> {
    const rows = await this.prisma.gamificationEvent.findMany({
      where: { ...scope, createdAt: { gte: since } },
      distinct: ['studentId'],
      select: { studentId: true },
    });
    return rows.length;
  }

  private async returningLearners(scope: Prisma.GamificationEventWhereInput) {
    const now = Date.now();
    const [thisWeek, lastWeek] = await Promise.all([
      this.prisma.gamificationEvent.findMany({
        where: { ...scope, createdAt: { gte: new Date(now - 7 * 86_400_000) } },
        distinct: ['studentId'],
        select: { studentId: true },
      }),
      this.prisma.gamificationEvent.findMany({
        where: {
          ...scope,
          createdAt: { gte: new Date(now - 14 * 86_400_000), lt: new Date(now - 7 * 86_400_000) },
        },
        distinct: ['studentId'],
        select: { studentId: true },
      }),
    ]);
    const prior = new Set(lastWeek.map((r) => r.studentId));
    const returned = thisWeek.filter((r) => prior.has(r.studentId)).length;
    return {
      thisWeek: thisWeek.length,
      lastWeek: prior.size,
      returned,
      pct: prior.size ? Math.round((returned / prior.size) * 100) : 0,
    };
  }

  /**
   * Cohort retention: of the students whose first recorded activity is at least
   * N days old, how many came back on or after day N.
   *
   * Deliberately measured from first activity rather than from signup — a
   * student who registered in March and started learning in September is a
   * September learner, and counting them from March would quietly depress every
   * number here.
   */
  private async retention(tenantId: string | null) {
    const rows = await this.prisma.$queryRaw<{ day: number; eligible: bigint; retained: bigint }[]>`
      WITH first_seen AS (
        SELECT "studentId", MIN("createdAt") AS started
        FROM "GamificationEvent"
        WHERE (${tenantId}::text IS NULL OR "tenantId" = ${tenantId})
        GROUP BY "studentId"
      ), days AS (SELECT unnest(ARRAY[1, 7, 30]) AS day)
      SELECT
        d.day::int AS day,
        COUNT(*) FILTER (WHERE f.started <= NOW() - (d.day * INTERVAL '1 day')) AS eligible,
        COUNT(*) FILTER (
          WHERE f.started <= NOW() - (d.day * INTERVAL '1 day')
            AND EXISTS (
              SELECT 1 FROM "GamificationEvent" e
              WHERE e."studentId" = f."studentId"
                AND e."createdAt" >= f.started + (d.day * INTERVAL '1 day')
                AND (${tenantId}::text IS NULL OR e."tenantId" = ${tenantId})
            )
        ) AS retained
      -- Days drives the join, not the cohort: an academy with no activity yet
      -- must still answer with three "no data" rows rather than an empty list,
      -- or the section renders as a heading with nothing under it.
      FROM days d LEFT JOIN first_seen f ON TRUE
      GROUP BY d.day
      ORDER BY d.day
    `;
    return rows.map((r) => ({
      day: r.day,
      eligible: Number(r.eligible),
      retained: Number(r.retained),
      pct: Number(r.eligible) ? Math.round((Number(r.retained) / Number(r.eligible)) * 100) : 0,
    }));
  }

  private async missionCompletion(tenantId: string | null) {
    // Missions are per-student, not per-academy, so an academy view counts only
    // the missions of students enrolled with it.
    const studentIds = tenantId ? await this.studentsOf(tenantId) : null;
    const where: Prisma.StudentMissionWhereInput = {
      createdAt: { gte: startOfCairoWeek() },
      ...(studentIds ? { studentId: { in: studentIds } } : {}),
    };
    const [total, done] = await Promise.all([
      this.prisma.studentMission.count({ where }),
      this.prisma.studentMission.count({ where: { ...where, completedAt: { not: null } } }),
    ]);
    return { total, completed: done, pct: total ? Math.round((done / total) * 100) : 0 };
  }

  private async streaks(tenantId: string | null) {
    const studentIds = tenantId ? await this.studentsOf(tenantId) : null;
    const where: Prisma.StudentProfileWhereInput = studentIds ? { id: { in: studentIds } } : {};
    const [agg, alive] = await Promise.all([
      this.prisma.studentProfile.aggregate({ where, _avg: { currentStreak: true }, _max: { longestStreak: true } }),
      this.prisma.studentProfile.count({ where: { ...where, currentStreak: { gte: 3 } } }),
    ]);
    return {
      average: Math.round((agg._avg.currentStreak ?? 0) * 10) / 10,
      longest: agg._max.longestStreak ?? 0,
      onAStreak: alive,
    };
  }

  private async topLearners(tenantId: string | null) {
    const rows = await this.prisma.leaderboardEntry.findMany({
      where: {
        scope: tenantId ? 'ACADEMY' : 'GLOBAL',
        scopeId: tenantId ?? '',
        period: 'ALLTIME',
        periodKey: 'all',
      },
      orderBy: { xp: 'desc' },
      take: 10,
      include: {
        student: {
          select: {
            user: { select: { fullName: true, avatarUrl: true } },
            gamification: { select: { level: true } },
          },
        },
      },
    });
    return rows.map((r, i) => ({
      rank: i + 1,
      name: r.student.user.fullName,
      avatarUrl: r.student.user.avatarUrl,
      level: r.student.gamification?.level ?? 1,
      xp: r.xp,
    }));
  }

  /** Students enrolled with this academy — the only ones an academy may count. */
  private async studentsOf(tenantId: string): Promise<string[]> {
    const rows = await this.prisma.enrollment.findMany({
      where: { tenantId },
      distinct: ['studentId'],
      select: { studentId: true },
    });
    return rows.map((r) => r.studentId);
  }
}
