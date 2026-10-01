import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AcademyContext } from '../academy/academy-context';
import { CenterFeesService } from '../center-fees/center-fees.service';
import { ClassScheduleService } from '../class-ops/class-schedule.service';
import { addDays, localDayBounds } from '../class-ops/zoned-time';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { PrismaService } from '../prisma/prisma.service';
import { FollowUpSettingsService } from './settings.service';

/** How far back a streak is looked for. Ten weekly classes fit with room. */
const LOOKBACK_DAYS = 120;
const PAGE = 50;
/** Records per learner and group a streak is read from (thresholds go to 10). */
const MAX_RUN = 30;

export type SignalReason = 'ABSENT_TODAY' | 'ABSENT_STREAK' | 'LATE_STREAK' | 'FEES_OVERDUE';

export interface Signal {
  academyStudentId: string;
  reason: SignalReason;
  /** Which occurrence: the class (absent today), the class a streak started on, the oldest overdue charge. */
  signalKey: string;
  groupId: string | null;
  groupName: string | null;
  /** Streak length; for fees, days overdue. */
  count: number;
  /** Local date the signal refers to (class date, streak start, oldest due date). */
  since: string;
  /** Only for a caller who holds fees.view. */
  overdueCents?: number;
}

/**
 * Who needs follow-up — DERIVED on every read, never stored.
 *
 * Deterministic hints from the truth other phases own: C2 attendance records
 * (absent today, consecutive absences, consecutive lateness in the learner's
 * own group) and C4 balances (a charge overdue by more than the academy's
 * threshold, through CenterFeesService — the one balance definition). A
 * signal never changes attendance or money, contacts nobody and blocks
 * nothing; it is a row on a list.
 *
 * Rules (docs/STUDENT-FOLLOW-UP.md):
 *  - EXCUSED is neither an absence nor a break: it is skipped.
 *  - An absence a makeup covered (a PRESENT/LATE makeup record for that class)
 *    is not an absence: it breaks the streak.
 *  - A makeup guest's record in another group belongs to that visit, not to
 *    the learner's own group's streak.
 *  - Cancelled classes and withdrawn learners raise nothing.
 *
 * Set-based: one window query over the academy's recent records for both
 * streaks, one for today's absences, one C4 read for fees, then cases and
 * contacts joined in bulk — never a query per learner.
 */
