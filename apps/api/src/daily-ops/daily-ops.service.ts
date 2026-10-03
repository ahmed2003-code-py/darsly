import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AcademyContext } from '../academy/academy-context';
import { AuditService } from '../audit/audit.service';
import { CenterFeesService } from '../center-fees/center-fees.service';
import { ClassScheduleService } from '../class-ops/class-schedule.service';
import { localDayBounds } from '../class-ops/zoned-time';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { PrismaService } from '../prisma/prisma.service';
import { CloseDayDto } from './dto';

type Db = Prisma.TransactionClient | PrismaService;

/** One class of the day, as the report sees it. */
export interface DayClass {
  id: string;
  groupId: string;
  groupName: string;
  startAt: string;
  endAt: string;
  status: 'SCHEDULED' | 'COMPLETED' | 'CANCELLED';
  attendanceClosed: boolean;
  expected: number;
  present: number;
  late: number;
  absent: number;
  excused: number;
  makeup: number;
  checkIns: number;
}

/**
 * Everything the day's figures are made of. Facts (what happened on the day)
 * are reproducible from timestamps that never change once set; `state`
 * fields (open cases, drafts due) are as of when they were computed and are
 * left out of the drift comparison.
 */
export interface DayFigures {
  classes: {
    total: number;
    scheduled: number;
    completed: number;
    cancelled: number;
    ended: number;
    upcoming: number;
  };
  attendance: {
    expected: number;
    present: number;
    late: number;
    absent: number;
    excused: number;
    makeup: number;
    unmarked: number;
    closedClasses: number;
    openClasses: number;
  };
  desk: { checkIns: number; byCard: number; byCode: number } | null;
  collections: {
    currency: string;
    received: {
      count: number;
      amountCents: number;
      byMethod: Record<string, { count: number; amountCents: number }>;
    };
    reversedToday: { count: number; amountCents: number };
    netCents: number;
  } | null;
  followUp: {
    opened: number;
    resolved: number;
    dismissed: number;
    contacts: number;
    state: { openCases: number };
  } | null;
  exams: { published: number; corrections: number; state: { draftsDue: number } } | null;
}

export interface DayException {
  code: 'ATTENDANCE_NOT_CLOSED' | 'CLASS_NOT_ENDED';
  sessionId: string;
  groupName: string;
  startAt: string;
  unmarked: number;
}

/** Sections whose facts are compared for drift (never `state`). */
const FACT_SECTIONS = [
  'classes',
  'attendance',
  'desk',
  'collections',
  'followUp',
  'exams',
] as const;

/**
 * Center Operations C7 — the day's operations and its close.
 *
 * Reads only: C2 classes and attendance, C3 check-ins (records with a QR/CODE
 * method), C4 collections and reversals (through CenterFeesService), C5
 * cases and contacts, C6 publications and corrections. Writes only
 * CenterDayClose (daily-ops.boundary.spec.ts). Nothing here gates attendance,
 * money or anything else: an open day blocks nobody.
 *
 * The business date is the academy-local date (its configured timezone);
 * "now" is the database clock.
 */
