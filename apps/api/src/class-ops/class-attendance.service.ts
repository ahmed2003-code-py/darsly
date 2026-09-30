import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AttendanceStatus, GroupSession, Prisma } from '@prisma/client';
import { AcademyContext } from '../academy/academy-context';
import { AcademyOpsAccessService } from '../academy-ops/academy-ops-access.service';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { ClassScheduleService, HORIZON_DAYS } from './class-schedule.service';
import { MakeupDto, MarkDto } from './dto';
import { addDays, formatClock, localDayBounds, wallClock } from './zoned-time';

type Db = Prisma.TransactionClient | PrismaService;

/** A class's sheet opens this long before it starts (people arrive early). */
const OPENS_BEFORE_MIN = 60;
/** How far back a makeup search offers missed classes. */
const MISSED_LOOKBACK_DAYS = 21;
/** A student code: five digits and a Luhn digit (C1). */
const CODE_RE = /^\d{6}$/;

/**
 * Center Operations C2 — attendance for one real class (a GroupSession).
 *
 * WHO IS EXPECTED. A student is expected at a class when one of their
 * membership stints in the class's group overlaps the class window —
 * `addedAt < endAt AND (deletedAt IS NULL OR deletedAt > startAt)` — and
 * their register record was not withdrawn before the class began. Someone
 * added during the class is expected at it; someone who left before it began
 * is not. Reading an old class therefore shows who was in the group THEN,
 * never today's list.
 *
 * TIME. Every timestamp is the database's clock (`now()`), read once per
 * request, never the browser's. A first check-in (PRESENT with no earlier
 * record) after `startAt + grace` is stored as LATE. After that, a person's
 * choice is stored as they made it: correcting LATE back to PRESENT is a
 * correction, not a check-in.
 *
 * ONE LOCK. Everything that changes a class — start, mark, close, makeup,
 * and cancelling it (SessionsService) — takes `FOR UPDATE` on the class's
 * GroupSession row first. Two desks closing, a mark racing the close, a
 * makeup racing the last seat: they queue, and each sees the other's result.
 *
 * CLOSING writes ABSENT (method AUTO) for every expected student with no
 * record, once: the sheet's closedAt makes a second close a no-op. Records
 * stay editable after closing — changing an AUTO absence makes it MANUAL —
 * and every change is in the audit log.
 */
