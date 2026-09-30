import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AttendanceMethod, Prisma } from '@prisma/client';
import { AcademyContext } from '../academy/academy-context';
import { AuditService } from '../audit/audit.service';
import { isValidStudentCode } from '../center-students/student-code';
import { ClassAttendanceService, OPENS_BEFORE_MIN } from '../class-ops/class-attendance.service';
import { ClassScheduleService } from '../class-ops/class-schedule.service';
import { formatClock, localDayBounds, wallClock } from '../class-ops/zoned-time';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { generateCardToken, hashCardToken, isCardToken, normalizeDeskInput } from './card-token';
import { DeskCheckInDto, DeskIdentityDto, ReissueCardDto, RevokeCardDto } from './dto';

/** Failed card/code lookups one desk user may make in the window before a pause. */
export const MISS_LIMIT = 30;
const MISS_WINDOW_S = 600;
/** How often one process tops up an academy's generated classes from the desk. */
const HORIZON_EVERY_MS = 10 * 60_000;

interface Identified {
  academyStudentId: string;
  /** Derived from how they were identified — never sent by a client. */
  method: AttendanceMethod;
  /** The card that identified them, re-checked when the record is written. */
  cardId?: string;
}

export type ClassState = 'OPEN' | 'NOT_YET' | 'ENDED' | 'CLOSED' | 'CANCELLED';

/**
 * Center Operations C3 — the reception desk.
 *
 * A thin layer over C1 and C2: IDENTIFY (card, code, or a register record
 * picked from the C1 search) → RESOLVE today's real classes (C2 GroupSession
 * rows) → CHECK IN through ClassAttendanceService, which owns expected
 * students, lateness, capacity, makeups, closing and the locks. Nothing here
 * decides PRESENT or LATE, and nothing here writes attendance directly.
 *
 * Only this academy exists here: every lookup is scoped to ctx.academyId,
 * and a card of another academy is indistinguishable from a random number.
 * The resolve result carries what the desk needs — no finance, no contacts,
 * no Student 360.
 */
