import { Injectable } from '@nestjs/common';
import { AnalyticsService } from '../analytics/analytics.service';
import { LedgerService } from '../payments/ledger.service';
import { PrismaService } from '../prisma/prisma.service';

const RANGES = [7, 30, 90] as const;
export type GrowthRange = (typeof RANGES)[number];

export function isGrowthRange(v: unknown): v is GrowthRange {
  return typeof v === 'number' && (RANGES as readonly number[]).includes(v);
}

/**
 * Platform-wide growth trends. DB-side aggregation throughout — this is the
 * platform-scale counterpart to AnalyticsService.teacherOverview, which loads
 * every row into Node and buckets in memory; that pattern doesn't scale past
 * one academy and is deliberately not repeated here.
 */
@Injectable()
export class AdminAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly analytics: AnalyticsService,
  ) {}

  /** New academies, new students, and new enrollments per day — zero-filled. */
  async growthTrend(days: GrowthRange): Promise<{ date: string; academies: number; students: number; enrollments: number }[]> {
    const rows = await this.prisma.$queryRaw<{ day: Date; academies: bigint; students: bigint; enrollments: bigint }[]>`
      WITH days AS (
        SELECT generate_series(
          date_trunc('day', now()) - (${days}::int - 1) * INTERVAL '1 day',
          date_trunc('day', now()),
          INTERVAL '1 day'
        ) AS day
      ), academies AS (
        SELECT date_trunc('day', "createdAt") AS day, COUNT(*) AS n
        FROM "Academy"
        WHERE "createdAt" >= date_trunc('day', now()) - (${days}::int - 1) * INTERVAL '1 day'
          AND "deletedAt" IS NULL
        GROUP BY day
      ), students AS (
        SELECT date_trunc('day', "createdAt") AS day, COUNT(*) AS n
        FROM "User"
        WHERE role = 'STUDENT'
          AND "createdAt" >= date_trunc('day', now()) - (${days}::int - 1) * INTERVAL '1 day'
          AND "deletedAt" IS NULL
        GROUP BY day
      ), enrollments AS (
        SELECT date_trunc('day', "createdAt") AS day, COUNT(*) AS n
        FROM "Enrollment"
        WHERE "createdAt" >= date_trunc('day', now()) - (${days}::int - 1) * INTERVAL '1 day'
          AND "deletedAt" IS NULL
        GROUP BY day
      )
      SELECT
        d.day AS day,
        COALESCE(a.n, 0) AS academies,
        COALESCE(s.n, 0) AS students,
        COALESCE(e.n, 0) AS enrollments
      FROM days d
      LEFT JOIN academies a ON a.day = d.day
      LEFT JOIN students s ON s.day = d.day
      LEFT JOIN enrollments e ON e.day = d.day
      ORDER BY d.day ASC
    `;
    return rows.map((r) => ({
      date: r.day.toISOString().slice(0, 10),
      academies: Number(r.academies),
      students: Number(r.students),
      enrollments: Number(r.enrollments),
    }));
  }

  revenueTrend(days: GrowthRange) {
    return this.ledger.revenueTrend(days);
  }

  /**
   * Platform-wide attendance — reuses AnalyticsService.attendanceStats with
   * tenantId/ctx null (the same nullable-scope convention
   * GamificationAnalyticsService already uses) rather than a second
   * implementation of the same rate/trend query. `byGroup` and `atRisk` come
   * back empty at platform scope — both are inherently per-academy concepts.
   */
  attendanceAggregate(days: GrowthRange) {
    return this.analytics.attendanceStats(null, null, days);
  }

  /**
   * Platform financial totals + payment conversion. Gross/commission come
   * from platformTotals() (unchanged, existing); conversion is PAID ÷
   * (PAID+PENDING+REJECTED) over submitted manual payments in the window —
   * never derived from enrollment counts.
   */
  async financialOverview(days: GrowthRange) {
    const since = new Date(Date.now() - days * 86_400_000);
    const [totals, statusAgg] = await Promise.all([
      this.ledger.platformTotals(),
      this.prisma.payment.groupBy({ by: ['status'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    ]);
    const byStatus = Object.fromEntries(statusAgg.map((r) => [r.status, r._count._all])) as Record<string, number>;
    const paid = byStatus.PAID ?? 0;
    const pending = byStatus.PENDING ?? 0;
    const rejected = byStatus.REJECTED ?? 0;
    const decided = paid + rejected;
    return {
      rangeDays: days,
      grossCents: totals.grossCents,
      commissionCents: totals.commissionCents,
      paymentConversion: {
        paid,
        pending,
        rejected,
        // Of the submissions that reached a decision (paid or rejected) — a
        // still-PENDING one hasn't been decided yet, so it would understate
        // the rate to count it as a failure to convert.
        convertedPct: decided ? Math.round((paid / decided) * 100) : null,
      },
    };
  }

  /**
   * Share of ACTIVE academies that received at least one enrollment in the
   * window — the one activity signal common to every academy regardless of
   * whether it uses groups/attendance/scheduling. Deliberately not a
   * combined score across several signals: a single, named, real number
   * beats a plausible-looking blend of unlike things.
   */
  async activeAcademyRate(days: GrowthRange) {
    const since = new Date(Date.now() - days * 86_400_000);
    // Enrollment.tenantId is a denormalized string, not a Prisma relation to
    // Academy (see the model comment), so this is two batched queries rather
    // than a single relational filter — still no per-academy loop.
    const recentTenantIds = await this.prisma.enrollment.findMany({
      where: { createdAt: { gte: since } },
      distinct: ['academyId'],
      select: { academyId: true },
    });
    const [totalActive, activeWithEnrollment] = await Promise.all([
      this.prisma.academy.count({ where: { status: 'ACTIVE' } }),
      this.prisma.academy.count({
        where: { status: 'ACTIVE', id: { in: recentTenantIds.map((r) => r.academyId).filter((id): id is string => !!id) } },
      }),
    ]);
    return {
      rangeDays: days,
      totalActiveAcademies: totalActive,
      academiesWithRecentEnrollment: activeWithEnrollment,
      ratePct: totalActive ? Math.round((activeWithEnrollment / totalActive) * 100) : null,
    };
  }
}
