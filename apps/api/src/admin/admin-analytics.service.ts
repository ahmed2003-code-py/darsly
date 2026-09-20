import { Injectable } from '@nestjs/common';
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
}