@Injectable()
export class FollowUpSignalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly schedule: ClassScheduleService,
    private readonly fees: CenterFeesService,
    private readonly flags: FeatureFlagsService,
    private readonly settings: FollowUpSettingsService,
  ) {}

  /** Every signal in the academy (or for one learner), unordered. */
  async compute(
    academyId: string,
    opts: { academyStudentId?: string; withAmounts?: boolean } = {},
  ) {
    const [clock, cfg, feesOn] = await Promise.all([
      this.schedule.academyClock(academyId),
      this.settings.get(academyId),
      this.flags.isEnabled(academyId, 'centerFees'),
    ]);
    const today = clock.today;
    const since = addDays(today, -LOOKBACK_DAYS);
    const one = opts.academyStudentId
      ? Prisma.sql`AND s.id = ${opts.academyStudentId}`
      : Prisma.empty;

    const [streaks, absentToday, overdue] = await Promise.all([
      this.prisma.$queryRaw<
        {
          academyStudentId: string;
          groupId: string;
          groupName: string;
          absentRun: number;
          lateRun: number;
          absentStart: string | null;
          absentSince: string | null;
          lateStart: string | null;
          lateSince: string | null;
        }[]
      >`
        WITH recs AS (
          SELECT s.id AS "academyStudentId", sh."groupId", sh.id AS shid, sh.date,
                 COALESCE(gs."startAt", sh.date::timestamp) AS at,
                 (r.status = 'ABSENT' AND NOT (gs.id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM "AttendanceRecord" m
                    WHERE m."makeupForSessionId" = gs.id AND m."studentId" = r."studentId"
                      AND m."deletedAt" IS NULL AND m.status IN ('PRESENT', 'LATE')))) AS absent,
                 (r.status = 'LATE') AS late
          FROM "AttendanceRecord" r
          JOIN "AttendanceSession" sh ON sh.id = r."sessionId" AND sh."deletedAt" IS NULL
          LEFT JOIN "GroupSession" gs ON gs.id = sh."groupSessionId"
          JOIN "AcademyStudent" s ON s."academyId" = r."academyId" AND s."studentId" = r."studentId"
          WHERE r."academyId" = ${academyId} AND sh."academyId" = ${academyId}
            AND r."deletedAt" IS NULL AND r."homeGroupId" IS NULL AND r.status <> 'EXCUSED'
            AND sh.date >= ${since}::date AND (gs.id IS NULL OR gs.status <> 'CANCELLED')
            AND s.status = 'ACTIVE' ${one}
        ), ranked AS (
          SELECT "academyStudentId", "groupId", shid, date, absent, late,
                 ROW_NUMBER() OVER (PARTITION BY "academyStudentId", "groupId" ORDER BY at DESC, shid DESC) AS rn
          FROM recs
        ), agg AS (
          -- A streak is the run of matching records from the newest back; its
          -- start is the record at position "run" — read from one ordered
          -- array, not by joining back (measured: the join-back cost ~0.4 s at
          -- 10k learners). Only the newest MAX_RUN records per group matter
          -- (thresholds are at most 10), so a run is exact up to MAX_RUN.
          SELECT "academyStudentId", "groupId",
                 (COALESCE(MIN(rn) FILTER (WHERE NOT absent), MAX(rn) + 1) - 1)::int AS "absentRun",
                 (COALESCE(MIN(rn) FILTER (WHERE NOT late), MAX(rn) + 1) - 1)::int AS "lateRun",
                 array_agg(shid ORDER BY rn) AS shids,
                 array_agg(date::text ORDER BY rn) AS dates
          FROM ranked WHERE rn <= ${MAX_RUN} GROUP BY 1, 2
        )
        SELECT a."academyStudentId", a."groupId", g.name AS "groupName", a."absentRun", a."lateRun",
               a.shids[a."absentRun"] AS "absentStart", a.dates[a."absentRun"] AS "absentSince",
               a.shids[a."lateRun"] AS "lateStart", a.dates[a."lateRun"] AS "lateSince"
        FROM agg a
        JOIN "Group" g ON g.id = a."groupId"
        WHERE a."absentRun" >= ${cfg.absenceStreak} OR a."lateRun" >= ${cfg.lateStreak}`,
      this.prisma.$queryRaw<
        { academyStudentId: string; shid: string; groupId: string; groupName: string }[]
      >`
        SELECT s.id AS "academyStudentId", sh.id AS shid, sh."groupId", g.name AS "groupName"
        FROM "AttendanceRecord" r
        JOIN "AttendanceSession" sh ON sh.id = r."sessionId" AND sh."deletedAt" IS NULL
        JOIN "Group" g ON g.id = sh."groupId"
        LEFT JOIN "GroupSession" gs ON gs.id = sh."groupSessionId"
        JOIN "AcademyStudent" s ON s."academyId" = r."academyId" AND s."studentId" = r."studentId"
        WHERE r."academyId" = ${academyId} AND sh."academyId" = ${academyId}
          AND r."deletedAt" IS NULL AND r."homeGroupId" IS NULL AND r.status = 'ABSENT'
          AND sh.date = ${today}::date AND (gs.id IS NULL OR gs.status <> 'CANCELLED')
          AND s.status = 'ACTIVE' ${one}
          AND NOT (gs.id IS NOT NULL AND EXISTS (
            SELECT 1 FROM "AttendanceRecord" m
            WHERE m."makeupForSessionId" = gs.id AND m."studentId" = r."studentId"
              AND m."deletedAt" IS NULL AND m.status IN ('PRESENT', 'LATE')))`,
      feesOn
        ? this.fees.overdueLearners(academyId, addDays(today, -cfg.overdueDays))
        : Promise.resolve([]),
    ]);

    const out: Signal[] = [];
    for (const r of absentToday)
      out.push({
        academyStudentId: r.academyStudentId,
        reason: 'ABSENT_TODAY',
        signalKey: r.shid,
        groupId: r.groupId,
        groupName: r.groupName,
        count: 1,
        since: today,
      });
    for (const r of streaks) {
      if (r.absentRun >= cfg.absenceStreak && r.absentStart)
        out.push({
          academyStudentId: r.academyStudentId,
          reason: 'ABSENT_STREAK',
          signalKey: `${r.groupId}:${r.absentStart}`,
          groupId: r.groupId,
          groupName: r.groupName,
          count: r.absentRun,
          since: r.absentSince!,
        });
      if (r.lateRun >= cfg.lateStreak && r.lateStart)
        out.push({
          academyStudentId: r.academyStudentId,
          reason: 'LATE_STREAK',
          signalKey: `${r.groupId}:${r.lateStart}`,
          groupId: r.groupId,
          groupName: r.groupName,
          count: r.lateRun,
          since: r.lateSince!,
        });
    }
    const active = overdue.length
      ? new Set(
          (
            await this.prisma.academyStudent.findMany({
              where: {
                academyId,
                status: 'ACTIVE',
                id: { in: overdue.map((o) => o.academyStudentId) },
              },
              select: { id: true },
            })
          ).map((s) => s.id),
        )
      : new Set<string>();
    for (const o of overdue) {
      if (!active.has(o.academyStudentId)) continue;
      if (opts.academyStudentId && o.academyStudentId !== opts.academyStudentId) continue;
      out.push({
        academyStudentId: o.academyStudentId,
        reason: 'FEES_OVERDUE',
        signalKey: o.oldestChargeId,
        groupId: null,
        groupName: null,
        count: daysBetween(o.oldestDueOn, today),
        since: o.oldestDueOn,
        ...(opts.withAmounts ? { overdueCents: o.overdueCents } : {}),
      });
    }
    return { today, timezone: clock.timezone, settings: cfg, signals: out };
  }

  /**
   * Today's list: every signal with its learner, whether a case is open for
   * it, and whether anyone has contacted the family today. Paged on the
   * server; amounts only for fees.view.
   */
  async today(
    ctx: AcademyContext,
    q: { reason?: SignalReason; notContacted?: boolean; page?: number },
  ) {
    const withAmounts = ctx.can('fees.view');
    const { today, timezone, settings, signals } = await this.compute(ctx.academyId, {
      withAmounts,
    });
    const ids = [...new Set(signals.map((s) => s.academyStudentId))];
    const { start } = localDayBounds(today, timezone);
    const [learners, open, contacted] = ids.length
      ? await Promise.all([
          this.prisma.academyStudent.findMany({
            where: { academyId: ctx.academyId, id: { in: ids } },
            select: { id: true, fullName: true, code: true },
          }),
          this.prisma.studentFollowUp.findMany({
            where: { academyId: ctx.academyId, status: 'OPEN', academyStudentId: { in: ids } },
            select: {
              id: true,
              academyStudentId: true,
              reason: true,
              signalKey: true,
              assignedToUserId: true,
            },
          }),
          this.prisma.studentContact.groupBy({
            by: ['academyStudentId'],
            where: {
              academyId: ctx.academyId,
              academyStudentId: { in: ids },
              contactedAt: { gte: start },
            },
            _count: true,
            _max: { contactedAt: true },
          }),
        ])
      : [[], [], []];
    const who = new Map(learners.map((l) => [l.id, l]));
    const keyOf = (a: string, r: string, k: string | null) => `${a}|${r}|${k}`;
    const openBy = new Map(open.map((c) => [keyOf(c.academyStudentId, c.reason, c.signalKey), c]));
    const caseOf = (s: Signal) =>
      openBy.get(keyOf(s.academyStudentId, s.reason, s.signalKey)) ?? null;
    const touched = new Map(contacted.map((c) => [c.academyStudentId, c._max.contactedAt]));
    const totals = { ABSENT_TODAY: 0, ABSENT_STREAK: 0, LATE_STREAK: 0, FEES_OVERDUE: 0 };
    for (const s of signals) totals[s.reason]++;
    const ORDER: SignalReason[] = ['ABSENT_TODAY', 'ABSENT_STREAK', 'LATE_STREAK', 'FEES_OVERDUE'];
    const rows = signals
      .filter((s) => !q.reason || s.reason === q.reason)
      .filter((s) => !q.notContacted || !touched.has(s.academyStudentId))
      .map((s) => ({
        ...s,
        student: who.get(s.academyStudentId) ?? null,
        openCase: caseOf(s),
        contactedToday: touched.has(s.academyStudentId),
        lastContactAt: touched.get(s.academyStudentId)?.toISOString() ?? null,
      }))
      .sort(
        (a, b) =>
          ORDER.indexOf(a.reason) - ORDER.indexOf(b.reason) ||
          b.count - a.count ||
          (a.student?.fullName ?? '').localeCompare(b.student?.fullName ?? '', 'ar'),
      );
    const page = q.page ?? 1;
    return {
      today,
      timezone,
      settings,
      totals,
      total: rows.length,
      page,
      pageSize: PAGE,
      items: rows.slice((page - 1) * PAGE, page * PAGE),
    };
  }
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
