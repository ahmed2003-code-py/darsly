import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { monthKey, weekKey } from './period.util';

export type LeaderboardScope = 'GLOBAL' | 'ACADEMY' | 'COURSE';
export type LeaderboardPeriod = 'WEEKLY' | 'MONTHLY' | 'ALLTIME';

/**
 * Divisions.
 *
 * A single all-time board is won permanently by whoever started first, and
 * everyone who joins later is playing for 400th place. Weekly XP decides the
 * division instead, so a student who has a good week is promoted regardless of
 * how long they have been here, and last year's champion who stopped studying
 * drops back down. Thresholds are weekly XP, so they reset with the week.
 */
export const DIVISIONS = [
  { key: 'BRONZE', minWeeklyXp: 0, icon: 'shield' },
  { key: 'SILVER', minWeeklyXp: 150, icon: 'shield' },
  { key: 'GOLD', minWeeklyXp: 400, icon: 'shield' },
  { key: 'PLATINUM', minWeeklyXp: 800, icon: 'shield' },
  { key: 'DIAMOND', minWeeklyXp: 1500, icon: 'diamond' },
  { key: 'MASTER', minWeeklyXp: 3000, icon: 'workspace_premium' },
] as const;

export type Division = (typeof DIVISIONS)[number];

export function divisionFor(weeklyXp: number): Division {
  let d: Division = DIVISIONS[0];
  for (const x of DIVISIONS) if (weeklyXp >= x.minWeeklyXp) d = x;
  return d;
}

/** Only ever the fields a competitor is meant to see about another competitor. */
export interface LeaderboardRow {
  rank: number;
  studentId: string;
  name: string;
  avatarUrl: string | null;
  level: number;
  xp: number;
  title: string | null;
  isMe: boolean;
}

@Injectable()
export class LeaderboardService {
  constructor(private readonly prisma: PrismaService) {}

  private periodKey(period: LeaderboardPeriod, at = new Date()): string {
    return period === 'WEEKLY' ? weekKey(at) : period === 'MONTHLY' ? monthKey(at) : 'all';
  }

  /**
   * Add XP to every board this event belongs to, inside the caller's
   * transaction.
   *
   * Written incrementally on the way in rather than aggregated from the ledger
   * on the way out: a board is read far more often than it is written, and
   * summing a year of events per page view is how leaderboards become the
   * slowest screen in a product.
   */
  async bump(
    tx: Prisma.TransactionClient,
    input: { studentId: string; tenantId?: string | null; courseId?: string | null; xp: number },
  ): Promise<void> {
    if (input.xp <= 0) return;
    const now = new Date();
    const targets: { scope: LeaderboardScope; scopeId: string; period: LeaderboardPeriod }[] = [
      { scope: 'GLOBAL', scopeId: '', period: 'WEEKLY' },
      { scope: 'GLOBAL', scopeId: '', period: 'MONTHLY' },
      { scope: 'GLOBAL', scopeId: '', period: 'ALLTIME' },
    ];
    if (input.tenantId) {
      targets.push(
        { scope: 'ACADEMY', scopeId: input.tenantId, period: 'WEEKLY' },
        { scope: 'ACADEMY', scopeId: input.tenantId, period: 'MONTHLY' },
        { scope: 'ACADEMY', scopeId: input.tenantId, period: 'ALLTIME' },
      );
    }
    if (input.courseId) {
      targets.push({ scope: 'COURSE', scopeId: input.courseId, period: 'ALLTIME' });
    }

    for (const t of targets) {
      const periodKey = this.periodKey(t.period, now);
      await tx.leaderboardEntry.upsert({
        where: {
          scope_scopeId_period_periodKey_studentId: {
            scope: t.scope,
            scopeId: t.scopeId,
            period: t.period,
            periodKey,
            studentId: input.studentId,
          },
        },
        create: {
          scope: t.scope,
          scopeId: t.scopeId,
          period: t.period,
          periodKey,
          studentId: input.studentId,
          xp: input.xp,
        },
        update: { xp: { increment: input.xp } },
      });
    }
  }

  private where(scope: LeaderboardScope, scopeId: string, period: LeaderboardPeriod) {
    return { scope, scopeId, period, periodKey: this.periodKey(period) };
  }