@Injectable()
export class DeskService {
  private readonly logger = new Logger('Desk');
  private readonly horizonAt = new Map<string, number>();
  private readonly localMisses = new Map<string, { n: number; until: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly attendance: ClassAttendanceService,
    private readonly schedule: ClassScheduleService,
    private readonly flags: FeatureFlagsService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  // ── Identify ─────────────────────────────────────────────────────────

  async resolve(ctx: AcademyContext, dto: DeskIdentityDto) {
    return this.view(ctx, await this.identify(ctx, dto));
  }

  /**
   * Check in. With a class named, that class; without one (Rush mode), only
   * the single class of theirs open now — anything else comes back as
   * NEEDS_DESK with the choices, never a guess. A retry of a check-in that
   * already happened answers ALREADY with the record, so a lost response is
   * safe to repeat.
   */
  async checkIn(ctx: AcademyContext, dto: DeskCheckInDto) {
    const who = await this.identify(ctx, dto);
    if (!(await this.flags.isEnabled(ctx.academyId, 'classOperations')))
      throw new ConflictException({
        message: 'Classes are not switched on for this academy',
        code: 'CLASSES_OFF',
      });
    let sessionId = dto.sessionId;
    if (!sessionId) {
      if (dto.makeup)
        throw new BadRequestException({
          message: 'A makeup needs its class',
          code: 'VALIDATION_FAILED',
        });
      const view = await this.view(ctx, who);
      if (view.action.kind === 'ALREADY')
        return { outcome: 'ALREADY' as const, record: null, view };
      if (view.action.kind !== 'CHECK_IN')
        return { outcome: 'NEEDS_DESK' as const, record: null, view };
      sessionId = view.action.sessionId;
    }
    const student = await this.prisma.academyStudent.findUniqueOrThrow({
      where: { id: who.academyStudentId },
      select: { studentId: true },
    });
    const r = await this.attendance.deskCheckIn(ctx, {
      sessionId,
      studentId: student.studentId,
      method: who.method,
      cardId: who.cardId,
      makeup: dto.makeup
        ? { homeGroupId: dto.homeGroupId, makeupForSessionId: dto.makeupForSessionId }
        : undefined,
    });
    return {
      outcome: r.created ? ('CHECKED_IN' as const) : ('ALREADY' as const),
      record: {
        sessionId,
        status: r.status,
        method: r.method,
        checkedInAt: r.checkedInAt,
        makeup: r.makeup,
      },
      view: await this.view(ctx, who),
    };
  }

  private async identify(ctx: AcademyContext, dto: DeskIdentityDto): Promise<Identified> {
    const given = [dto.token, dto.code, dto.academyStudentId].filter((v) => v != null && v !== '');
    if (given.length !== 1)
      throw new BadRequestException({
        message: 'Send exactly one of token, code or academyStudentId',
        code: 'DESK_IDENTITY_REQUIRED',
      });

    if (dto.token != null) {
      await this.assertNotProbing(ctx);
      const token = normalizeDeskInput(dto.token);
      // Hashed before any query: the token itself never reaches the database,
      // a query log, or an error message.
      const card = isCardToken(token)
        ? await this.prisma.academyStudentCard.findUnique({
            where: { tokenHash: hashCardToken(token) },
            select: { id: true, academyId: true, academyStudentId: true, revokedAt: true },
          })
        : null;
      // Another academy's card is exactly as unknown as a made-up number.
      if (!card || card.academyId !== ctx.academyId) {
        await this.miss(ctx);
        throw new NotFoundException({ message: 'Card not recognised', code: 'CARD_NOT_FOUND' });
      }
      if (card.revokedAt) {
        await this.miss(ctx);
        throw new ConflictException({ message: 'This card was cancelled', code: 'CARD_REVOKED' });
      }
      return { academyStudentId: card.academyStudentId, method: 'QR', cardId: card.id };
    }

    if (dto.code != null) {
      await this.assertNotProbing(ctx);
      const code = normalizeDeskInput(dto.code);
      if (!isValidStudentCode(code)) {
        await this.miss(ctx);
        throw new BadRequestException({
          message: 'That is not a student code',
          code: 'STUDENT_CODE_INVALID',
        });
      }
      const row = await this.prisma.academyStudent.findUnique({
        where: { academyId_code: { academyId: ctx.academyId, code } },
        select: { id: true },
      });
      if (!row) {
        await this.miss(ctx);
        throw new NotFoundException({ message: 'Student not found', code: 'STUDENT_NOT_FOUND' });
      }
      return { academyStudentId: row.id, method: 'CODE' };
    }

    const row = await this.prisma.academyStudent.findFirst({
      where: { id: dto.academyStudentId, academyId: ctx.academyId },
      select: { id: true },
    });
    if (!row)
      throw new NotFoundException({ message: 'Student not found', code: 'STUDENT_NOT_FOUND' });
    return { academyStudentId: row.id, method: 'MANUAL' };
  }

  // ── Resolve: this learner's day ──────────────────────────────────────

  private async view(ctx: AcademyContext, who: Identified) {
    const s = await this.prisma.academyStudent.findUniqueOrThrow({
      where: { id: who.academyStudentId },
      select: {
        id: true,
        studentId: true,
        fullName: true,
        code: true,
        status: true,
        grade: { select: { nameAr: true, nameEn: true } },
        student: { select: { user: { select: { avatarUrl: true } } } },
      },
    });
    const [stints, activeCard] = await Promise.all([
      this.prisma.groupMembership.findMany({
        where: {
          academyId: ctx.academyId,
          studentId: s.studentId,
          deletedAt: null,
          group: { deletedAt: null },
        },
        select: { group: { select: { id: true, name: true } } },
      }),
      this.prisma.academyStudentCard.findFirst({
        where: { academyStudentId: s.id, revokedAt: null },
        select: { id: true },
      }),
    ]);
    const student = {
      id: s.id,
      studentId: s.studentId,
      fullName: s.fullName,
      code: s.code,
      status: s.status,
      grade: s.grade,
      avatarUrl: s.student.user.avatarUrl,
      groups: stints.map((m) => m.group),
      card: activeCard ? ('ACTIVE' as const) : ('NONE' as const),
    };
    const base = { student, via: who.method };

    if (!(await this.flags.isEnabled(ctx.academyId, 'classOperations')))
      return {
        ...base,
        now: new Date(),
        timezone: null,
        classes: [],
        makeupOptions: [],
        action: { kind: 'NO_CLASS' as const, reason: 'CLASSES_OFF' as const },
      };

    const clock = await this.schedule.academyClock(ctx.academyId);
    await this.topUpClasses(ctx.academyId);
    const { start, end } = localDayBounds(clock.today, clock.timezone);
    const [sessions, now] = await Promise.all([
      this.prisma.groupSession.findMany({
        where: {
          academyId: ctx.academyId,
          mode: { not: 'ONLINE' },
          startAt: { gte: start, lt: end },
          group: { deletedAt: null },
        },
        orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
        include: {
          group: { select: { id: true, name: true, capacity: true, lateGraceMin: true } },
          room: { select: { id: true, name: true } },
          teacher: { select: { id: true, fullName: true } },
        },
      }),
      this.dbNow(),
    ]);
    const ids = sessions.map((x) => x.id);
    const [home, sheets] = await Promise.all([
      this.attendance.expectedClassesOf(this.prisma, ctx.academyId, s.studentId, ids),
      ids.length
        ? this.prisma.attendanceSession.findMany({
            where: { groupSessionId: { in: ids } },
            select: {
              groupSessionId: true,
              closedAt: true,
              records: {
                where: { studentId: s.studentId },
                select: { status: true, method: true, checkedInAt: true, homeGroupId: true },
              },
            },
          })
        : [],
    ]);
    const sheetOf = new Map(sheets.map((x) => [x.groupSessionId!, x]));

    const all = sessions.map((x) => {
      const sheet = sheetOf.get(x.id);
      const rec = sheet?.records[0] ?? null;
      const state: ClassState =
        x.status === 'CANCELLED'
          ? 'CANCELLED'
          : sheet?.closedAt
            ? 'CLOSED'
            : now >= x.endAt
              ? 'ENDED'
              : now.getTime() < x.startAt.getTime() - OPENS_BEFORE_MIN * 60_000
                ? 'NOT_YET'
                : 'OPEN';
      const grace = x.group.lateGraceMin ?? clock.lateGraceMin;
      const kind: 'HOME' | 'MAKEUP' = rec
        ? rec.homeGroupId
          ? 'MAKEUP'
          : 'HOME'
        : home.has(x.id)
          ? 'HOME'
          : 'MAKEUP';
      const w0 = wallClock(x.startAt, clock.timezone);
      const w1 = wallClock(x.endAt, clock.timezone);
      return {
        sessionId: x.id,
        kind,
        state,
        group: { id: x.group.id, name: x.group.name },
        room: x.room,
        teacher: x.teacher ? { fullName: x.teacher.fullName } : null,
        startAt: x.startAt,
        endAt: x.endAt,
        startTime: formatClock(w0.minute),
        endTime: formatClock(w1.minute),
        // What a check-in now would be stored as — the server's clock, for the button's words.
        lateNow: now.getTime() > x.startAt.getTime() + grace * 60_000,
        attendance: rec
          ? { status: rec.status, method: rec.method, checkedInAt: rec.checkedInAt }
          : null,
        capacity: x.group.capacity,
        seated: null as number | null,
        full: false,
        mine: home.has(x.id) || !!rec,
      };
    });
    const classes = all.filter((c) => c.mine);
    // Makeup: someone else's class that is open now, never a default.
    const makeupOptions =
      student.status === 'ACTIVE' ? all.filter((c) => !c.mine && c.state === 'OPEN') : [];
    const seats = await this.attendance.seatsOf(makeupOptions.map((c) => c.sessionId));
    for (const c of makeupOptions) {
      c.seated = seats.get(c.sessionId) ?? 0;
      c.full = c.capacity != null && c.seated >= c.capacity;
    }
    const strip = ({ mine: _m, ...c }: (typeof all)[number]) => c;

    const openHome = classes.filter((c) => c.kind === 'HOME' && c.state === 'OPEN');
    const action =
      student.status !== 'ACTIVE'
        ? ({ kind: 'WITHDRAWN' } as const)
        : openHome.length === 1
          ? openHome[0].attendance
            ? ({
                kind: 'ALREADY',
                sessionId: openHome[0].sessionId,
                status: openHome[0].attendance.status,
              } as const)
            : ({ kind: 'CHECK_IN', sessionId: openHome[0].sessionId } as const)
          : openHome.length > 1
            ? ({ kind: 'CHOOSE' } as const)
            : ({
                kind: 'NO_CLASS',
                reason: 'NONE_OPEN' as const,
                nextSessionId:
                  classes.find((c) => c.kind === 'HOME' && c.state === 'NOT_YET')?.sessionId ??
                  null,
              } as const);
    return {
      ...base,
      now,
      timezone: clock.timezone,
      classes: classes.map(strip),
      makeupOptions: makeupOptions.map(strip),
      action,
    };
  }

  // ── Cards ─────────────────────────────────────────────────────────────

  async cardState(ctx: AcademyContext, academyStudentId: string) {
    await this.studentIn(ctx, academyStudentId);
    const cards = await this.prisma.academyStudentCard.findMany({
      where: { academyStudentId, academyId: ctx.academyId },
      orderBy: { issuedAt: 'desc' },
      take: 10,
      select: { id: true, issuedAt: true, revokedAt: true, revokeReason: true },
    });
    return { active: cards.find((c) => !c.revokedAt) ?? null, history: cards };
  }

  /**
   * Issue a first card. The token is in this response and nowhere else —
   * print it now. A second issue (a double tap, another desk) meets the
   * learner's row lock and then CARD_ALREADY_ACTIVE; replacing a card is
   * reissue.
   */
  async issue(ctx: AcademyContext, academyStudentId: string) {
    const token = generateCardToken();
    const card = await this.prisma.$transaction(async (tx) => {
      const s = await this.lockStudent(tx, ctx, academyStudentId);
      if (s.status !== 'ACTIVE')
        throw new ConflictException({
          message: 'This student has withdrawn; reactivate them first',
          code: 'STUDENT_WITHDRAWN',
        });
      const active = await tx.academyStudentCard.findFirst({
        where: { academyStudentId, revokedAt: null },
        select: { id: true },
      });
      if (active)
        throw new ConflictException({
          message: 'This student already has a card — reissue to replace it',
          code: 'CARD_ALREADY_ACTIVE',
        });
      return tx.academyStudentCard.create({
        data: {
          academyId: ctx.academyId,
          academyStudentId,
          tokenHash: hashCardToken(token),
          issuedBy: ctx.userId,
        },
        select: { id: true, issuedAt: true },
      });
    });
    await this.audit.log({
      actorUserId: ctx.userId,
      action: 'card.issue',
      entity: 'AcademyStudentCard',
      entityId: card.id,
      academyId: ctx.academyId,
      meta: { academyStudentId },
    });
    return { token, card, print: await this.printData(ctx, academyStudentId) };
  }

  /**
   * Replace the active card in one step: the old one stops working in the
   * same transaction the new one starts. The screen names the card it is
   * replacing, so two desks (or a double tap) replacing at once cannot both
   * succeed — the second sees CARD_CHANGED instead of silently killing the
   * card the first one just printed.
   */
  async reissue(ctx: AcademyContext, academyStudentId: string, dto: ReissueCardDto) {
    const token = generateCardToken();
    const card = await this.prisma.$transaction(async (tx) => {
      const s = await this.lockStudent(tx, ctx, academyStudentId);
      if (s.status !== 'ACTIVE')
        throw new ConflictException({
          message: 'This student has withdrawn; reactivate them first',
          code: 'STUDENT_WITHDRAWN',
        });
      const active = await tx.academyStudentCard.findFirst({
        where: { academyStudentId, revokedAt: null },
        select: { id: true },
      });
      if (!active || active.id !== dto.cardId)
        throw new ConflictException({
          message: 'This card changed since the screen was opened',
          code: 'CARD_CHANGED',
        });
      const now = await this.dbNow(tx);
      await tx.academyStudentCard.update({
        where: { id: active.id },
        data: { revokedAt: now, revokedBy: ctx.userId, revokeReason: dto.reason ?? 'REISSUED' },
      });
      return tx.academyStudentCard.create({
        data: {
          academyId: ctx.academyId,
          academyStudentId,
          tokenHash: hashCardToken(token),
          issuedBy: ctx.userId,
        },
        select: { id: true, issuedAt: true },
      });
    });
    await this.audit.log({
      actorUserId: ctx.userId,
      action: 'card.reissue',
      entity: 'AcademyStudentCard',
      entityId: card.id,
      academyId: ctx.academyId,
      meta: { academyStudentId, replacedCardId: dto.cardId, reason: dto.reason ?? 'REISSUED' },
    });
    return { token, card, print: await this.printData(ctx, academyStudentId) };
  }

  /** Cancel a card. Revoking one already revoked is a no-op, so a double tap is harmless. */
  async revoke(ctx: AcademyContext, academyStudentId: string, dto: RevokeCardDto) {
    const changed = await this.prisma.$transaction(async (tx) => {
      await this.lockStudent(tx, ctx, academyStudentId);
      const card = await tx.academyStudentCard.findFirst({
        where: { id: dto.cardId, academyStudentId, academyId: ctx.academyId },
        select: { id: true, revokedAt: true },
      });
      if (!card) throw new NotFoundException({ message: 'Card not found', code: 'CARD_NOT_FOUND' });
      if (card.revokedAt) return false;
      // The UPDATE's row lock waits for a check-in holding this card FOR SHARE.
      await tx.academyStudentCard.update({
        where: { id: card.id },
        data: { revokedAt: await this.dbNow(tx), revokedBy: ctx.userId, revokeReason: dto.reason },
      });
      return true;
    });
    if (changed)
      await this.audit.log({
        actorUserId: ctx.userId,
        action: 'card.revoke',
        entity: 'AcademyStudentCard',
        entityId: dto.cardId,
        academyId: ctx.academyId,
        meta: { academyStudentId, reason: dto.reason },
      });
    return { changed, ...(await this.cardState(ctx, academyStudentId)) };
  }

  // ── Internals ─────────────────────────────────────────────────────────

  /** What the printed card shows: the center, the learner's name, code and year. No contacts. */
  private async printData(ctx: AcademyContext, academyStudentId: string) {
    const [s, academy] = await Promise.all([
      this.prisma.academyStudent.findUniqueOrThrow({
        where: { id: academyStudentId },
        select: { fullName: true, code: true, grade: { select: { nameAr: true, nameEn: true } } },
      }),
      this.prisma.academy.findUniqueOrThrow({
        where: { id: ctx.academyId },
        select: { name: true, logoUrl: true },
      }),
    ]);
    return { ...s, academy };
  }

  private async studentIn(ctx: AcademyContext, academyStudentId: string) {
    const row = await this.prisma.academyStudent.findFirst({
      where: { id: academyStudentId, academyId: ctx.academyId },
      select: { id: true },
    });
    if (!row)
      throw new NotFoundException({ message: 'Student not found', code: 'STUDENT_NOT_FOUND' });
  }

  /** The learner's register row, locked: every card change for them queues here. */
  private async lockStudent(tx: Prisma.TransactionClient, ctx: AcademyContext, id: string) {
    const [row] = await tx.$queryRaw<{ id: string; status: string }[]>`
      SELECT id, status::text AS status FROM "AcademyStudent"
      WHERE id = ${id} AND "academyId" = ${ctx.academyId}
      FOR UPDATE`;
    if (!row)
      throw new NotFoundException({ message: 'Student not found', code: 'STUDENT_NOT_FOUND' });
    return row;
  }

  private async dbNow(db: Prisma.TransactionClient | PrismaService = this.prisma) {
    const [row] = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    return row.now;
  }

  /** Classes are generated ahead by the worker; the desk tops up at most every few minutes. */
  private async topUpClasses(academyId: string) {
    const last = this.horizonAt.get(academyId) ?? 0;
    if (Date.now() - last < HORIZON_EVERY_MS) return;
    this.horizonAt.set(academyId, Date.now());
    await this.schedule.ensureHorizon(academyId);
  }

  // A card token has ~159 bits, so guessing one is hopeless; this stops a
  // script from trying anyway (and from walking the 6-digit code space). It
  // counts only FAILED lookups, per user and academy, so a queue of real
  // scans — however fast the scanner — never meets it.

  private missKey(ctx: AcademyContext) {
    return `desk:miss:${ctx.academyId}:${ctx.userId}`;
  }

  private async misses(ctx: AcademyContext): Promise<number> {
    const client = this.redis.client;
    if (client) {
      try {
        return Number((await client.get(this.missKey(ctx))) ?? 0);
      } catch {
        /* falls back to this process's count */
      }
    }
    const local = this.localMisses.get(this.missKey(ctx));
    return local && local.until > Date.now() ? local.n : 0;
  }

  private async miss(ctx: AcademyContext) {
    const key = this.missKey(ctx);
    const client = this.redis.client;
    if (client) {
      try {
        const n = await client.incr(key);
        if (n === 1) await client.expire(key, MISS_WINDOW_S);
        return;
      } catch {
        /* falls back to this process's count */
      }
    }
    const cur = this.localMisses.get(key);
    const live = cur && cur.until > Date.now();
    this.localMisses.set(key, {
      n: live ? cur.n + 1 : 1,
      until: live ? cur.until : Date.now() + MISS_WINDOW_S * 1000,
    });
  }

  private async assertNotProbing(ctx: AcademyContext) {
    if ((await this.misses(ctx)) < MISS_LIMIT) return;
    this.logger.warn(`desk lookups paused after ${MISS_LIMIT} misses user=${ctx.userId}`);
    throw new HttpException(
      {
        message: 'Too many unknown cards or codes — wait a few minutes',
        code: 'DESK_TOO_MANY_MISSES',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