@Injectable()
export class DailyOpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly schedule: ClassScheduleService,
    private readonly flags: FeatureFlagsService,
    private readonly audit: AuditService,
    private readonly fees: CenterFeesService,
  ) {}

  async clock(academyId: string) {
    return this.schedule.academyClock(academyId);
  }

  /** The full, unredacted figures of one business day, as of the database's now. */
  async compute(academyId: string, date: string, db: Db = this.prisma) {
    const clock = await this.schedule.academyClock(academyId);
    const { start, end } = localDayBounds(date, clock.timezone);
    const s = start.toISOString();
    const e = end.toISOString();
    const [{ now }] = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    const [desk, fees, followUp, exams] = await Promise.all([
      this.flags.isEnabled(academyId, 'receptionDesk'),
      this.flags.isEnabled(academyId, 'centerFees'),
      this.flags.isEnabled(academyId, 'studentFollowUp'),
      this.flags.isEnabled(academyId, 'paperExams'),
    ]);

    // Classes and attendance: one aggregate over the day's classes.
    const rows = await db.$queryRaw<
      {
        id: string;
        groupId: string;
        groupName: string;
        startAt: Date;
        endAt: Date;
        status: DayClass['status'];
        closed: boolean;
        expected: number;
        present: number;
        late: number;
        absent: number;
        excused: number;
        makeup: number;
        checkIns: number;
        byCard: number;
        byCode: number;
      }[]
    >`
      SELECT gs.id, gs."groupId", g.name AS "groupName", gs."startAt", gs."endAt", gs.status::text AS status,
        bool_or(sh."closedAt" IS NOT NULL) IS TRUE AS closed,
        (SELECT count(DISTINCT m."studentId")::int
           FROM "GroupMembership" m
           LEFT JOIN "AcademyStudent" a ON a."academyId" = m."academyId" AND a."studentId" = m."studentId"
          WHERE m."groupId" = gs."groupId" AND m."addedAt" < gs."endAt"
            AND (m."deletedAt" IS NULL OR m."deletedAt" > gs."startAt")
            AND (a.id IS NULL OR a.status <> 'WITHDRAWN' OR a."leftAt" > gs."startAt")) AS expected,
        count(r.id) FILTER (WHERE r.status = 'PRESENT')::int AS present,
        count(r.id) FILTER (WHERE r.status = 'LATE')::int AS late,
        count(r.id) FILTER (WHERE r.status = 'ABSENT')::int AS absent,
        count(r.id) FILTER (WHERE r.status = 'EXCUSED')::int AS excused,
        count(r.id) FILTER (WHERE r."homeGroupId" IS NOT NULL)::int AS makeup,
        count(r.id) FILTER (WHERE r.method IN ('QR', 'CODE'))::int AS "checkIns",
        count(r.id) FILTER (WHERE r.method = 'QR')::int AS "byCard",
        count(r.id) FILTER (WHERE r.method = 'CODE')::int AS "byCode"
      FROM "GroupSession" gs
      JOIN "Group" g ON g.id = gs."groupId" AND g."deletedAt" IS NULL
      LEFT JOIN "AttendanceSession" sh ON sh."groupSessionId" = gs.id AND sh."deletedAt" IS NULL
      LEFT JOIN "AttendanceRecord" r ON r."sessionId" = sh.id AND r."deletedAt" IS NULL
      WHERE gs."academyId" = ${academyId} AND gs."deletedAt" IS NULL AND gs.mode::text <> 'ONLINE'
        AND gs."startAt" >= (${s}::timestamptz AT TIME ZONE 'UTC') AND gs."startAt" < (${e}::timestamptz AT TIME ZONE 'UTC')
      GROUP BY gs.id, g.name
      ORDER BY gs."startAt", gs.id`;

    const classes: DayClass[] = rows.map((r) => ({
      id: r.id,
      groupId: r.groupId,
      groupName: r.groupName,
      startAt: r.startAt.toISOString(),
      endAt: r.endAt.toISOString(),
      status: r.status,
      attendanceClosed: r.closed,
      expected: r.expected,
      present: r.present,
      late: r.late,
      absent: r.absent,
      excused: r.excused,
      makeup: r.makeup,
      checkIns: r.checkIns,
    }));
    const live = rows.filter((r) => r.status !== 'CANCELLED');
    const marked = (r: (typeof rows)[number]) =>
      r.present + r.late + r.absent + r.excused - r.makeup;
    const sum = (f: (r: (typeof rows)[number]) => number) => live.reduce((n, r) => n + f(r), 0);
    const ended = live.filter((r) => r.endAt <= now);

    const figures: DayFigures = {
      classes: {
        total: rows.length,
        scheduled: rows.filter((r) => r.status === 'SCHEDULED').length,
        completed: rows.filter((r) => r.status === 'COMPLETED').length,
        cancelled: rows.filter((r) => r.status === 'CANCELLED').length,
        ended: ended.length,
        upcoming: live.length - ended.length,
      },
      attendance: {
        expected: sum((r) => r.expected),
        present: sum((r) => r.present),
        late: sum((r) => r.late),
        absent: sum((r) => r.absent),
        excused: sum((r) => r.excused),
        makeup: sum((r) => r.makeup),
        unmarked: ended.reduce((n, r) => n + Math.max(0, r.expected - marked(r)), 0),
        closedClasses: live.filter((r) => r.closed).length,
        openClasses: live.filter((r) => !r.closed).length,
      },
      desk: desk
        ? {
            checkIns: sum((r) => r.checkIns),
            byCard: sum((r) => r.byCard),
            byCode: sum((r) => r.byCode),
          }
        : null,
      collections: null,
      followUp: null,
      exams: null,
    };

    // Money only through C4's own service: nothing outside center-fees reads its tables.
    if (fees) figures.collections = await this.fees.dayMovement(academyId, date, db);

    if (followUp) {
      const [f] = await db.$queryRaw<
        { opened: number; resolved: number; dismissed: number; open: number; contacts: number }[]
      >`
        SELECT
          (SELECT count(*)::int FROM "StudentFollowUp" WHERE "academyId" = ${academyId}
             AND "openedAt" >= (${s}::timestamptz AT TIME ZONE 'UTC') AND "openedAt" < (${e}::timestamptz AT TIME ZONE 'UTC')) AS opened,
          (SELECT count(*)::int FROM "StudentFollowUp" WHERE "academyId" = ${academyId} AND status = 'RESOLVED'
             AND "closedAt" >= (${s}::timestamptz AT TIME ZONE 'UTC') AND "closedAt" < (${e}::timestamptz AT TIME ZONE 'UTC')) AS resolved,
          (SELECT count(*)::int FROM "StudentFollowUp" WHERE "academyId" = ${academyId} AND status = 'DISMISSED'
             AND "closedAt" >= (${s}::timestamptz AT TIME ZONE 'UTC') AND "closedAt" < (${e}::timestamptz AT TIME ZONE 'UTC')) AS dismissed,
          (SELECT count(*)::int FROM "StudentFollowUp" WHERE "academyId" = ${academyId} AND status = 'OPEN') AS open,
          (SELECT count(*)::int FROM "StudentContact" WHERE "academyId" = ${academyId}
             AND "contactedAt" >= (${s}::timestamptz AT TIME ZONE 'UTC') AND "contactedAt" < (${e}::timestamptz AT TIME ZONE 'UTC')) AS contacts`;
      figures.followUp = {
        opened: f.opened,
        resolved: f.resolved,
        dismissed: f.dismissed,
        contacts: f.contacts,
        state: { openCases: f.open },
      };
    }

    if (exams) {
      const [x] = await db.$queryRaw<{ published: number; corrections: number; drafts: number }[]>`
        SELECT
          (SELECT count(*)::int FROM "PaperExam" WHERE "academyId" = ${academyId}
             AND "publishedAt" >= (${s}::timestamptz AT TIME ZONE 'UTC') AND "publishedAt" < (${e}::timestamptz AT TIME ZONE 'UTC')) AS published,
          (SELECT count(*)::int FROM "PaperExamRevision" v JOIN "PaperExam" pe ON pe.id = v."examId"
            WHERE pe."academyId" = ${academyId} AND v.kind = 'CORRECTION'
              AND v.at >= (${s}::timestamptz AT TIME ZONE 'UTC') AND v.at < (${e}::timestamptz AT TIME ZONE 'UTC')) AS corrections,
          (SELECT count(*)::int FROM "PaperExam" WHERE "academyId" = ${academyId} AND status = 'DRAFT'
             AND "examDate" <= ${date}::date) AS drafts`;
      figures.exams = {
        published: x.published,
        corrections: x.corrections,
        state: { draftsDue: x.drafts },
      };
    }

    // What stands between this day and a clean close.
    const exceptions: DayException[] = [];
    for (const r of live) {
      if (r.endAt > now)
        exceptions.push({
          code: 'CLASS_NOT_ENDED',
          sessionId: r.id,
          groupName: r.groupName,
          startAt: r.startAt.toISOString(),
          unmarked: 0,
        });
      else if (!r.closed)
        exceptions.push({
          code: 'ATTENDANCE_NOT_CLOSED',
          sessionId: r.id,
          groupName: r.groupName,
          startAt: r.startAt.toISOString(),
          unmarked: Math.max(0, r.expected - marked(r)),
        });
    }
    return {
      date,
      timezone: clock.timezone,
      today: clock.today,
      computedAt: now.toISOString(),
      figures,
      classes,
      exceptions,
    };
  }

  /** What this caller may see of a set of figures. */
  redact(ctx: AcademyContext, f: DayFigures): DayFigures {
    return {
      ...f,
      collections: ctx.can('fees.report') ? f.collections : null,
      followUp: ctx.can('followup.view') ? f.followUp : null,
      // Grades are group-scoped: only someone who reaches every group sees academy totals.
      exams:
        ctx.can('grades.view') && (ctx.role === 'OWNER' || ctx.isPlatformAdmin) ? f.exams : null,
    };
  }

  /** Sections whose facts differ between the latest close and now. */
  drift(closed: DayFigures, live: DayFigures): string[] {
    // Canonical form: JSONB stores object keys in its own order, so compare
    // with keys sorted, never by raw JSON text.
    const canon = (x: unknown): string =>
      Array.isArray(x)
        ? `[${x.map(canon).join(',')}]`
        : x && typeof x === 'object'
          ? `{${Object.keys(x)
              .sort()
              .map((k) => `${JSON.stringify(k)}:${canon((x as Record<string, unknown>)[k])}`)
              .join(',')}}`
          : JSON.stringify(x ?? null);
    const facts = (x: unknown) => {
      if (!x || typeof x !== 'object') return canon(x);
      const { state: _state, ...rest } = x as Record<string, unknown>;
      return canon(rest);
    };
    return FACT_SECTIONS.filter((k) => facts(closed[k]) !== facts(live[k]));
  }

  async day(ctx: AcademyContext, date?: string) {
    const clock = await this.schedule.academyClock(ctx.academyId);
    const d = date ?? clock.today;
    const live = await this.compute(ctx.academyId, d);
    const closes = await this.prisma.centerDayClose.findMany({
      where: { academyId: ctx.academyId, businessDate: new Date(`${d}T00:00:00Z`) },
      orderBy: { version: 'asc' },
    });
    const names = await this.names(closes.map((c) => c.closedBy));
    const latest = closes.at(-1) ?? null;
    return {
      date: d,
      today: live.today,
      timezone: live.timezone,
      computedAt: live.computedAt,
      figures: this.redact(ctx, live.figures),
      classes: live.classes,
      exceptions: live.exceptions,
      closes: closes.map((c) => ({
        version: c.version,
        closedAt: c.closedAt.toISOString(),
        closedBy: names.get(c.closedBy) ?? '',
        exceptions: (c.exceptions as unknown as DayException[]).length,
        exceptionNote: c.exceptionNote,
        reason: c.reason,
      })),
      latest: latest
        ? {
            version: latest.version,
            figures: this.redact(ctx, latest.figures as unknown as DayFigures),
            exceptions: latest.exceptions as unknown as DayException[],
            drift: this.drift(latest.figures as unknown as DayFigures, live.figures),
          }
        : null,
    };
  }

  /**
   * Close (or close again) a business day. Under a lock on (academy, date):
   * recompute from the sources, refuse a day in the future, require a note
   * when there are exceptions and a reason when the day was closed before,
   * then append version N+1. A retry with the same request key is answered
   * with the close it made.
   */
  async close(ctx: AcademyContext, dto: CloseDayDto) {
    const clock = await this.schedule.academyClock(ctx.academyId);
    if (dto.date > clock.today)
      throw new BadRequestException({
        message: 'That day has not happened yet',
        code: 'DAY_IN_FUTURE',
        field: 'date',
      });
    const prior = await this.prisma.centerDayClose.findUnique({
      where: { academyId_requestKey: { academyId: ctx.academyId, requestKey: dto.requestKey } },
    });
    if (prior) return this.replay(prior, dto.date);
    let made;
    try {
      made = await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ctx.academyId}), hashtext(${dto.date}))`;
          const again = await tx.centerDayClose.findUnique({
            where: {
              academyId_requestKey: { academyId: ctx.academyId, requestKey: dto.requestKey },
            },
          });
          if (again) return { replay: again };
          const last = await tx.centerDayClose.findFirst({
            where: { academyId: ctx.academyId, businessDate: new Date(`${dto.date}T00:00:00Z`) },
            orderBy: { version: 'desc' },
            select: { version: true },
          });
          if (last && !dto.reason?.trim())
            throw new ConflictException({
              message: 'This day is already closed — give a reason to close it again',
              code: 'DAY_ALREADY_CLOSED',
              version: last.version,
            });
          const report = await this.compute(ctx.academyId, dto.date, tx);
          if (report.exceptions.length && !dto.exceptionNote?.trim())
            throw new ConflictException({
              message: 'The day has open items — add a note to close with them',
              code: 'DAY_HAS_EXCEPTIONS',
              exceptions: report.exceptions,
            });
          const row = await tx.centerDayClose.create({
            data: {
              academyId: ctx.academyId,
              businessDate: new Date(`${dto.date}T00:00:00Z`),
              version: (last?.version ?? 0) + 1,
              timezone: report.timezone,
              figures: report.figures as unknown as Prisma.InputJsonValue,
              exceptions: report.exceptions as unknown as Prisma.InputJsonValue,
              exceptionNote: report.exceptions.length ? dto.exceptionNote!.trim() : null,
              reason: last ? dto.reason!.trim() : null,
              requestKey: dto.requestKey,
              closedBy: ctx.userId,
            },
          });
          return { row };
        },
        { timeout: 20_000 },
      );
    } catch (e) {
      // A concurrent close with the same key won the race: answer with it.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const won = await this.prisma.centerDayClose.findUnique({
          where: { academyId_requestKey: { academyId: ctx.academyId, requestKey: dto.requestKey } },
        });
        if (won) return this.replay(won, dto.date);
      }
      throw e;
    }
    if ('replay' in made) return this.replay(made.replay!, dto.date);
    const row = made.row;
    // Ids and counts only — never the note or the reason text.
    await this.audit.log({
      actorUserId: ctx.userId,
      action: 'day.close',
      entity: 'CenterDayClose',
      entityId: row.id,
      academyId: ctx.academyId,
      meta: {
        date: dto.date,
        version: row.version,
        exceptions: (row.exceptions as unknown[]).length,
      },
    });
    return { created: true, version: row.version, closedAt: row.closedAt.toISOString() };
  }

  private replay(row: { businessDate: Date; version: number; closedAt: Date }, date: string) {
    if (row.businessDate.toISOString().slice(0, 10) !== date)
      throw new ConflictException({
        message: 'This request key was already used for another day',
        code: 'DAY_CLOSE_KEY_REUSED',
      });
    return { created: false, version: row.version, closedAt: row.closedAt.toISOString() };
  }

  private async names(ids: string[]) {
    const users = ids.length
      ? await this.prisma.user.findMany({
          where: { id: { in: [...new Set(ids)] } },
          select: { id: true, fullName: true },
        })
      : [];
    return new Map(users.map((u) => [u.id, u.fullName ?? '']));
  }
}