  /** The top of a board, plus the caller's own row wherever it sits. */
  async board(opts: {
    scope: LeaderboardScope;
    scopeId?: string;
    period: LeaderboardPeriod;
    studentId?: string;
    limit?: number;
  }): Promise<{
    top: LeaderboardRow[];
    me: LeaderboardRow | null;
    around: LeaderboardRow[];
    total: number;
    toNextRank: number | null;
  }> {
    const where = this.where(opts.scope, opts.scopeId ?? '', opts.period);
    const limit = Math.min(opts.limit ?? 20, 100);

    const [rows, total] = await Promise.all([
      this.prisma.leaderboardEntry.findMany({
        where,
        orderBy: [{ xp: 'desc' }, { updatedAt: 'asc' }],
        take: limit,
        include: this.studentInclude(),
      }),
      this.prisma.leaderboardEntry.count({ where }),
    ]);

    const top = rows.map((r, i) => this.toRow(r, i + 1, opts.studentId));

    let me: LeaderboardRow | null = null;
    let around: LeaderboardRow[] = [];
    let toNextRank: number | null = null;

    if (opts.studentId) {
      const mine = await this.prisma.leaderboardEntry.findUnique({
        where: {
          scope_scopeId_period_periodKey_studentId: { ...where, studentId: opts.studentId },
        },
        include: this.studentInclude(),
      });
      if (mine) {
        // Rank by counting everyone strictly ahead — an index range count, not
        // a scan of the board.
        const ahead = await this.prisma.leaderboardEntry.count({
          where: { ...where, xp: { gt: mine.xp } },
        });
        const rank = ahead + 1;
        me = this.toRow(mine, rank, opts.studentId);

        // Two above and two below: the only part of a 4,000-row board that
        // tells a student what to do next.
        if (rank > limit) {
          const skip = Math.max(0, rank - 3);
          const neighbours = await this.prisma.leaderboardEntry.findMany({
            where,
            orderBy: [{ xp: 'desc' }, { updatedAt: 'asc' }],
            skip,
            take: 5,
            include: this.studentInclude(),
          });
          around = neighbours.map((r, i) => this.toRow(r, skip + i + 1, opts.studentId));
        }

        if (rank > 1) {
          const next = await this.prisma.leaderboardEntry.findFirst({
            where: { ...where, xp: { gt: mine.xp } },
            orderBy: { xp: 'asc' },
            select: { xp: true },
          });
          toNextRank = next ? Math.max(1, next.xp - mine.xp + 1) : null;
        }
      }
    }

    return { top, me, around, total, toNextRank };
  }

  /** This student's weekly XP and the division it puts them in. */
  async standing(studentId: string, tenantId?: string | null) {
    const scope: LeaderboardScope = tenantId ? 'ACADEMY' : 'GLOBAL';
    const where = this.where(scope, tenantId ?? '', 'WEEKLY');
    const entry = await this.prisma.leaderboardEntry.findUnique({
      where: { scope_scopeId_period_periodKey_studentId: { ...where, studentId } },
      select: { xp: true },
    });
    const weeklyXp = entry?.xp ?? 0;
    const ahead = entry
      ? await this.prisma.leaderboardEntry.count({ where: { ...where, xp: { gt: entry.xp } } })
      : await this.prisma.leaderboardEntry.count({ where });
    return { weeklyXp, rank: ahead + 1, division: divisionFor(weeklyXp) };
  }

  /**
   * Best rank ever held on the weekly academy board — what the "Top 10" family
   * of achievements is measured against. Recorded on the aggregate so the
   * achievement survives the week resetting.
   */
  async refreshBestRank(studentId: string, tenantId?: string | null): Promise<number | null> {
    const { rank } = await this.standing(studentId, tenantId);
    const agg = await this.prisma.studentGamification.findUnique({
      where: { studentId },
      select: { bestRank: true },
    });
    if (!agg) return null;
    if (agg.bestRank == null || rank < agg.bestRank) {
      await this.prisma.studentGamification.update({
        where: { studentId },
        data: { bestRank: rank },
      });
      return rank;
    }
    return agg.bestRank;
  }

  private studentInclude() {
    return {
      student: {
        select: {
          id: true,
          user: { select: { fullName: true, avatarUrl: true } },
          gamification: { select: { level: true, activeTitle: true } },
        },
      },
    } satisfies Prisma.LeaderboardEntryInclude;
  }

  private toRow(
    r: {
      xp: number;
      studentId: string;
      student: {
        user: { fullName: string; avatarUrl: string | null };
        gamification: { level: number; activeTitle: string | null } | null;
      };
    },
    rank: number,
    meId?: string,
  ): LeaderboardRow {
    return {
      rank,
      studentId: r.studentId,
      name: r.student.user.fullName,
      avatarUrl: r.student.user.avatarUrl,
      level: r.student.gamification?.level ?? 1,
      xp: r.xp,
      title: r.student.gamification?.activeTitle ?? null,
      isMe: !!meId && r.studentId === meId,
    };
  }
}