@Injectable()
export class ClassAttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AcademyOpsAccessService,
    private readonly audit: AuditService,
    private readonly schedule: ClassScheduleService,
  ) {}

  // ── Today / a group's classes ─────────────────────────────────────────

  /** The classes of one local day (default today), with their state and counts. */
  async day(ctx: AcademyContext, date?: string) {
    const clock = await this.schedule.academyClock(ctx.academyId);
    const day = date ?? clock.today;
    if (day >= clock.today && day <= addDays(clock.today, HORIZON_DAYS - 1))
      await this.schedule.ensureHorizon(ctx.academyId);
    const { start, end } = localDayBounds(day, clock.timezone);
    const scope = await this.groupScope(ctx);
    const sessions = await this.prisma.groupSession.findMany({
      where: {
        academyId: ctx.academyId,
        mode: { not: 'ONLINE' },
        startAt: { gte: start, lt: end },
        group: { deletedAt: null },
        ...(scope ? { groupId: { in: scope } } : {}),
      },
      orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
      include: SESSION_INCLUDE,
    });
    return {
      date: day,
      today: clock.today,
      timezone: clock.timezone,
      classes: await this.withCounts(sessions, clock.timezone),
    };
  }

  /** One group's classes in [from, to] (local dates), newest last. */
  async groupClasses(ctx: AcademyContext, groupId: string, from: string, to: string) {
    await this.access.assertGroupAccess(ctx, groupId);
    const clock = await this.schedule.academyClock(ctx.academyId);
    if (to < from || addDays(from, 92) < to)
      throw new BadRequestException({ message: 'Invalid range', code: 'INVALID_RANGE' });
    if (to >= clock.today) await this.schedule.ensureHorizon(ctx.academyId);
    const sessions = await this.prisma.groupSession.findMany({
      where: {
        academyId: ctx.academyId,
        groupId,
        mode: { not: 'ONLINE' },
        startAt: {
          gte: localDayBounds(from, clock.timezone).start,
          lt: localDayBounds(to, clock.timezone).end,
        },
      },
      orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
      include: SESSION_INCLUDE,
    });
    return {
      timezone: clock.timezone,
      today: clock.today,
      classes: await this.withCounts(sessions, clock.timezone),
    };
  }

  // ── One class ─────────────────────────────────────────────────────────

  /** The class, its expected roster merged with its records, and what may be done now. */
  async roster(ctx: AcademyContext, sessionId: string) {
    const session = await this.load(ctx, sessionId);
    return this.rosterOf(ctx, session);
  }

  async start(ctx: AcademyContext, sessionId: string) {
    await this.load(ctx, sessionId);
    const started = await this.prisma.$transaction(async (tx) => {
      const s = await this.lock(tx, sessionId);
      const now = await this.now(tx);
      this.assertOpen(s, now);
      if (s.startedAt) return false;
      await tx.groupSession.update({
        where: { id: sessionId },
        data: { startedAt: now, startedBy: ctx.userId },
      });
      return true;
    });
    if (started)
      await this.audit.log({
        actorUserId: ctx.userId,
        action: 'session.start',
        entity: 'GroupSession',
        entityId: sessionId,
        academyId: ctx.academyId,
      });
    return this.roster(ctx, sessionId);
  }

  async mark(ctx: AcademyContext, sessionId: string, dto: MarkDto) {
    const session = await this.load(ctx, sessionId);
    const grace = await this.graceFor(session);
    const unique = new Map(dto.records.map((r) => [r.studentId, r.status]));
    const outcome = await this.prisma.$transaction(async (tx) => {
      const s = await this.lock(tx, sessionId);
      const now = await this.now(tx);
      this.assertOpen(s, now);
      const sheet = await this.sheet(tx, s, ctx);
      const expected = await this.expected(tx, s);
      const records = await tx.attendanceRecord.findMany({
        where: { sessionId: sheet.id, studentId: { in: [...unique.keys()] } },
      });
      const prior = new Map(records.map((r) => [r.studentId, r]));
      const strangers = [...unique.keys()].filter((id) => !expected.has(id) && !prior.has(id));
      if (strangers.length)
        throw new BadRequestException({
          message: 'Some students are not expected at this class',
          code: 'STUDENT_NOT_EXPECTED',
          invalid: strangers,
        });
      const lateAfter = s.startAt.getTime() + grace * 60_000;
      // Marking while the class is on is a check-in at the door, and the
      // clock can judge it. Marking after it ended is writing down what
      // happened — the clock knows nothing about when anyone arrived then.
      const live = now.getTime() > lateAfter && now.getTime() < s.endAt.getTime();
      let checkIns = 0;
      let corrections = 0;
      let late = 0;
      for (const [studentId, asked] of unique) {
        const before = prior.get(studentId);
        // A first check-in (no record, or only the close's automatic absence)
        // is timed by the server; everything after it is a person's decision
        // and is stored as made.
        const firstCheckIn = !before || (before.method === 'AUTO' && !before.checkedInAt);
        const status: AttendanceStatus =
          firstCheckIn && asked === 'PRESENT' && live ? 'LATE' : asked;
        if (before && before.status === status && before.method === 'MANUAL') continue;
        const attended = status === 'PRESENT' || status === 'LATE';
        const checkedInAt = before?.checkedInAt ?? (attended ? now : null);
        if (!before) checkIns++;
        else corrections++;
        if (firstCheckIn && status === 'LATE' && asked === 'PRESENT') late++;
        await tx.attendanceRecord.upsert({
          where: { sessionId_studentId: { sessionId: sheet.id, studentId } },
          create: {
            sessionId: sheet.id,
            studentId,
            status,
            academyId: ctx.academyId,
            markedBy: ctx.userId,
            markedAt: now,
            method: 'MANUAL',
            checkedInAt,
          },
          update: { status, markedBy: ctx.userId, markedAt: now, method: 'MANUAL', checkedInAt },
        });
      }
      return { sheetId: sheet.id, closed: !!sheet.closedAt, checkIns, corrections, late };
    });
    if (outcome.checkIns || outcome.corrections)
      await this.audit.log({
        actorUserId: ctx.userId,
        action: 'attendance.mark',
        entity: 'AttendanceSession',
        entityId: outcome.sheetId,
        academyId: ctx.academyId,
        meta: {
          sessionId,
          groupId: session.groupId,
          checkIns: outcome.checkIns,
          corrections: outcome.corrections,
          autoLate: outcome.late,
          afterClose: outcome.closed,
          // Who changed to what — ids and statuses only.
          changes: [...unique].map(([studentId, status]) => ({ studentId, status })),
        },
      });
    return this.roster(ctx, sessionId);
  }

  async close(ctx: AcademyContext, sessionId: string) {
    const session = await this.load(ctx, sessionId);
    const outcome = await this.prisma.$transaction(async (tx) => {
      const s = await this.lock(tx, sessionId);
      const now = await this.now(tx);
      this.assertOpen(s, now);
      if (now < s.startAt)
        throw new ConflictException({
          message: 'This class has not started yet',
          code: 'ATTENDANCE_NOT_OPEN',
        });
      const sheet = await this.sheet(tx, s, ctx);
      if (sheet.closedAt) return { sheetId: sheet.id, autoAbsent: 0, already: true };
      const expected = await this.expected(tx, s);
      const marked = new Set(
        (
          await tx.attendanceRecord.findMany({
            where: { sessionId: sheet.id },
            select: { studentId: true },
          })
        ).map((r) => r.studentId),
      );
      const missing = [...expected].filter((id) => !marked.has(id));
      if (missing.length)
        await tx.attendanceRecord.createMany({
          data: missing.map((studentId) => ({
            sessionId: sheet.id,
            studentId,
            status: 'ABSENT' as const,
            method: 'AUTO' as const,
            academyId: ctx.academyId,
            markedBy: ctx.userId,
            markedAt: now,
          })),
          skipDuplicates: true,
        });
      await tx.attendanceSession.update({
        where: { id: sheet.id },
        data: { closedAt: now, closedBy: ctx.userId },
      });
      if (s.status === 'SCHEDULED')
        await tx.groupSession.update({ where: { id: s.id }, data: { status: 'COMPLETED' } });
      return { sheetId: sheet.id, autoAbsent: missing.length, already: false };
    });
    if (!outcome.already)
      await this.audit.log({
        actorUserId: ctx.userId,
        action: 'attendance.close',
        entity: 'AttendanceSession',
        entityId: outcome.sheetId,
        academyId: ctx.academyId,
        meta: { sessionId, groupId: session.groupId, autoAbsent: outcome.autoAbsent },
      });
    return this.roster(ctx, sessionId);
  }

  /**
   * A student of another group attending this class to make up one of their
   * own. They stay a member of their own group — nothing about their
   * membership changes — and the record lives on the class they actually sat
   * in, carrying their home group and (if given) the class it makes up for.
   * The home class's own record is left exactly as it is.
   */
  async makeup(ctx: AcademyContext, sessionId: string, dto: MakeupDto) {
    const session = await this.load(ctx, sessionId);
    const grace = await this.graceFor(session);
    const outcome = await this.prisma.$transaction(async (tx) => {
      const s = await this.lock(tx, sessionId);
      const now = await this.now(tx);
      this.assertOpen(s, now);
      const record = await tx.academyStudent.findUnique({
        where: { academyId_studentId: { academyId: ctx.academyId, studentId: dto.studentId } },
        select: { status: true },
      });
      if (!record)
        throw new NotFoundException({ message: 'Student not found', code: 'STUDENT_NOT_FOUND' });
      if (record.status !== 'ACTIVE')
        throw new ConflictException({
          message: 'This student has withdrawn; reactivate them first',
          code: 'STUDENT_WITHDRAWN',
        });
      const expected = await this.expected(tx, s);
      if (expected.has(dto.studentId))
        throw new ConflictException({
          message: 'This student belongs to this class — mark them in the list',
          code: 'MAKEUP_NOT_ALLOWED',
          reason: 'OWN_CLASS',
        });
      const sheet = await this.sheet(tx, s, ctx);
      const existing = await tx.attendanceRecord.findUnique({
        where: { sessionId_studentId: { sessionId: sheet.id, studentId: dto.studentId } },
      });
      if (existing) {
        if (existing.homeGroupId) return { sheetId: sheet.id, created: false };
        throw new ConflictException({ message: 'Already marked', code: 'ALREADY_MARKED' });
      }

      // Where they come from: the class they missed, or their one group.
      let homeGroupId: string;
      let makeupForSessionId: string | null = null;
      if (dto.makeupForSessionId) {
        const missed = await tx.groupSession.findFirst({
          where: { id: dto.makeupForSessionId, academyId: ctx.academyId },
        });
        if (!missed || missed.id === s.id)
          throw new NotFoundException({ message: 'Class not found', code: 'SESSION_NOT_FOUND' });
        if (!(await this.expected(tx, missed)).has(dto.studentId))
          throw new ConflictException({
            message: 'That class was not theirs',
            code: 'MAKEUP_NOT_ALLOWED',
            reason: 'NOT_THEIR_CLASS',
          });
        homeGroupId = missed.groupId;
        makeupForSessionId = missed.id;
      } else {
        const stints = await tx.groupMembership.findMany({
          where: { academyId: ctx.academyId, studentId: dto.studentId, deletedAt: null },
          select: { groupId: true },
        });
        const own = stints.map((m) => m.groupId).filter((g) => g !== s.groupId);
        if (dto.homeGroupId) {
          if (!own.includes(dto.homeGroupId))
            throw new ConflictException({
              message: 'That is not one of their groups',
              code: 'MAKEUP_NOT_ALLOWED',
              reason: 'NOT_THEIR_GROUP',
            });
          homeGroupId = dto.homeGroupId;
        } else if (own.length === 1) homeGroupId = own[0];
        else
          throw new ConflictException({
            message: own.length ? 'Say which of their groups' : 'This student has no group',
            code: 'MAKEUP_NOT_ALLOWED',
            reason: own.length ? 'PICK_HOME_GROUP' : 'NO_GROUP',
          });
      }

      // Seats: the class's own students plus the makeups already in it.
      const group = await tx.group.findUniqueOrThrow({
        where: { id: s.groupId },
        select: { capacity: true },
      });
      if (group.capacity != null) {
        const guests = await tx.attendanceRecord.count({
          where: { sessionId: sheet.id, homeGroupId: { not: null } },
        });
        if (expected.size + guests >= group.capacity)
          throw new ConflictException({
            message: 'This class is full',
            code: 'GROUP_FULL',
            capacity: group.capacity,
            seated: expected.size + guests,
          });
      }
      // The same live-check-in rule as mark(): late only while the class is on.
      const late =
        now.getTime() > s.startAt.getTime() + grace * 60_000 && now.getTime() < s.endAt.getTime();
      await tx.attendanceRecord.create({
        data: {
          sessionId: sheet.id,
          studentId: dto.studentId,
          status: late ? 'LATE' : 'PRESENT',
          method: 'MANUAL',
          checkedInAt: now,
          markedAt: now,
          markedBy: ctx.userId,
          academyId: ctx.academyId,
          homeGroupId,
          makeupForSessionId,
        },
      });
      return { sheetId: sheet.id, created: true, homeGroupId, makeupForSessionId };
    });
    if (outcome.created)
      await this.audit.log({
        actorUserId: ctx.userId,
        action: 'attendance.makeup',
        entity: 'AttendanceSession',
        entityId: outcome.sheetId,
        academyId: ctx.academyId,
        meta: {
          sessionId,
          studentId: dto.studentId,
          homeGroupId: outcome.homeGroupId,
          makeupForSessionId: outcome.makeupForSessionId,
        },
      });
    return this.roster(ctx, sessionId);
  }

  /**
   * Who could make up in this class. By student code for anyone who may take
   * the class's attendance; by name only for those who may read the whole
   * register (a teacher does not browse the academy's students by name).
   * Returns only what the choice needs: name, code, their groups and their
   * recently missed classes.
   */
  async makeupCandidates(ctx: AcademyContext, sessionId: string, q: string) {
    const session = await this.load(ctx, sessionId);
    const query = q.trim();
    const byCode = CODE_RE.test(query);
    const byName = !byCode && query.length >= 2 && ctx.can('student.directory');
    if (!byCode && !byName) return { mode: 'CODE_ONLY' as const, candidates: [] };
    const rows = byCode
      ? await this.prisma.academyStudent.findMany({
          where: { academyId: ctx.academyId, code: query, status: 'ACTIVE' },
          select: { studentId: true, fullName: true, code: true },
        })
      : await this.prisma.$queryRaw<{ studentId: string; fullName: string; code: string }[]>`
          SELECT "studentId", "fullName", code FROM "AcademyStudent"
          WHERE "academyId" = ${ctx.academyId} AND status = 'ACTIVE'
            AND "nameNormalized" LIKE '%' || academy_student_name_key(${query}) || '%'
          ORDER BY "nameNormalized", id LIMIT 10`;
    if (!rows.length)
      return { mode: byCode ? ('CODE' as const) : ('NAME' as const), candidates: [] };
    const ids = rows.map((r) => r.studentId);
    const expected = await this.expected(this.prisma, session);
    const stints = await this.prisma.groupMembership.findMany({
      where: { academyId: ctx.academyId, studentId: { in: ids }, deletedAt: null },
      select: { studentId: true, group: { select: { id: true, name: true } } },
    });
    const clock = await this.schedule.academyClock(ctx.academyId);
    const since = localDayBounds(addDays(clock.today, -MISSED_LOOKBACK_DAYS), clock.timezone).start;
    const missed = await this.prisma.attendanceRecord.findMany({
      where: {
        academyId: ctx.academyId,
        studentId: { in: ids },
        status: { in: ['ABSENT', 'EXCUSED'] },
        homeGroupId: null,
        session: { groupSession: { startAt: { gte: since } } },
      },
      select: {
        studentId: true,
        status: true,
        session: {
          select: {
            groupSession: {
              select: { id: true, startAt: true, group: { select: { id: true, name: true } } },
            },
          },
        },
      },
      orderBy: { markedAt: 'desc' },
      take: 50,
    });
    return {
      mode: byCode ? ('CODE' as const) : ('NAME' as const),
      candidates: rows.map((r) => ({
        studentId: r.studentId,
        fullName: r.fullName,
        code: r.code,
        belongsHere: expected.has(r.studentId),
        groups: stints.filter((s) => s.studentId === r.studentId).map((s) => s.group),
        missed: missed
          .filter((m) => m.studentId === r.studentId && m.session.groupSession)
          .map((m) => ({
            sessionId: m.session.groupSession!.id,
            status: m.status,
            group: m.session.groupSession!.group,
            ...this.local(m.session.groupSession!.startAt, clock.timezone),
          })),
      })),
    };
  }

  // ── Internals ─────────────────────────────────────────────────────────

  /** The class, in this academy, that the caller may act on — or 404/403. */
  private async load(ctx: AcademyContext, sessionId: string) {
    const session = await this.prisma.groupSession.findFirst({
      where: { id: sessionId, academyId: ctx.academyId },
    });
    if (!session)
      throw new NotFoundException({ message: 'Class not found', code: 'SESSION_NOT_FOUND' });
    await this.access.assertGroupAccess(ctx, session.groupId);
    if (session.mode === 'ONLINE')
      throw new ConflictException({
        message: 'An online session has no physical attendance',
        code: 'SESSION_ONLINE',
      });
    return session;
  }

  private async lock(tx: Prisma.TransactionClient, sessionId: string) {
    await tx.$queryRaw`SELECT id FROM "GroupSession" WHERE id = ${sessionId} FOR UPDATE`;
    return tx.groupSession.findUniqueOrThrow({ where: { id: sessionId } });
  }

  /** The database's clock — the one authority for every attendance time. */
  private async now(db: Db): Promise<Date> {
    const [row] = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    return row.now;
  }

  private assertOpen(s: GroupSession, now: Date) {
    if (s.status === 'CANCELLED')
      throw new ConflictException({
        message: 'This class was cancelled',
        code: 'SESSION_CANCELLED',
      });
    if (now.getTime() < s.startAt.getTime() - OPENS_BEFORE_MIN * 60_000)
      throw new ConflictException({
        message: 'Attendance opens an hour before the class',
        code: 'ATTENDANCE_NOT_OPEN',
      });
  }

  /** The class's sheet, created on first use; keyed on the class, never the date. */
  private async sheet(tx: Prisma.TransactionClient, s: GroupSession, ctx: AcademyContext) {
    const existing = await tx.attendanceSession.findUnique({ where: { groupSessionId: s.id } });
    if (existing) return existing;
    const clock = await this.schedule.academyClock(s.academyId);
    return tx.attendanceSession.create({
      data: {
        groupSessionId: s.id,
        groupId: s.groupId,
        academyId: s.academyId,
        // The class's local date, so everything that reads attendance by
        // group and date (Needs Attention, guardians, Student 360) sees it.
        date: new Date(`${wallClock(s.startAt, clock.timezone).date}T00:00:00.000Z`),
        createdBy: ctx.userId,
      },
    });
  }

  /**
   * Student ids expected at a class — see the class comment for the rule.
   * The window is compared against the class's own columns, never a bound
   * parameter: the columns are `timestamp without time zone` (UTC), and a
   * JS Date parameter would be converted through the database session's
   * TimeZone setting — right on a UTC server, silently hours off elsewhere.
   */
  async expected(db: Db, s: Pick<GroupSession, 'id'>) {
    const rows = await db.$queryRaw<{ studentId: string }[]>`
      SELECT DISTINCT m."studentId"
      FROM "GroupSession" gs
      JOIN "GroupMembership" m ON m."groupId" = gs."groupId"
      LEFT JOIN "AcademyStudent" a ON a."academyId" = m."academyId" AND a."studentId" = m."studentId"
      WHERE gs.id = ${s.id}
        AND m."addedAt" < gs."endAt"
        AND (m."deletedAt" IS NULL OR m."deletedAt" > gs."startAt")
        AND (a.id IS NULL OR a.status <> 'WITHDRAWN' OR a."leftAt" > gs."startAt")`;
    return new Set(rows.map((r) => r.studentId));
  }

  private async graceFor(s: GroupSession) {
    const g = await this.prisma.group.findUniqueOrThrow({
      where: { id: s.groupId },
      select: { lateGraceMin: true, academy: { select: { lateGraceMin: true } } },
    });
    return g.lateGraceMin ?? g.academy.lateGraceMin;
  }

  /** OWNER: every group. Anyone else: the groups assigned to them. */
  private async groupScope(ctx: AcademyContext): Promise<string[] | null> {
    if (ctx.role === 'OWNER') return null;
    const rows = await this.prisma.groupAssignment.findMany({
      where: { userId: ctx.userId, academyId: ctx.academyId },
      select: { groupId: true },
    });
    return rows.map((r) => r.groupId);
  }

  private local(at: Date, timezone: string) {
    const w = wallClock(at, timezone);
    return { date: w.date, time: formatClock(w.minute), startAt: at };
  }

  private async rosterOf(ctx: AcademyContext, session: GroupSession) {
    const clock = await this.schedule.academyClock(ctx.academyId);
    const [full, sheet, expected, grace, now] = await Promise.all([
      this.prisma.groupSession.findUniqueOrThrow({
        where: { id: session.id },
        include: SESSION_INCLUDE,
      }),
      this.prisma.attendanceSession.findUnique({
        where: { groupSessionId: session.id },
        include: {
          records: {
            include: {
              homeGroup: { select: { id: true, name: true } },
              makeupForSession: { select: { id: true, startAt: true } },
            },
          },
        },
      }),
      this.expected(this.prisma, session),
      this.graceFor(session),
      this.now(this.prisma),
    ]);
    const records = sheet?.records ?? [];
    const ids = [...new Set([...expected, ...records.map((r) => r.studentId)])];
    const [register, profiles] = await Promise.all([
      this.prisma.academyStudent.findMany({
        where: { academyId: ctx.academyId, studentId: { in: ids } },
        select: { studentId: true, fullName: true, code: true },
      }),
      this.prisma.studentProfile.findMany({
        where: { id: { in: ids } },
        select: { id: true, user: { select: { fullName: true, avatarUrl: true } } },
      }),
    ]);
    const reg = new Map(register.map((r) => [r.studentId, r]));
    const prof = new Map(profiles.map((p) => [p.id, p.user]));
    const byStudent = new Map(records.map((r) => [r.studentId, r]));
    const students = ids
      .map((id) => {
        const r = byStudent.get(id);
        return {
          studentId: id,
          fullName: reg.get(id)?.fullName ?? prof.get(id)?.fullName ?? '',
          code: reg.get(id)?.code ?? null,
          avatarUrl: prof.get(id)?.avatarUrl ?? null,
          expected: expected.has(id),
          status: r?.status ?? null,
          method: r?.method ?? null,
          checkedInAt: r?.checkedInAt ?? null,
          makeup: r?.homeGroup
            ? {
                homeGroup: r.homeGroup,
                forSession: r.makeupForSession
                  ? {
                      id: r.makeupForSession.id,
                      ...this.local(r.makeupForSession.startAt, clock.timezone),
                    }
                  : null,
              }
            : null,
        };
      })
      .sort(
        (a, b) =>
          Number(!!a.makeup) - Number(!!b.makeup) || a.fullName.localeCompare(b.fullName, 'ar'),
      );
    const counts = { PRESENT: 0, LATE: 0, ABSENT: 0, EXCUSED: 0, UNMARKED: 0, MAKEUP: 0 };
    for (const s of students) {
      if (s.makeup) counts.MAKEUP++;
      if (s.status) counts[s.status]++;
      else counts.UNMARKED++;
    }
    const cancelled = full.status === 'CANCELLED';
    const opensAt = new Date(full.startAt.getTime() - OPENS_BEFORE_MIN * 60_000);
    return {
      session: this.sessionView(full, clock.timezone),
      timezone: clock.timezone,
      graceMin: grace,
      lateAfter: new Date(full.startAt.getTime() + grace * 60_000),
      now,
      closedAt: sheet?.closedAt ?? null,
      canMark: !cancelled && now >= opensAt,
      canClose: !cancelled && !sheet?.closedAt && now >= full.startAt,
      canStart: !cancelled && !full.startedAt && !sheet?.closedAt && now >= opensAt,
      capacity: full.group.capacity,
      counts,
      students,
    };
  }

  private sessionView(
    s: Prisma.GroupSessionGetPayload<{ include: typeof SESSION_INCLUDE }>,
    timezone: string,
  ) {
    const start = wallClock(s.startAt, timezone);
    const end = wallClock(s.endAt, timezone);
    return {
      id: s.id,
      group: { id: s.group.id, name: s.group.name },
      teacher: s.teacher,
      room: s.room,
      mode: s.mode,
      locationType: s.locationType,
      locationNote: s.locationNote,
      status: s.status,
      startAt: s.startAt,
      endAt: s.endAt,
      date: start.date,
      startTime: formatClock(start.minute),
      endTime: formatClock(end.minute),
      startedAt: s.startedAt,
      fromTimetable: !!s.slotId,
    };
  }

  /** Each class with its expected/marked counts, in one query for the lot. */
  private async withCounts(
    sessions: Prisma.GroupSessionGetPayload<{ include: typeof SESSION_INCLUDE }>[],
    timezone: string,
  ) {
    if (!sessions.length) return [];
    const ids = sessions.map((s) => s.id);
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        expected: number;
        present: number;
        late: number;
        absent: number;
        excused: number;
        makeup: number;
        closedAt: Date | null;
      }[]
    >`
      SELECT gs.id,
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
        max(s."closedAt") AS "closedAt"
      FROM "GroupSession" gs
      LEFT JOIN "AttendanceSession" s ON s."groupSessionId" = gs.id AND s."deletedAt" IS NULL
      LEFT JOIN "AttendanceRecord" r ON r."sessionId" = s.id AND r."deletedAt" IS NULL
      WHERE gs.id IN (${Prisma.join(ids)})
      GROUP BY gs.id`;
    const byId = new Map(rows.map((r) => [r.id, r]));
    return sessions.map((s) => {
      const c = byId.get(s.id)!;
      return {
        ...this.sessionView(s, timezone),
        closedAt: c.closedAt,
        capacity: s.group.capacity,
        counts: {
          expected: c.expected,
          present: c.present,
          late: c.late,
          absent: c.absent,
          excused: c.excused,
          makeup: c.makeup,
        },
      };
    });
  }
}

const SESSION_INCLUDE = {
  group: { select: { id: true, name: true, capacity: true } },
  room: { select: { id: true, name: true } },
  teacher: { select: { id: true, fullName: true } },
} satisfies Prisma.GroupSessionInclude;
