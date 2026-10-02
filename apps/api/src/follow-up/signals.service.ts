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
    const oneProfile = opts.academyStudentId
      ? Prisma.sql`AND r."studentId" = (SELECT "studentId" FROM "AcademyStudent" WHERE id = ${opts.academyStudentId} AND "academyId" = ${academyId})`
      : Prisma.empty;

    const [streaks, absentToday, overdue] = await Promise.all([
      // Its own transaction: SET LOCAL ends with it. Nested loops are off for
      // this one read because with stale statistics (a table that grew since
      // it was last analysed) the planner chose them over 160k rows and the
      // list took minutes (measured; see the scale test, which reproduces it).
      this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL enable_nestloop = off`;
        return tx.$queryRaw<
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
        WITH sess AS MATERIALIZED (
          -- The group's own classes in the window, newest first: rk 1 = newest.
          -- A few hundred rows however many learners there are.
          SELECT sh.id, sh."groupId", sh.date, gs.id AS gsid,
                 ROW_NUMBER() OVER (PARTITION BY sh."groupId"
                   ORDER BY COALESCE(gs."startAt", sh.date::timestamp) DESC, sh.id DESC)::int AS rk
          FROM "AttendanceSession" sh
          LEFT JOIN "GroupSession" gs ON gs.id = sh."groupSessionId"
          WHERE sh."academyId" = ${academyId} AND sh."deletedAt" IS NULL
            AND sh.date >= ${since}::date AND (gs.id IS NULL OR gs.status <> 'CANCELLED')
        ), recs AS MATERIALIZED (
          -- Each own-group record as (learner, group, the class's rank, absent?, late?).
          SELECT r."studentId", x."groupId", x.rk,
                 (r.status = 'ABSENT' AND NOT (x.gsid IS NOT NULL AND EXISTS (
                    SELECT 1 FROM "AttendanceRecord" m
                    WHERE m."makeupForSessionId" = x.gsid AND m."studentId" = r."studentId"
                      AND m."deletedAt" IS NULL AND m.status IN ('PRESENT', 'LATE')))) AS absent,
                 (r.status = 'LATE') AS late
          FROM "AttendanceRecord" r
          JOIN sess x ON x.id = r."sessionId"
          WHERE r."academyId" = ${academyId}
            AND r."deletedAt" IS NULL AND r."homeGroupId" IS NULL AND r.status <> 'EXCUSED' ${oneProfile}
        ), agg AS (
          -- A streak is every record newer than the newest one that breaks it.
          -- One aggregate pass per learner and group — no join between large
          -- sets, no global sort: the newest break, and the ranks of the
          -- absent / late records (a handful each) to count from.
          SELECT "studentId", "groupId",
                 MIN(rk) FILTER (WHERE NOT absent) AS ab,
                 MIN(rk) FILTER (WHERE NOT late) AS lb,
                 array_agg(rk) FILTER (WHERE absent) AS ar,
                 array_agg(rk) FILTER (WHERE late) AS lr
          FROM recs GROUP BY 1, 2
          HAVING bool_or(absent) OR bool_or(late)
        ), runs AS (
          SELECT "studentId", "groupId",
                 (SELECT COUNT(*) FROM unnest(ar) x WHERE x < COALESCE(ab, 2147483647))::int AS "absentRun",
                 (SELECT COUNT(*) FROM unnest(lr) x WHERE x < COALESCE(lb, 2147483647))::int AS "lateRun",
                 (SELECT MAX(x) FROM unnest(ar) x WHERE x < COALESCE(ab, 2147483647)) AS ak,
                 (SELECT MAX(x) FROM unnest(lr) x WHERE x < COALESCE(lb, 2147483647)) AS lk
          FROM agg
        )
        SELECT s.id AS "academyStudentId", u."groupId", g.name AS "groupName", u."absentRun", u."lateRun",
               sa.id AS "absentStart", sa.date::text AS "absentSince",
               sl.id AS "lateStart", sl.date::text AS "lateSince"
        FROM runs u
        JOIN "AcademyStudent" s ON s."academyId" = ${academyId} AND s."studentId" = u."studentId"
          AND s.status = 'ACTIVE'
        JOIN "Group" g ON g.id = u."groupId"
        LEFT JOIN sess sa ON sa."groupId" = u."groupId" AND sa.rk = u.ak
        LEFT JOIN sess sl ON sl."groupId" = u."groupId" AND sl.rk = u.lk
        WHERE u."absentRun" >= ${cfg.absenceStreak} OR u."lateRun" >= ${cfg.lateStreak}`;
      }),
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
