import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AcademyContext } from '../academy/academy-context';
import { GroupsService } from '../academy-ops/groups.service';
import { NeedsAttentionService } from '../academy-ops/needs-attention.service';
import { GamificationAnalyticsService } from '../gamification/gamification-analytics.service';
import { LedgerService } from '../payments/ledger.service';
import { PrismaService } from '../prisma/prisma.service';
import { INACTIVITY_DAYS } from './analytics.constants';

/**
 * Only people who are still here.
 *
 * Progress and quiz attempts have no `deletedAt` of their own and are reached
 * through the teacher's own lessons, so removing a student leaves their watch
 * history reachable and counted. A reset academy then reports hundreds of views
 * and a pass rate built entirely from accounts that no longer exist.
 */
const LIVE_STUDENT = { student: { deletedAt: null } } as const;

/** Aggregated teaching KPIs for the teacher analytics dashboard. */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gamification: GamificationAnalyticsService,
    private readonly needsAttention: NeedsAttentionService,
    private readonly groups: GroupsService,
    private readonly ledger: LedgerService,
  ) {}

  async teacherOverview(tenantId: string) {
    const [payments, enrollments, activeEnrollments, reviews, quizAgg] = await Promise.all([
      this.prisma.payment.findMany({
        where: { tenantId, status: 'PAID' },
        select: { amountCents: true, netCents: true, paidAt: true, createdAt: true },
      }),
      this.prisma.enrollment.findMany({
        where: { tenantId },
        select: { createdAt: true, status: true },
      }),
      this.prisma.enrollment.findMany({
        where: { tenantId, status: 'ACTIVE' },
        select: { studentId: true, courseId: true },
      }),
      this.prisma.review.aggregate({ where: { tenantId }, _avg: { rating: true }, _count: true }),
      this.prisma.quizAttempt.findMany({
        where: {
          quiz: { lesson: { unit: { course: { tenantId } } } },
          passed: { not: null },
          ...LIVE_STUDENT,
        },
        select: { passed: true },
      }),
    ]);

    const months = lastMonths(6);
    // An academy's revenue is what it earns, not what the student paid: the
    // difference between the two is the platform fee, so reporting the total
    // here would disclose it by subtraction against the price they set.
    const earning = (p: { amountCents: number; netCents: number | null }) => p.netCents ?? p.amountCents;
    const grossCents = payments.reduce((sum, p) => sum + earning(p), 0);
    const revenueByMonth = bucketByMonth(months, payments.map((p) => ({ at: p.paidAt ?? p.createdAt, v: earning(p) })));
    const enrollmentsByMonth = bucketByMonth(months, enrollments.map((e) => ({ at: e.createdAt, v: 1 })));

    const activeStudents = new Set(activeEnrollments.map((e) => e.studentId)).size;

    // Completion rate: completed lessons ÷ lessons in the courses students are
    // actively enrolled in.
    const courseIds = [...new Set(activeEnrollments.map((e) => e.courseId))];
    const [lessonCounts, completedByStudent] = await Promise.all([
      courseIds.length
        ? this.prisma.lesson.groupBy({
            by: ['unitId'],
            where: { unit: { courseId: { in: courseIds } } },
            _count: true,
          })
        : Promise.resolve([]),
      this.prisma.lessonProgress.count({
        where: {
          completedAt: { not: null },
          lesson: { unit: { course: { tenantId } } },
          student: { deletedAt: null, enrollments: { some: { tenantId, status: 'ACTIVE', deletedAt: null } } },
        },
      }),
    ]);
    // Total lessons per course (via units), then × active enrollments per course.
    const lessonsPerCourse = await this.lessonsPerCourse(courseIds);
    const totalRequired = activeEnrollments.reduce((s, e) => s + (lessonsPerCourse[e.courseId] ?? 0), 0);
    const completionRatePct = totalRequired ? Math.round((completedByStudent / totalRequired) * 100) : 0;

    const passed = quizAgg.filter((a) => a.passed).length;
    const quizPassRatePct = quizAgg.length ? Math.round((passed / quizAgg.length) * 100) : 0;

    const topLessons = await this.topLessons(tenantId);

    return {
      grossCents,
      activeStudents,
      totalEnrollments: enrollments.length,
      pendingEnrollments: enrollments.filter((e) => e.status === 'PENDING_PAYMENT').length,
      completionRatePct,
      quizPassRatePct,
      avgRating: reviews._avg.rating ? Math.round(reviews._avg.rating * 10) / 10 : null,
      reviewsCount: reviews._count,
      revenueByMonth,
      enrollmentsByMonth,
      topLessons,
    };
  }

  private async lessonsPerCourse(courseIds: string[]): Promise<Record<string, number>> {
    if (!courseIds.length) return {};
    const units = await this.prisma.courseUnit.findMany({
      where: { courseId: { in: courseIds } },
      select: { courseId: true, _count: { select: { lessons: true } } },
    });
    const map: Record<string, number> = {};
    for (const u of units) map[u.courseId] = (map[u.courseId] ?? 0) + u._count.lessons;
    return map;
  }

  private async topLessons(tenantId: string) {
    const rows = await this.prisma.lessonProgress.groupBy({
      by: ['lessonId'],
      where: { lesson: { unit: { course: { tenantId } } }, ...LIVE_STUDENT },
      _sum: { viewCount: true },
      orderBy: { _sum: { viewCount: 'desc' } },
      take: 5,
    });
    const lessons = await this.prisma.lesson.findMany({
      where: { id: { in: rows.map((r) => r.lessonId) } },
      select: { id: true, title: true },
    });
    const titles = Object.fromEntries(lessons.map((l) => [l.id, l.title]));
    return rows
      .filter((r) => titles[r.lessonId])
      .map((r) => ({ lessonId: r.lessonId, title: titles[r.lessonId], views: r._sum.viewCount ?? 0 }));
  }

  // ── Phase 6: analytics expansion ────────────────────────────────────────
  //
  // Everything below composes existing sources of truth rather than
  // re-deriving them: GamificationAnalyticsService for activity/retention,
  // NeedsAttentionService for at-risk attendance, GroupsService for group
  // metadata, LedgerService/Payment for money. teacherOverview() above is
  // untouched — these are additional, more detailed sections a real
  // analytics page reads, not a replacement for it.

  /**
   * Students — total ever enrolled, currently ACTIVE (unexpired), new in the
   * window, week-over-week returning (reused from GamificationAnalyticsService),
   * and inactive (an ACTIVE-enrolled student with no tenant-scoped
   * GamificationEvent in INACTIVITY_DAYS — the exact rule NeedsAttentionService
   * already flags students with, reused rather than redefined).
   */
  async students(ctx: AcademyContext, days: number) {
    // Organisation scope: Enrollment.academyId. tenantId (the course author) is
    // only still used for the tenant-keyed gamification store.
    const tenantId = ctx.academyId;
    const academyId = ctx.academyId;
    const since = new Date(Date.now() - days * 86_400_000);
    const [total, active, newRows, engagement, attention] = await Promise.all([
      this.prisma.enrollment.findMany({ where: { academyId }, distinct: ['studentId'], select: { studentId: true } }),
      this.prisma.enrollment.findMany({
        where: { academyId, status: 'ACTIVE', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        distinct: ['studentId'],
        select: { studentId: true },
      }),
      this.prisma.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(*) AS n FROM (
          SELECT "studentId", MIN("createdAt") AS first
          FROM "Enrollment" WHERE "academyId" = ${academyId} AND "deletedAt" IS NULL
          GROUP BY "studentId"
        ) f WHERE f.first >= ${since}
      `,
      this.gamification.overview(tenantId),
      this.needsAttention.overview(ctx),
    ]);
    return {
      rangeDays: days,
      totalEnrolledStudents: total.length,
      activeStudents: active.length,
      newStudents: Number(newRows[0]?.n ?? 0),
      returning: engagement.returning,
      inactiveStudents: attention.inactiveStudents.length,
      inactivityThresholdDays: INACTIVITY_DAYS,
    };
  }

  /**
   * Day-by-day growth for this academy: new students (first enrollment ever,
   * with this academy), new enrollment requests, enrollments activated that
   * day (status flips to ACTIVE, not a running total — there is no historical
   * snapshot table to reconstruct a point-in-time count from), and course
   * activity (lessons completed). DB-side date_trunc throughout, zero-filled,
   * same technique as AdminAnalyticsService.growthTrend.
   */
  async growth(academyId: string, days: number) {
    const tenantId = academyId;
    const rows = await this.prisma.$queryRaw<
      { day: Date; newstudents: bigint; newenrollments: bigint; activated: bigint; courseactivity: bigint }[]
    >`
      WITH days AS (
        SELECT generate_series(
          date_trunc('day', now()) - (${days}::int - 1) * INTERVAL '1 day',
          date_trunc('day', now()),
          INTERVAL '1 day'
        ) AS day
      ), new_students AS (
        SELECT date_trunc('day', first) AS day, COUNT(*) AS n FROM (
          SELECT "studentId", MIN("createdAt") AS first
          FROM "Enrollment" WHERE "academyId" = ${academyId} AND "deletedAt" IS NULL
          GROUP BY "studentId"
        ) f
        WHERE first >= date_trunc('day', now()) - (${days}::int - 1) * INTERVAL '1 day'
        GROUP BY day
      ), new_enrollments AS (
        SELECT date_trunc('day', "createdAt") AS day, COUNT(*) AS n
        FROM "Enrollment"
        WHERE "academyId" = ${academyId} AND "deletedAt" IS NULL
          AND "createdAt" >= date_trunc('day', now()) - (${days}::int - 1) * INTERVAL '1 day'
        GROUP BY day
      ), activated AS (
        SELECT date_trunc('day', "approvedAt") AS day, COUNT(*) AS n
        FROM "Enrollment"
        WHERE "academyId" = ${academyId} AND "deletedAt" IS NULL AND status = 'ACTIVE'
          AND "approvedAt" >= date_trunc('day', now()) - (${days}::int - 1) * INTERVAL '1 day'
        GROUP BY day
      ), activity AS (
        SELECT date_trunc('day', lp."completedAt") AS day, COUNT(*) AS n
        FROM "LessonProgress" lp
        JOIN "Lesson" l ON l.id = lp."lessonId"
        JOIN "CourseUnit" u ON u.id = l."unitId"
        JOIN "Course" c ON c.id = u."courseId"
        WHERE c."academyId" = ${academyId}
          AND lp."completedAt" >= date_trunc('day', now()) - (${days}::int - 1) * INTERVAL '1 day'
        GROUP BY day
      )
      SELECT d.day AS day,
        COALESCE(ns.n, 0) AS newstudents,
        COALESCE(ne.n, 0) AS newenrollments,
        COALESCE(ac.n, 0) AS activated,
        COALESCE(ca.n, 0) AS courseactivity
      FROM days d
      LEFT JOIN new_students ns ON ns.day = d.day
      LEFT JOIN new_enrollments ne ON ne.day = d.day
      LEFT JOIN activated ac ON ac.day = d.day
      LEFT JOIN activity ca ON ca.day = d.day
      ORDER BY d.day ASC
    `;
    return rows.map((r) => ({
      date: r.day.toISOString().slice(0, 10),
      newStudents: Number(r.newstudents),
      newEnrollments: Number(r.newenrollments),
      activatedEnrollments: Number(r.activated),
      courseActivity: Number(r.courseactivity),
    }));
  }

  /**
   * Enrollment counts by status, and — among ACTIVE enrollments — by source.
   * `source` is null for both an instantly-activated free enrollment AND a
   * verified paid one; neither path stamps it (see EnrollmentSource), so
   * "automatic" here means "not staff-granted", not "unpaid". Never confuse
   * this with Payment.method/status, a different axis entirely.
   */
  async enrollmentBreakdown(academyId: string) {
    const [statusAgg, sourceAgg] = await Promise.all([
      this.prisma.enrollment.groupBy({ by: ['status'], where: { academyId }, _count: { _all: true } }),
      this.prisma.enrollment.groupBy({ by: ['source'], where: { academyId, status: 'ACTIVE' }, _count: { _all: true } }),
    ]);
    const byStatus = Object.fromEntries(statusAgg.map((r) => [r.status, r._count._all])) as Record<string, number>;
    let automatic = 0;
    let manual = 0;
    let demo = 0;
    for (const r of sourceAgg) {
      if (r.source === 'DEMO') demo += r._count._all;
      else if (r.source === 'MANUAL_APPROVAL') manual += r._count._all;
      else automatic += r._count._all;
    }
    return {
      total: Object.values(byStatus).reduce((s, n) => s + n, 0),
      byStatus: {
        active: byStatus.ACTIVE ?? 0,
        pendingPayment: byStatus.PENDING_PAYMENT ?? 0,
        pendingApproval: byStatus.PENDING_APPROVAL ?? 0,
        rejected: byStatus.REJECTED ?? 0,
        revoked: byStatus.REVOKED ?? 0,
        expired: byStatus.EXPIRED ?? 0,
      },
      activeBySource: { automatic, manual, demo },
    };
  }

  /**
   * Attendance rate = PRESENT / (PRESENT+ABSENT+LATE+EXCUSED); raw counts are
   * returned alongside so a different definition can be recomputed by the
   * caller if needed. `tenantId: null` is the platform-wide view (only
   * AdminAnalyticsService may reach that — see its attendanceAggregate()),
   * mirroring the same nullable-scope convention GamificationAnalyticsService
   * already uses. `byGroup` is academy-only (a group has no meaning
   * platform-wide). At-risk students are NeedsAttentionService's own
   * repeated-absence rule, reused rather than redefined here.
   */
  async attendanceStats(ctx: AcademyContext | null, tenantId: string | null, days: number) {
    const since = new Date(Date.now() - days * 86_400_000);
    const scope = tenantId ? Prisma.sql`AND r."academyId" = ${tenantId}` : Prisma.sql``;

    const [counts, trend, byGroup, atRisk] = await Promise.all([
      this.prisma.$queryRaw<{ status: string; n: bigint }[]>`
        SELECT r.status, COUNT(*) AS n
        FROM "AttendanceRecord" r
        JOIN "AttendanceSession" s ON s.id = r."sessionId"
        WHERE r."deletedAt" IS NULL AND s."deletedAt" IS NULL AND s.date >= ${since}
          ${scope}
        GROUP BY r.status
      `,
      this.prisma.$queryRaw<{ day: Date; present: bigint; total: bigint }[]>`
        WITH days AS (
          SELECT generate_series(
            date_trunc('day', now()) - (${days}::int - 1) * INTERVAL '1 day',
            date_trunc('day', now()),
            INTERVAL '1 day'
          ) AS day
        ), agg AS (
          SELECT date_trunc('day', s.date) AS day,
            COUNT(*) FILTER (WHERE r.status = 'PRESENT') AS present,
            COUNT(*) AS total
          FROM "AttendanceRecord" r
          JOIN "AttendanceSession" s ON s.id = r."sessionId"
          WHERE r."deletedAt" IS NULL AND s."deletedAt" IS NULL
            AND s.date >= date_trunc('day', now()) - (${days}::int - 1) * INTERVAL '1 day'
            ${scope}
          GROUP BY day
        )
        SELECT d.day AS day, COALESCE(a.present, 0) AS present, COALESCE(a.total, 0) AS total
        FROM days d LEFT JOIN agg a ON a.day = d.day
        ORDER BY d.day ASC
      `,
      tenantId
        ? this.prisma.$queryRaw<{ groupId: string; name: string; present: bigint; total: bigint }[]>`
            SELECT g.id AS "groupId", g.name,
              COUNT(*) FILTER (WHERE r.status = 'PRESENT') AS present, COUNT(*) AS total
            FROM "AttendanceRecord" r
            JOIN "AttendanceSession" s ON s.id = r."sessionId"
            JOIN "Group" g ON g.id = s."groupId"
            WHERE r."deletedAt" IS NULL AND s."deletedAt" IS NULL AND s.date >= ${since}
              AND g."academyId" = ${tenantId} AND g."deletedAt" IS NULL
            GROUP BY g.id, g.name
          `
        : Promise.resolve([] as { groupId: string; name: string; present: bigint; total: bigint }[]),
      ctx ? this.needsAttention.overview(ctx) : Promise.resolve(null),
    ]);

    const byStatus = Object.fromEntries(counts.map((r) => [r.status, Number(r.n)])) as Record<string, number>;
    const present = byStatus.PRESENT ?? 0;
    const totalMarked = Object.values(byStatus).reduce((s, n) => s + n, 0);
    return {
      rangeDays: days,
      counts: {
        present,
        absent: byStatus.ABSENT ?? 0,
        late: byStatus.LATE ?? 0,
        excused: byStatus.EXCUSED ?? 0,
      },
      attendanceRatePct: totalMarked ? Math.round((present / totalMarked) * 100) : null,
      trend: trend.map((r) => ({
        date: r.day.toISOString().slice(0, 10),
        present: Number(r.present),
        total: Number(r.total),
        ratePct: Number(r.total) ? Math.round((Number(r.present) / Number(r.total)) * 100) : null,
      })),
      byGroup: byGroup.map((g) => ({
        groupId: g.groupId,
        name: g.name,
        present: Number(g.present),
        total: Number(g.total),
        ratePct: Number(g.total) ? Math.round((Number(g.present) / Number(g.total)) * 100) : null,
      })),
      atRisk: atRisk?.repeatedAbsences ?? [],
    };
  }

  /**
   * Per-group operational stats. Reuses GroupsService.list for the
   * already-batched group + staff metadata (never a second, parallel
   * implementation of that), and adds attendance rate + session counts,
   * themselves batched (one query per metric across all groups, never one
   * query per group).
   */
  async groupsOverview(ctx: AcademyContext) {
    const base = await this.groups.list(ctx, { pageSize: 100 });
    const groupIds = base.groups.map((g) => g.id);
    if (!groupIds.length) return { total: base.total, groups: [] as unknown[] };

    const [attendanceAgg, sessionAgg, upcomingAgg] = await Promise.all([
      this.prisma.$queryRaw<{ groupId: string; present: bigint; total: bigint }[]>`
        SELECT s."groupId" AS "groupId",
          COUNT(*) FILTER (WHERE r.status = 'PRESENT') AS present, COUNT(*) AS total
        FROM "AttendanceRecord" r
        JOIN "AttendanceSession" s ON s.id = r."sessionId"
        WHERE r."deletedAt" IS NULL AND s."deletedAt" IS NULL AND s."groupId" = ANY(${groupIds}::text[])
        GROUP BY s."groupId"
      `,
      this.prisma.groupSession.groupBy({ by: ['groupId', 'status'], where: { groupId: { in: groupIds } }, _count: { _all: true } }),
      this.prisma.groupSession.groupBy({
        by: ['groupId'],
        where: { groupId: { in: groupIds }, status: 'SCHEDULED', startAt: { gt: new Date() } },
        _count: { _all: true },
      }),
    ]);
    const attByGroup = new Map(attendanceAgg.map((r) => [r.groupId, { present: Number(r.present), total: Number(r.total) }]));
    const sessByGroup = new Map<string, Record<string, number>>();
    for (const r of sessionAgg) {
      const m = sessByGroup.get(r.groupId) ?? {};
      m[r.status] = r._count._all;
      sessByGroup.set(r.groupId, m);
    }
    const upcomingByGroup = new Map(upcomingAgg.map((r) => [r.groupId, r._count._all]));

    return {
      total: base.total,
      groups: base.groups.map((g) => {
        const att = attByGroup.get(g.id) ?? { present: 0, total: 0 };
        const sess = sessByGroup.get(g.id) ?? {};
        return {
          id: g.id,
          name: g.name,
          status: g.status,
          studentsCount: g.studentsCount,
          staff: g.staff,
          attendanceRatePct: att.total ? Math.round((att.present / att.total) * 100) : null,
          sessionsCompleted: sess.COMPLETED ?? 0,
          sessionsCancelled: sess.CANCELLED ?? 0,
          sessionsUpcoming: upcomingByGroup.get(g.id) ?? 0,
        };
      }),
    };
  }

  /**
   * Scheduling totals over the window, plus load breakdowns. Room
   * "utilization" is deliberately NOT a percentage — Room has no
   * operating-hours concept to divide by, so a % would be invented. Reported
   * instead as scheduled minutes + session count per room, per Phase 6 Step 9.
   */
  async schedulingOverview(ctx: AcademyContext, days: number) {
    const tenantId = ctx.academyId;
    const since = new Date(Date.now() - days * 86_400_000);

    const [statusAgg, upcoming, roomAgg, teacherAgg, groupAgg] = await Promise.all([
      this.prisma.groupSession.groupBy({ by: ['status'], where: { academyId: tenantId, startAt: { gte: since } }, _count: { _all: true } }),
      this.prisma.groupSession.count({ where: { academyId: tenantId, status: 'SCHEDULED', startAt: { gt: new Date() } } }),
      this.prisma.$queryRaw<{ roomId: string; name: string; sessions: bigint; minutes: number }[]>`
        SELECT r.id AS "roomId", r.name,
          COUNT(gs.id) AS sessions,
          COALESCE(SUM(EXTRACT(EPOCH FROM (gs."endAt" - gs."startAt")) / 60), 0) AS minutes
        FROM "Room" r
        LEFT JOIN "GroupSession" gs ON gs."roomId" = r.id AND gs.status != 'CANCELLED'
          AND gs."startAt" >= ${since} AND gs."deletedAt" IS NULL
        WHERE r."academyId" = ${tenantId} AND r."deletedAt" IS NULL
        GROUP BY r.id, r.name
      `,
      this.prisma.groupSession.groupBy({
        by: ['teacherUserId'],
        where: { academyId: tenantId, startAt: { gte: since }, teacherUserId: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.groupSession.groupBy({ by: ['groupId'], where: { academyId: tenantId, startAt: { gte: since } }, _count: { _all: true } }),
    ]);

    const teacherIds = teacherAgg.map((t) => t.teacherUserId).filter((x): x is string => !!x);
    const groupIds = groupAgg.map((g) => g.groupId);
    const [teachers, groupsMeta] = await Promise.all([
      teacherIds.length ? this.prisma.user.findMany({ where: { id: { in: teacherIds } }, select: { id: true, fullName: true } }) : Promise.resolve([]),
      groupIds.length ? this.prisma.group.findMany({ where: { id: { in: groupIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    ]);
    const teacherNameById = new Map(teachers.map((t) => [t.id, t.fullName]));
    const groupNameById = new Map(groupsMeta.map((g) => [g.id, g.name]));

    const byStatus = Object.fromEntries(statusAgg.map((r) => [r.status, r._count._all])) as Record<string, number>;
    return {
      rangeDays: days,
      total: Object.values(byStatus).reduce((s, n) => s + n, 0),
      completed: byStatus.COMPLETED ?? 0,
      cancelled: byStatus.CANCELLED ?? 0,
      scheduledInRange: byStatus.SCHEDULED ?? 0,
      upcoming,
      roomUsage: roomAgg.map((r) => ({ roomId: r.roomId, name: r.name, sessions: Number(r.sessions), scheduledMinutes: Math.round(Number(r.minutes)) })),
      teacherLoad: teacherAgg.map((t) => ({
        userId: t.teacherUserId as string,
        fullName: teacherNameById.get(t.teacherUserId as string) ?? '—',
        sessions: t._count._all,
      })),
      groupLoad: groupAgg.map((g) => ({ groupId: g.groupId, name: groupNameById.get(g.groupId) ?? '—', sessions: g._count._all })),
    };
  }

  /**
   * Per-course stats, all batched (one groupBy per metric across every
   * course, never one query per course). Revenue is read from Payment
   * (netCents, falling back to amountCents for legacy rows — the same
   * convention teacherOverview's own `earning()` helper uses), never
   * derived as enrollments × price.
   */
  async coursesOverview(academyId: string) {
    const courses = await this.prisma.course.findMany({
      where: { academyId },
      select: { id: true, title: true, status: true, priceCents: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!courses.length) return [];
    const courseIds = courses.map((c) => c.id);

    const [enrollAgg, sourceAgg, paymentAgg, quizAgg, lessonsPerCourse, completedAgg] = await Promise.all([
      this.prisma.enrollment.groupBy({ by: ['courseId', 'status'], where: { academyId, courseId: { in: courseIds } }, _count: { _all: true } }),
      this.prisma.enrollment.groupBy({
        by: ['courseId', 'source'],
        where: { academyId, courseId: { in: courseIds }, status: 'ACTIVE' },
        _count: { _all: true },
      }),
      this.prisma.payment.groupBy({
        by: ['courseId'],
        where: { academyId, courseId: { in: courseIds }, status: 'PAID' },
        _sum: { netCents: true, amountCents: true },
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<{ courseId: string; attempted: bigint; passed: bigint }[]>`
        SELECT u."courseId" AS "courseId",
          COUNT(*) FILTER (WHERE qa.passed IS NOT NULL) AS attempted,
          COUNT(*) FILTER (WHERE qa.passed = TRUE) AS passed
        FROM "QuizAttempt" qa
        JOIN "Quiz" q ON q.id = qa."quizId"
        JOIN "Lesson" l ON l.id = q."lessonId"
        JOIN "CourseUnit" u ON u.id = l."unitId"
        WHERE u."courseId" = ANY(${courseIds}::text[])
        GROUP BY u."courseId"
      `,
      this.lessonsPerCourse(courseIds),
      this.prisma.$queryRaw<{ courseId: string; completed: bigint }[]>`
        SELECT u."courseId" AS "courseId", COUNT(*) AS completed
        FROM "LessonProgress" lp
        JOIN "Lesson" l ON l.id = lp."lessonId"
        JOIN "CourseUnit" u ON u.id = l."unitId"
        JOIN "Enrollment" e ON e."studentId" = lp."studentId" AND e."courseId" = u."courseId"
        WHERE u."courseId" = ANY(${courseIds}::text[]) AND e."academyId" = ${academyId}
          AND e.status = 'ACTIVE' AND e."deletedAt" IS NULL AND lp."completedAt" IS NOT NULL
        GROUP BY u."courseId"
      `,
    ]);

    const completedByCourse = new Map(completedAgg.map((r) => [r.courseId, Number(r.completed)]));
    const quizByCourse = new Map(quizAgg.map((r) => [r.courseId, { attempted: Number(r.attempted), passed: Number(r.passed) }]));
    const enrollByCourse = new Map<string, Record<string, number>>();
    for (const r of enrollAgg) {
      const m = enrollByCourse.get(r.courseId) ?? {};
      m[r.status] = r._count._all;
      enrollByCourse.set(r.courseId, m);
    }
    const sourceByCourse = new Map<string, { automatic: number; manual: number; demo: number }>();
    for (const r of sourceAgg) {
      const m = sourceByCourse.get(r.courseId) ?? { automatic: 0, manual: 0, demo: 0 };
      if (r.source === 'DEMO') m.demo += r._count._all;
      else if (r.source === 'MANUAL_APPROVAL') m.manual += r._count._all;
      else m.automatic += r._count._all;
      sourceByCourse.set(r.courseId, m);
    }
    const paymentByCourse = new Map(paymentAgg.map((r) => [r.courseId, r]));

    return courses.map((c) => {
      const statuses = enrollByCourse.get(c.id) ?? {};
      const activeCount = statuses.ACTIVE ?? 0;
      const totalEnrollments = Object.values(statuses).reduce((s, n) => s + n, 0);
      const totalLessons = lessonsPerCourse[c.id] ?? 0;
      const totalRequired = activeCount * totalLessons;
      const completed = completedByCourse.get(c.id) ?? 0;
      const p = paymentByCourse.get(c.id);
      const src = sourceByCourse.get(c.id) ?? { automatic: 0, manual: 0, demo: 0 };
      const quiz = quizByCourse.get(c.id);
      return {
        courseId: c.id,
        title: c.title,
        status: c.status,
        priceCents: c.priceCents,
        totalEnrollments,
        activeStudents: activeCount,
        avgProgressPct: totalRequired ? Math.round((completed / totalRequired) * 100) : 0,
        quizPassRatePct: quiz?.attempted ? Math.round((quiz.passed / quiz.attempted) * 100) : null,
        revenueNetCents: p ? p._sum.netCents ?? p._sum.amountCents ?? 0 : 0,
        paidTransactions: p?._count._all ?? 0,
        automaticEnrollments: src.automatic,
        manualEnrollments: src.manual,
        demoEnrollments: src.demo,
      };
    });
  }

  /**
   * Per-staff-member operational load: groups assigned, sessions run,
   * attendance rate of the groups they're assigned to. Deliberately no
   * ranking or "best teacher" score (Phase 6 explicitly forbids that) — rows
   * come back in membership order, nothing here sorts by a computed figure.
   * Course authorship/performance is NOT attributed per staff member: in this
   * data model a Course belongs to the Academy (tenantId), not to an
   * individual TEACHER/ASSISTANT membership, so there is no real signal to
   * report there without inventing one.
   */
  async teachersOverview(ctx: AcademyContext) {
    const tenantId = ctx.academyId;
    const staff = await this.prisma.academyMembership.findMany({
      where: { academyId: tenantId, status: 'ACTIVE', role: { in: ['OWNER', 'TEACHER', 'ASSISTANT'] } },
      select: { userId: true, role: true, user: { select: { fullName: true, avatarUrl: true } } },
    });
    if (!staff.length) return [];
    const userIds = staff.map((s) => s.userId);

    const [groupAssignAgg, sessionAgg, attendanceAgg] = await Promise.all([
      this.prisma.groupAssignment.groupBy({ by: ['userId'], where: { academyId: tenantId, userId: { in: userIds } }, _count: { _all: true } }),
      this.prisma.groupSession.groupBy({ by: ['teacherUserId'], where: { academyId: tenantId, teacherUserId: { in: userIds } }, _count: { _all: true } }),
      this.prisma.$queryRaw<{ userId: string; present: bigint; total: bigint }[]>`
        SELECT ga."userId" AS "userId",
          COUNT(*) FILTER (WHERE r.status = 'PRESENT') AS present, COUNT(*) AS total
        FROM "GroupAssignment" ga
        JOIN "AttendanceSession" s ON s."groupId" = ga."groupId"
        JOIN "AttendanceRecord" r ON r."sessionId" = s.id AND r."academyId" = ga."academyId"
        WHERE ga."academyId" = ${tenantId} AND ga."userId" = ANY(${userIds}::text[]) AND ga."deletedAt" IS NULL
          AND r."deletedAt" IS NULL AND s."deletedAt" IS NULL
        GROUP BY ga."userId"
      `,
    ]);
    const groupsByUser = new Map(groupAssignAgg.map((r) => [r.userId, r._count._all]));
    const sessionsByUser = new Map(sessionAgg.map((r) => [r.teacherUserId as string, r._count._all]));
    const attByUser = new Map(attendanceAgg.map((r) => [r.userId, { present: Number(r.present), total: Number(r.total) }]));

    return staff.map((s) => {
      const att = attByUser.get(s.userId);
      return {
        userId: s.userId,
        fullName: s.user.fullName,
        avatarUrl: s.user.avatarUrl,
        role: s.role,
        groupsAssigned: groupsByUser.get(s.userId) ?? 0,
        sessionsRun: sessionsByUser.get(s.userId) ?? 0,
        attendanceRatePct: att && att.total ? Math.round((att.present / att.total) * 100) : null,
      };
    });
  }

  /**
   * Academy-scoped financial view: NET revenue only — never gross or the
   * platform's commission split, matching the existing rule in
   * LedgerService.teacherEarnings ("gross and commission are the platform's
   * side of the transaction and are none of the academy's business"). Payment
   * counts and revenue-by-course come from Payment (the source of truth for
   * per-course attribution — the ledger has no course dimension), never from
   * enrollments × price.
   */
  /**
   * The Center Admin's dashboard numbers — every figure from the organisation
   * scope (academyId), none of it financial. Reuses the attendance and
   * activity sources that already exist rather than inventing metrics.
   */
  async centerOverview(ctx: AcademyContext) {
    const academyId = ctx.academyId;
    const now = new Date();
    const weekAhead = new Date(now.getTime() + 7 * 86_400_000);
    const monthAgo = new Date(now.getTime() - 30 * 86_400_000);
    const [teachers, studentRows, coursesTotal, coursesPublished, groups, upcomingGroup, upcomingLive, completedMonth, attendanceRows, subjectsActive, recent, kindRow] = await Promise.all([
      this.prisma.academyMembership.count({
        where: { academyId, status: 'ACTIVE', deletedAt: null, role: { in: ['TEACHER', 'OWNER'] }, user: { role: 'TEACHER', teacherProfile: { status: 'APPROVED' } } },
      }),
      this.prisma.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(DISTINCT "studentId") AS n FROM (
          SELECT "studentId" FROM "Enrollment" WHERE "academyId" = ${academyId} AND "deletedAt" IS NULL AND status = 'ACTIVE'
          UNION SELECT "studentId" FROM "GroupMembership" WHERE "academyId" = ${academyId} AND "deletedAt" IS NULL
        ) x`,
      this.prisma.course.count({ where: { academyId } }),
      this.prisma.course.count({ where: { academyId, status: 'PUBLISHED' } }),
      this.prisma.group.count({ where: { academyId, status: 'ACTIVE' } }),
      this.prisma.groupSession.count({ where: { academyId, status: 'SCHEDULED', startAt: { gt: now, lt: weekAhead } } }),
      this.prisma.liveSession.count({ where: { academyId, status: 'SCHEDULED', startsAt: { gt: now, lt: weekAhead } } }),
      this.prisma.groupSession.count({ where: { academyId, status: 'COMPLETED', startAt: { gte: monthAgo } } }),
      this.prisma.$queryRaw<{ present: bigint; total: bigint }[]>`
        SELECT COUNT(*) FILTER (WHERE r.status IN ('PRESENT', 'LATE')) AS present, COUNT(*) AS total
        FROM "AttendanceRecord" r JOIN "AttendanceSession" s ON s.id = r."sessionId"
        WHERE r."academyId" = ${academyId} AND r."deletedAt" IS NULL AND s."deletedAt" IS NULL AND s.date >= ${monthAgo}`,
      this.prisma.academySubject.count({ where: { academyId, isActive: true } }),
      this.prisma.auditLog.findMany({
        where: { academyId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, action: true, entity: true, entityId: true, createdAt: true, actor: { select: { fullName: true } } },
      }),
      this.prisma.academy.findUnique({ where: { id: academyId }, select: { kind: true, name: true } }),
    ]);
    const att = attendanceRows[0];
    const total = Number(att?.total ?? 0);
    return {
      academy: kindRow,
      teachers,
      students: Number(studentRows[0]?.n ?? 0),
      courses: { total: coursesTotal, published: coursesPublished },
      groups,
      sessions: { upcoming7d: upcomingGroup + upcomingLive, upcomingPhysical: upcomingGroup, upcomingLive, completed30d: completedMonth },
      attendance: { records30d: total, presentRate: total ? Math.round((Number(att.present) / total) * 100) : null },
      subjectsActive: kindRow?.kind === 'CENTER' ? subjectsActive : null,
      recentActivity: recent.map((r) => ({ id: r.id, action: r.action, entity: r.entity, entityId: r.entityId, at: r.createdAt, by: r.actor?.fullName ?? null })),
    };
  }

  /**
   * One teacher's own numbers inside the active academy: what they authored
   * here (tenantId + academyId — both, never either alone), the groups they
   * are assigned to, their sessions and the attendance of their groups.
   * Nothing about colleagues, nothing academy-wide.
   */
  async myTeaching(ctx: AcademyContext, authorTenantId: string | undefined, days: number) {
    const academyId = ctx.academyId;
    const userId = ctx.userId;
    const now = new Date();
    const since = new Date(now.getTime() - days * 86_400_000);
    const [courses, activeEnrollments, groups, upcoming, completed, attendanceRows, upcomingLive] = await Promise.all([
      authorTenantId ? this.prisma.course.count({ where: { academyId, tenantId: authorTenantId } }) : 0,
      authorTenantId ? this.prisma.enrollment.count({ where: { academyId, status: 'ACTIVE', course: { tenantId: authorTenantId } } }) : 0,
      this.prisma.groupAssignment.count({ where: { academyId, userId } }),
      this.prisma.groupSession.count({ where: { academyId, teacherUserId: userId, status: 'SCHEDULED', startAt: { gt: now } } }),
      this.prisma.groupSession.count({ where: { academyId, teacherUserId: userId, status: 'COMPLETED', startAt: { gte: since } } }),
      this.prisma.$queryRaw<{ present: bigint; total: bigint }[]>`
        SELECT COUNT(*) FILTER (WHERE r.status IN ('PRESENT', 'LATE')) AS present, COUNT(*) AS total
        FROM "AttendanceRecord" r
        JOIN "AttendanceSession" s ON s.id = r."sessionId"
        JOIN "GroupAssignment" ga ON ga."groupId" = s."groupId" AND ga."userId" = ${userId} AND ga."deletedAt" IS NULL
        WHERE r."academyId" = ${academyId} AND r."deletedAt" IS NULL AND s."deletedAt" IS NULL AND s.date >= ${since}`,
      this.prisma.liveSession.count({ where: { academyId, teacherUserId: userId, status: 'SCHEDULED', startsAt: { gt: now } } }),
    ]);
    const att = attendanceRows[0];
    const total = Number(att?.total ?? 0);
    return {
      academyId,
      courses,
      activeEnrollments,
      groups,
      sessions: { upcoming: upcoming + upcomingLive, upcomingPhysical: upcoming, upcomingLive, completed: completed },
      attendance: { records: total, presentRate: total ? Math.round((Number(att.present) / total) * 100) : null },
    };
  }

  async financialOverview(tenantId: string, days: number) {
    // A Center has no financial model yet (Phase 7). Its own ledger account is
    // empty by construction, but an empty report still reads as a number —
    // refuse instead of showing zeros that look like data.
    const academy = await this.prisma.academy.findUnique({ where: { id: tenantId }, select: { kind: true } });
    if (academy?.kind === 'CENTER') {
      throw new BadRequestException({ message: 'Financial analytics are not available for Centers yet', code: 'FINANCE_NOT_AVAILABLE_FOR_CENTERS' });
    }
    const since = new Date(Date.now() - days * 86_400_000);
    const [statusAgg, netTrend, earnings, byCourse] = await Promise.all([
      this.prisma.payment.groupBy({ by: ['status'], where: { tenantId, createdAt: { gte: since } }, _count: { _all: true } }),
      this.ledger.academyRevenueTrend(tenantId, days),
      this.ledger.teacherEarnings(tenantId),
      this.prisma.payment.groupBy({
        by: ['courseId'],
        where: { tenantId, status: 'PAID' },
        _sum: { netCents: true, amountCents: true },
        _count: { _all: true },
      }),
    ]);
    const byStatus = Object.fromEntries(statusAgg.map((r) => [r.status, r._count._all])) as Record<string, number>;
    const courseIds = byCourse.map((r) => r.courseId);
    const courses = courseIds.length
      ? await this.prisma.course.findMany({ where: { id: { in: courseIds } }, select: { id: true, title: true } })
      : [];
    const titleById = new Map(courses.map((c) => [c.id, c.title]));
    return {
      rangeDays: days,
      lifetimeNetCents: earnings.netCents,
      netRevenueTrend: netTrend,
      paidTransactions: byStatus.PAID ?? 0,
      pendingPayments: byStatus.PENDING ?? 0,
      rejectedPayments: byStatus.REJECTED ?? 0,
      revenueByCourse: byCourse
        .map((r) => ({
          courseId: r.courseId,
          title: titleById.get(r.courseId) ?? '—',
          netCents: r._sum.netCents ?? r._sum.amountCents ?? 0,
          transactions: r._count._all,
        }))
        .sort((a, b) => b.netCents - a.netCents),
    };
  }
}

function lastMonths(n: number): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  const d = new Date();
  d.setDate(1);
  for (let i = n - 1; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push({
      key: `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`,
      label: m.toLocaleDateString('ar-EG', { month: 'short' }),
    });
  }
  return out;
}

function bucketByMonth(months: { key: string; label: string }[], items: { at: Date; v: number }[]) {
  const sums: Record<string, number> = Object.fromEntries(months.map((m) => [m.key, 0]));
  for (const it of items) {
    const d = new Date(it.at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (key in sums) sums[key] += it.v;
  }
  return months.map((m) => ({ label: m.label, value: sums[m.key] }));
}
