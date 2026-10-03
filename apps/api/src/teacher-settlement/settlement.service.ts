import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TeacherAgreement, TeacherSettlement } from '@prisma/client';
import { AcademyContext } from '../academy/academy-context';
import { AcademyService } from '../academy/academy.service';
import { AuditService } from '../audit/audit.service';
import { CenterFeesService } from '../center-fees/center-fees.service';
import { ClassScheduleService } from '../class-ops/class-schedule.service';
import { addDays, localDayBounds } from '../class-ops/zoned-time';
import { PrismaService } from '../prisma/prisma.service';
import { AdjustDto, CreateAgreementDto, FinalizeDto, PayDto } from './dto';

type Db = Prisma.TransactionClient | PrismaService;
const MAX_PERIOD_DAYS = 92;
const PAGE = 30;

export interface Line {
  kind: 'SESSION' | 'COLLECTION' | 'FIXED';
  sourceId: string;
  agreementId: string;
  amountCents: number;
  detail: Record<string, unknown>;
}
export interface Pending {
  sessionId: string;
  groupName: string;
  startAt: string;
  why: 'NOT_ENDED' | 'ATTENDANCE_OPEN';
}

/** Half-up integer rounding of n / d for n, d ≥ 0. */
const divRound = (n: bigint, d: bigint) => Number((n * 2n + d) / (2n * d));
const day = (d: Date) => d.toISOString().slice(0, 10);
const daysIn = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const maxDate = (a: string, b: string) => (a > b ? a : b);
const minDate = (a: string, b: string) => (a < b ? a : b);

/**
 * Center Operations C8 — what the CENTER owes and pays its TEACHERS.
 *
 * Its own books (TeacherAgreement, TeacherSettlement and its lines,
 * adjustments and payments). It reads who taught a class from the class's own
 * teacher snapshot (GroupSession.teacherUserId — C2; never today's
 * assignments), attendance closure (C2), and money collected through
 * CenterFeesService (C4). It writes nothing anywhere else and never touches
 * platform money (teacher-settlement.boundary.spec.ts).
 *
 * Rules (docs/TEACHER-SETTLEMENT.md):
 *  - PER_SESSION: a class counts when it is physical or hybrid, not cancelled,
 *    has ended, its attendance is closed (proof it was held — an empty class
 *    still counts), its teacher snapshot is the teacher, its group is in the
 *    agreement's scope (empty = all), and its local date lies in both the
 *    period and the agreement's dates. One line per class.
 *  - PERCENT_OF_COLLECTIONS: cash received in the period on plan charges of
 *    the agreement's groups, never a reversed collection; each allocation's
 *    share is rounded half-up to the piaster. One line per allocation.
 *  - FIXED_PERIOD: per calendar month, prorated by covered days, half-up.
 *  - Finalizing freezes the lines; later changes show as drift and are fixed
 *    with adjustments, never by rewriting the settlement.
 */
@Injectable()
export class TeacherSettlementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly schedule: ClassScheduleService,
    private readonly fees: CenterFeesService,
    private readonly academy: AcademyService,
    private readonly audit: AuditService,
  ) {}

  // ── Teachers and agreements ────────────────────────────────────────────

  async teachers(ctx: AcademyContext) {
    const members = await this.prisma.academyMembership.findMany({
      where: {
        academyId: ctx.academyId,
        status: 'ACTIVE',
        deletedAt: null,
        role: { in: ['TEACHER', 'OWNER'] },
      },
      select: { userId: true, role: true, user: { select: { fullName: true, role: true } } },
    });
    const agreements = await this.prisma.teacherAgreement.findMany({
      where: { academyId: ctx.academyId },
      orderBy: [{ teacherUserId: 'asc' }, { effectiveFrom: 'asc' }],
    });
    const ids = new Set([
      ...members.filter((m) => m.user.role === 'TEACHER').map((m) => m.userId),
      ...agreements.map((a) => a.teacherUserId),
    ]);
    const names = await this.names([...ids]);
    return [...ids]
      .map((id) => ({
        userId: id,
        name: names.get(id) ?? '',
        agreements: agreements
          .filter((a) => a.teacherUserId === id)
          .map((a) => this.agreementView(a)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  }

  /** The academy's groups, for an agreement's scope. */
  async groups(ctx: AcademyContext) {
    return this.prisma.group.findMany({
      where: { academyId: ctx.academyId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
  }

  async createAgreement(ctx: AcademyContext, dto: CreateAgreementDto) {
    const prior = await this.prisma.teacherAgreement.findUnique({
      where: { academyId_requestKey: { academyId: ctx.academyId, requestKey: dto.requestKey } },
    });
    if (prior) {
      if (
        prior.teacherUserId !== dto.teacherUserId ||
        prior.method !== dto.method ||
        day(prior.effectiveFrom) !== dto.effectiveFrom
      )
        throw this.conflict(
          'SETTLEMENT_KEY_REUSED',
          'This request key was already used for something else',
        );
      return { created: false, agreement: this.agreementView(prior) };
    }
    await this.academy.assertAssignableTeacher(ctx.academyId, dto.teacherUserId);
    const groupIds = [...new Set(dto.groupIds ?? [])];
    if (dto.method === 'FIXED_PERIOD' && groupIds.length)
      throw this.bad(
        'AGREEMENT_SCOPE_INVALID',
        'A fixed monthly amount has no group scope',
        'groupIds',
      );
    if (dto.method === 'PERCENT_OF_COLLECTIONS' && !groupIds.length)
      throw this.bad(
        'AGREEMENT_SCOPE_REQUIRED',
        'Choose the groups whose collections count',
        'groupIds',
      );
    if (groupIds.length) {
      const found = await this.prisma.group.count({
        where: { academyId: ctx.academyId, id: { in: groupIds } },
      });
      if (found !== groupIds.length)
        throw new NotFoundException({
          message: 'Group not found',
          code: 'GROUP_NOT_FOUND',
          field: 'groupIds',
        });
    }
    if (dto.effectiveTo && dto.effectiveTo < dto.effectiveFrom)
      throw this.bad('AGREEMENT_DATES_INVALID', 'The end is before the start', 'effectiveTo');
    const settledTo = await this.settledThrough(ctx.academyId, dto.teacherUserId);
    if (settledTo && dto.effectiveFrom <= settledTo)
      throw this.conflict(
        'AGREEMENT_IN_SETTLED_PERIOD',
        'That date is inside a finalized settlement — use an adjustment instead',
      );
    const currency = await this.fees.currencyOf(ctx.academyId);
    try {
      const a = await this.prisma.teacherAgreement.create({
        data: {
          academyId: ctx.academyId,
          teacherUserId: dto.teacherUserId,
          method: dto.method,
          currency,
          rateCents: dto.method === 'PERCENT_OF_COLLECTIONS' ? null : dto.rateCents!,
          percentBps: dto.method === 'PERCENT_OF_COLLECTIONS' ? dto.percentBps! : null,
          groupIds,
          effectiveFrom: new Date(`${dto.effectiveFrom}T00:00:00Z`),
          effectiveTo: dto.effectiveTo ? new Date(`${dto.effectiveTo}T00:00:00Z`) : null,
          requestKey: dto.requestKey,
          createdBy: ctx.userId,
        },
      });
      await this.log(ctx, 'settlement.agreement.create', 'TeacherAgreement', a.id, {
        teacherUserId: a.teacherUserId,
        method: a.method,
        rateCents: a.rateCents,
        percentBps: a.percentBps,
        groups: groupIds.length,
        effectiveFrom: dto.effectiveFrom,
      });
      return { created: true, agreement: this.agreementView(a) };
    } catch (e) {
      throw this.translate(e);
    }
  }

  async endAgreement(ctx: AcademyContext, id: string, effectiveTo: string) {
    const a = await this.prisma.teacherAgreement.findFirst({
      where: { id, academyId: ctx.academyId },
    });
    if (!a)
      throw new NotFoundException({ message: 'Agreement not found', code: 'AGREEMENT_NOT_FOUND' });
    if (a.endedAt) throw this.conflict('AGREEMENT_ENDED', 'This agreement has already ended');
    if (effectiveTo < day(a.effectiveFrom))
      throw this.bad('AGREEMENT_DATES_INVALID', 'The end is before the start', 'effectiveTo');
    if (a.effectiveTo && effectiveTo > day(a.effectiveTo))
      throw this.bad(
        'AGREEMENT_DATES_INVALID',
        'An agreement can only end earlier than planned',
        'effectiveTo',
      );
    const settledTo = await this.settledThrough(ctx.academyId, a.teacherUserId);
    if (settledTo && effectiveTo < settledTo)
      throw this.conflict(
        'AGREEMENT_IN_SETTLED_PERIOD',
        'A finalized settlement already covers days after that date',
      );
    try {
      const done = await this.prisma.teacherAgreement.update({
        where: { id },
        data: {
          effectiveTo: new Date(`${effectiveTo}T00:00:00Z`),
          endedAt: new Date(),
          endedBy: ctx.userId,
        },
      });
      await this.log(ctx, 'settlement.agreement.end', 'TeacherAgreement', id, { effectiveTo });
      return this.agreementView(done);
    } catch (e) {
      throw this.translate(e);
    }
  }

  // ── The calculation (one implementation: preview, finalize, drift) ─────

  async preview(ctx: AcademyContext, teacherUserId: string, from: string, to: string) {
    const clock = await this.schedule.academyClock(ctx.academyId);
    this.assertPeriod(from, to, clock.today);
    const r = await this.compute(ctx.academyId, teacherUserId, from, to);
    const settled = await this.prisma.teacherSettlement.findFirst({
      where: {
        academyId: ctx.academyId,
        teacherUserId,
        status: { not: 'VOID' },
        periodFrom: { lte: new Date(`${to}T00:00:00Z`) },
        periodTo: { gte: new Date(`${from}T00:00:00Z`) },
      },
      select: { id: true, periodFrom: true, periodTo: true },
    });
    return {
      teacherUserId,
      from,
      to,
      today: clock.today,
      timezone: clock.timezone,
      ...r,
      overlapsSettlement: settled
        ? { id: settled.id, from: day(settled.periodFrom), to: day(settled.periodTo) }
        : null,
    };
  }

  async compute(
    academyId: string,
    teacherUserId: string,
    from: string,
    to: string,
    db: Db = this.prisma,
  ) {
    const clock = await this.schedule.academyClock(academyId);
    const tz = clock.timezone;
    const [{ now }] = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    const agreements = await db.teacherAgreement.findMany({
      where: {
        academyId,
        teacherUserId,
        effectiveFrom: { lte: new Date(`${to}T00:00:00Z`) },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date(`${from}T00:00:00Z`) } }],
      },
      orderBy: { effectiveFrom: 'asc' },
    });
    const lines: Line[] = [];
    const pending: Pending[] = [];
    for (const a of agreements) {
      const lo = maxDate(from, day(a.effectiveFrom));
      const hi = a.effectiveTo ? minDate(to, day(a.effectiveTo)) : to;
      if (lo > hi) continue;
      const start = localDayBounds(lo, tz).start;
      const end = localDayBounds(hi, tz).end;
      if (a.method === 'PER_SESSION') {
        const classes = await db.$queryRaw<
          {
            id: string;
            groupId: string;
            groupName: string;
            startAt: Date;
            endAt: Date;
            closed: boolean;
          }[]
        >`
          SELECT gs.id, gs."groupId", g.name AS "groupName", gs."startAt", gs."endAt",
                 EXISTS (SELECT 1 FROM "AttendanceSession" sh
                          WHERE sh."groupSessionId" = gs.id AND sh."deletedAt" IS NULL AND sh."closedAt" IS NOT NULL) AS closed
          FROM "GroupSession" gs JOIN "Group" g ON g.id = gs."groupId"
          WHERE gs."academyId" = ${academyId} AND gs."teacherUserId" = ${teacherUserId}
            AND gs."deletedAt" IS NULL AND gs.mode::text IN ('PHYSICAL', 'HYBRID') AND gs.status::text <> 'CANCELLED'
            AND gs."startAt" >= (${start.toISOString()}::timestamptz AT TIME ZONE 'UTC')
            AND gs."startAt" < (${end.toISOString()}::timestamptz AT TIME ZONE 'UTC')
            ${a.groupIds.length ? Prisma.sql`AND gs."groupId" = ANY(${a.groupIds}::text[])` : Prisma.empty}
          ORDER BY gs."startAt", gs.id`;
        for (const c of classes) {
          if (c.endAt > now || !c.closed) {
            pending.push({
              sessionId: c.id,
              groupName: c.groupName,
              startAt: c.startAt.toISOString(),
              why: c.endAt > now ? 'NOT_ENDED' : 'ATTENDANCE_OPEN',
            });
            continue;
          }
          lines.push({
            kind: 'SESSION',
            sourceId: c.id,
            agreementId: a.id,
            amountCents: a.rateCents!,
            detail: {
              groupId: c.groupId,
              groupName: c.groupName,
              startAt: c.startAt.toISOString(),
              rateCents: a.rateCents,
            },
          });
        }
      } else if (a.method === 'PERCENT_OF_COLLECTIONS') {
        const rows = await this.fees.allocationsForGroups(academyId, a.groupIds, start, end, db);
        for (const r of rows)
          lines.push({
            kind: 'COLLECTION',
            sourceId: r.allocationId,
            agreementId: a.id,
            amountCents: divRound(BigInt(r.amountCents) * BigInt(a.percentBps!), 10_000n),
            detail: {
              collectedCents: r.amountCents,
              percentBps: a.percentBps,
              receiptNumber: r.receiptNumber,
              receivedAt: r.receivedAt.toISOString(),
              groupId: r.groupId,
              studentCode: r.studentCode,
              chargeKind: r.chargeKind,
            },
          });
      } else {
        // FIXED_PERIOD: each calendar-month segment of [lo, hi], prorated by days.
        for (let segFrom = lo; segFrom <= hi;) {
          const ym = segFrom.slice(0, 7);
          const dim = daysIn(ym);
          const monthEnd = `${ym}-${String(dim).padStart(2, '0')}`;
          const segTo = minDate(hi, monthEnd);
          const covered = Number(segTo.slice(8)) - Number(segFrom.slice(8)) + 1;
          lines.push({
            kind: 'FIXED',
            sourceId: `${a.id}:${segFrom}`,
            agreementId: a.id,
            amountCents:
              covered === dim
                ? a.rateCents!
                : divRound(BigInt(a.rateCents!) * BigInt(covered), BigInt(dim)),
            detail: {
              month: ym,
              from: segFrom,
              to: segTo,
              coveredDays: covered,
              daysInMonth: dim,
              monthlyCents: a.rateCents,
            },
          });
          segFrom = addDays(segTo, 1);
        }
      }
    }
    const grossCents = lines.reduce((n, l) => n + l.amountCents, 0);
    return {
      currency: agreements[0]?.currency ?? (await this.fees.currencyOf(academyId)),
      agreements: agreements.map((a) => this.agreementView(a)),
      lines,
      pending,
      grossCents,
    };
  }

  // ── Finalize, void ─────────────────────────────────────────────────────

  /**
   * Under the teacher's lock (the same one agreement changes take): recompute,
   * refuse when the gross differs from what the person reviewed, then freeze
   * the settlement and its lines. A retry with the same request key answers
   * with the settlement it made.
   */
  async finalize(ctx: AcademyContext, dto: FinalizeDto) {
    const clock = await this.schedule.academyClock(ctx.academyId);
    this.assertPeriod(dto.from, dto.to, clock.today);
    const prior = await this.prisma.teacherSettlement.findUnique({
      where: { academyId_requestKey: { academyId: ctx.academyId, requestKey: dto.requestKey } },
    });
    if (prior) return this.replayFinalize(prior, dto);
    let made: { s: TeacherSettlement; fresh: boolean };
    try {
      made = await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'teacher-agreement:' + ctx.academyId}), hashtext(${dto.teacherUserId}))`;
          const again = await tx.teacherSettlement.findUnique({
            where: {
              academyId_requestKey: { academyId: ctx.academyId, requestKey: dto.requestKey },
            },
          });
          if (again) return { s: again, fresh: false };
          const r = await this.compute(ctx.academyId, dto.teacherUserId, dto.from, dto.to, tx);
          if (r.grossCents !== dto.expectedGrossCents)
            throw new ConflictException({
              message: 'The figures changed since you reviewed them',
              code: 'SETTLEMENT_PREVIEW_CHANGED',
              grossCents: r.grossCents,
            });
          if (!r.lines.length)
            throw this.conflict('SETTLEMENT_EMPTY', 'Nothing to settle in that period');
          const s = await tx.teacherSettlement.create({
            data: {
              academyId: ctx.academyId,
              teacherUserId: dto.teacherUserId,
              periodFrom: new Date(`${dto.from}T00:00:00Z`),
              periodTo: new Date(`${dto.to}T00:00:00Z`),
              currency: r.currency,
              grossCents: r.grossCents,
              requestKey: dto.requestKey,
              finalizedBy: ctx.userId,
            },
          });
          await tx.teacherSettlementLine.createMany({
            data: r.lines.map((l) => ({
              academyId: ctx.academyId,
              settlementId: s.id,
              teacherUserId: dto.teacherUserId,
              kind: l.kind,
              sourceId: l.sourceId,
              agreementId: l.agreementId,
              amountCents: l.amountCents,
              detail: l.detail as Prisma.InputJsonValue,
            })),
          });
          return { s, fresh: true };
        },
        { timeout: 30_000 },
      );
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const won = await this.prisma.teacherSettlement.findUnique({
          where: { academyId_requestKey: { academyId: ctx.academyId, requestKey: dto.requestKey } },
        });
        if (won) return this.replayFinalize(won, dto);
        throw this.conflict(
          'SETTLEMENT_SOURCE_TAKEN',
          'Some of these classes or collections are already in another settlement',
        );
      }
      throw this.translate(e);
    }
    if (!made.fresh) return this.replayFinalize(made.s, dto);
    await this.log(ctx, 'settlement.finalize', 'TeacherSettlement', made.s.id, {
      teacherUserId: made.s.teacherUserId,
      from: dto.from,
      to: dto.to,
      grossCents: made.s.grossCents,
    });
    return { created: true, settlement: await this.get(ctx, made.s.id) };
  }

  async voidSettlement(ctx: AcademyContext, id: string, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      const s = await this.lock(tx, ctx, id);
      if (s.status === 'VOID')
        throw this.conflict('SETTLEMENT_VOID', 'This settlement is already void');
      if (s.paidCents > 0)
        throw this.conflict(
          'SETTLEMENT_HAS_PAYMENTS',
          'Payments were recorded — correct it with an adjustment instead',
        );
      await tx.teacherSettlement.update({
        where: { id },
        data: {
          status: 'VOID',
          voidedAt: new Date(),
          voidedBy: ctx.userId,
          voidReason: reason.trim(),
          version: { increment: 1 },
        },
      });
    });
    await this.log(ctx, 'settlement.void', 'TeacherSettlement', id, {});
    return this.get(ctx, id);
  }

  // ── Adjustments and payments ───────────────────────────────────────────

  async adjust(ctx: AcademyContext, id: string, dto: AdjustDto) {
    if (
      (dto.kind === 'BONUS' && dto.amountCents <= 0) ||
      (dto.kind === 'DEDUCTION' && dto.amountCents >= 0) ||
      dto.amountCents === 0
    )
      throw this.bad(
        'ADJUSTMENT_SIGN_INVALID',
        'A bonus adds, a deduction subtracts, and nothing is zero',
        'amountCents',
      );
    const done = await this.prisma.$transaction(async (tx) => {
      const s = await this.lock(tx, ctx, id);
      const prior = await tx.teacherSettlementAdjustment.findUnique({
        where: { academyId_requestKey: { academyId: ctx.academyId, requestKey: dto.requestKey } },
      });
      if (prior) {
        if (
          prior.settlementId !== id ||
          prior.amountCents !== dto.amountCents ||
          prior.kind !== dto.kind
        )
          throw this.conflict(
            'SETTLEMENT_KEY_REUSED',
            'This request key was already used for something else',
          );
        return { replayed: true };
      }
      if (s.status === 'VOID') throw this.conflict('SETTLEMENT_VOID', 'This settlement is void');
      const adjust = s.adjustCents + dto.amountCents;
      const payable = s.grossCents + adjust;
      if (payable < s.paidCents)
        throw this.conflict('SETTLEMENT_ADJUST_BELOW_PAID', 'More than that was already paid');
      if (payable < 0)
        throw this.conflict('ADJUSTMENT_BELOW_ZERO', 'A settlement cannot owe less than nothing');
      await tx.teacherSettlementAdjustment.create({
        data: {
          academyId: ctx.academyId,
          settlementId: id,
          kind: dto.kind,
          amountCents: dto.amountCents,
          reason: dto.reason.trim(),
          requestKey: dto.requestKey,
          createdBy: ctx.userId,
        },
      });
      await tx.teacherSettlement.update({
        where: { id },
        data: {
          adjustCents: adjust,
          status: this.statusOf(s.paidCents, payable),
          version: { increment: 1 },
        },
      });
      return { replayed: false };
    });
    // Ids and amounts only — never the reason.
    if (!done.replayed)
      await this.log(ctx, 'settlement.adjust', 'TeacherSettlement', id, {
        kind: dto.kind,
        amountCents: dto.amountCents,
      });
    return { replayed: done.replayed, settlement: await this.get(ctx, id) };
  }

  async pay(ctx: AcademyContext, id: string, dto: PayDto) {
    const done = await this.prisma.$transaction(async (tx) => {
      const s = await this.lock(tx, ctx, id);
      const prior = await tx.teacherSettlementPayment.findUnique({
        where: { academyId_requestKey: { academyId: ctx.academyId, requestKey: dto.requestKey } },
      });
      if (prior) {
        if (
          prior.settlementId !== id ||
          prior.amountCents !== dto.amountCents ||
          prior.method !== dto.method
        )
          throw this.conflict(
            'SETTLEMENT_KEY_REUSED',
            'This request key was already used for something else',
          );
        return { replayed: true };
      }
      if (s.status === 'VOID') throw this.conflict('SETTLEMENT_VOID', 'This settlement is void');
      const payable = s.grossCents + s.adjustCents;
      const paid = s.paidCents + dto.amountCents;
      if (paid > payable)
        throw new ConflictException({
          message: 'That is more than what is still owed',
          code: 'SETTLEMENT_OVERPAYMENT',
          remainingCents: payable - s.paidCents,
        });
      await tx.teacherSettlementPayment.create({
        data: {
          academyId: ctx.academyId,
          settlementId: id,
          amountCents: dto.amountCents,
          method: dto.method,
          reference: dto.reference?.trim() || null,
          requestKey: dto.requestKey,
          recordedBy: ctx.userId,
        },
      });
      await tx.teacherSettlement.update({
        where: { id },
        data: { paidCents: paid, status: this.statusOf(paid, payable), version: { increment: 1 } },
      });
      return { replayed: false };
    });
    if (!done.replayed)
      await this.log(ctx, 'settlement.pay', 'TeacherSettlement', id, {
        amountCents: dto.amountCents,
        method: dto.method,
      });
    return { replayed: done.replayed, settlement: await this.get(ctx, id) };
  }

  // ── Reading ────────────────────────────────────────────────────────────

  async list(ctx: AcademyContext, teacherUserId: string | undefined, page = 1) {
    const where: Prisma.TeacherSettlementWhereInput = {
      academyId: ctx.academyId,
      ...(teacherUserId ? { teacherUserId } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.teacherSettlement.count({ where }),
      this.prisma.teacherSettlement.findMany({
        where,
        orderBy: [{ periodFrom: 'desc' }, { finalizedAt: 'desc' }],
        skip: (page - 1) * PAGE,
        take: PAGE,
      }),
    ]);
    const names = await this.names(rows.map((r) => r.teacherUserId));
    return {
      total,
      page,
      pageSize: PAGE,
      items: rows.map((s) => ({
        ...this.settlementView(s),
        teacherName: names.get(s.teacherUserId) ?? '',
      })),
    };
  }

  /** One settlement: frozen lines, adjustments, payments — and what changed in the sources since. */
  async get(ctx: AcademyContext, id: string) {
    const s = await this.prisma.teacherSettlement.findFirst({
      where: { id, academyId: ctx.academyId },
      include: {
        lines: { orderBy: [{ kind: 'asc' }, { sourceId: 'asc' }] },
        adjustments: { orderBy: { createdAt: 'asc' } },
        payments: { orderBy: { paidAt: 'asc' } },
      },
    });
    if (!s)
      throw new NotFoundException({
        message: 'Settlement not found',
        code: 'SETTLEMENT_NOT_FOUND',
      });
    const names = await this.names([
      s.teacherUserId,
      s.finalizedBy,
      ...s.adjustments.map((a) => a.createdBy),
      ...s.payments.map((p) => p.recordedBy),
    ]);
    let drift: {
      added: Line[];
      removed: Line[];
      changed: { sourceId: string; was: number; now: number }[];
      deltaCents: number;
    } | null = null;
    if (s.status !== 'VOID') {
      const now = await this.compute(
        ctx.academyId,
        s.teacherUserId,
        day(s.periodFrom),
        day(s.periodTo),
      );
      const key = (l: { kind: string; sourceId: string }) => `${l.kind}:${l.sourceId}`;
      const frozen = new Map(s.lines.map((l) => [key(l), l]));
      const live = new Map(now.lines.map((l) => [key(l), l]));
      const added = now.lines.filter((l) => !frozen.has(key(l)));
      const removed = s.lines.filter((l) => !live.has(key(l))).map((l) => this.lineView(l));
      const changed = s.lines
        .filter((l) => live.has(key(l)) && live.get(key(l))!.amountCents !== l.amountCents)
        .map((l) => ({
          sourceId: l.sourceId,
          was: l.amountCents,
          now: live.get(key(l))!.amountCents,
        }));
      const deltaCents =
        added.reduce((n, l) => n + l.amountCents, 0) -
        removed.reduce((n, l) => n + l.amountCents, 0) +
        changed.reduce((n, c) => n + c.now - c.was, 0);
      drift =
        added.length || removed.length || changed.length
          ? { added, removed, changed, deltaCents }
          : null;
    }
    const { timezone } = await this.schedule.academyClock(ctx.academyId);
    return {
      ...this.settlementView(s),
      timezone,
      teacherName: names.get(s.teacherUserId) ?? '',
      finalizedByName: names.get(s.finalizedBy) ?? '',
      lines: s.lines.map((l) => this.lineView(l)),
      adjustments: s.adjustments.map((a) => ({
        id: a.id,
        kind: a.kind,
        amountCents: a.amountCents,
        reason: a.reason,
        createdAt: a.createdAt.toISOString(),
        by: names.get(a.createdBy) ?? '',
      })),
      payments: s.payments.map((p) => ({
        id: p.id,
        amountCents: p.amountCents,
        method: p.method,
        reference: p.reference,
        paidAt: p.paidAt.toISOString(),
        by: names.get(p.recordedBy) ?? '',
      })),
      drift,
    };
  }

  /** The statement as CSV — formula-looking cells defused, integer money as text. */
  async statementCsv(ctx: AcademyContext, id: string) {
    const s = await this.get(ctx, id);
    const cell = (v: string) => {
      let t = v;
      if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
      return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const money = (c: number) =>
      `${c < 0 ? '-' : ''}${Math.trunc(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`;
    const rows: string[][] = [
      ['teacher', s.teacherName],
      ['period', `${s.periodFrom} — ${s.periodTo}`],
      ['status', s.status],
      [],
      ['kind', 'date', 'source', 'detail', 'amount'],
      ...s.lines.map((l) => [
        l.kind,
        String(l.detail.startAt ?? l.detail.receivedAt ?? l.detail.from ?? '').slice(0, 10),
        l.kind === 'SESSION'
          ? String(l.detail.groupName ?? '')
          : l.kind === 'COLLECTION'
            ? String(l.detail.receiptNumber ?? '')
            : String(l.detail.month ?? ''),
        l.kind === 'COLLECTION'
          ? `${money(Number(l.detail.collectedCents))} × ${Number(l.detail.percentBps) / 100}%`
          : l.kind === 'FIXED'
            ? `${l.detail.coveredDays}/${l.detail.daysInMonth}`
            : '',
        money(l.amountCents),
      ]),
      [],
      ['gross', '', '', '', money(s.grossCents)],
      ...s.adjustments.map((a) => [
        a.kind,
        a.createdAt.slice(0, 10),
        '',
        a.reason,
        money(a.amountCents),
      ]),
      ['payable', '', '', '', money(s.payableCents)],
      ...s.payments.map((p) => [
        'PAYMENT',
        p.paidAt.slice(0, 10),
        p.method,
        p.reference ?? '',
        money(-p.amountCents),
      ]),
      ['remaining', '', '', '', money(s.remainingCents)],
    ];
    await this.log(ctx, 'settlement.export', 'TeacherSettlement', id, { lines: s.lines.length });
    return {
      filename: `settlement-${s.periodFrom}-${s.periodTo}.csv`,
      csv: '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n',
    };
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private statusOf(paid: number, payable: number): 'FINALIZED' | 'PARTIALLY_PAID' | 'PAID' {
    if (paid === 0) return 'FINALIZED';
    return paid === payable ? 'PAID' : 'PARTIALLY_PAID';
  }

  private assertPeriod(from: string, to: string, today: string) {
    if (to < from) throw this.bad('PERIOD_INVALID', 'The period ends before it starts', 'to');
    if (to > today)
      throw this.bad(
        'PERIOD_IN_FUTURE',
        'A settlement cannot include days that have not happened',
        'to',
      );
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
    if (days > MAX_PERIOD_DAYS)
      throw this.bad('PERIOD_TOO_LONG', 'A settlement covers at most three months', 'to');
  }

  /** The last day covered by a live settlement of this teacher, if any. */
  private async settledThrough(academyId: string, teacherUserId: string) {
    const s = await this.prisma.teacherSettlement.findFirst({
      where: { academyId, teacherUserId, status: { not: 'VOID' } },
      orderBy: { periodTo: 'desc' },
      select: { periodTo: true },
    });
    return s ? day(s.periodTo) : null;
  }

  private async lock(tx: Prisma.TransactionClient, ctx: AcademyContext, id: string) {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "TeacherSettlement" WHERE id = ${id} AND "academyId" = ${ctx.academyId} FOR UPDATE`;
    if (!row)
      throw new NotFoundException({
        message: 'Settlement not found',
        code: 'SETTLEMENT_NOT_FOUND',
      });
    return tx.teacherSettlement.findUniqueOrThrow({ where: { id } });
  }

  private async replayFinalize(prior: TeacherSettlement, dto: FinalizeDto) {
    if (
      prior.teacherUserId !== dto.teacherUserId ||
      day(prior.periodFrom) !== dto.from ||
      day(prior.periodTo) !== dto.to
    )
      throw this.conflict(
        'SETTLEMENT_KEY_REUSED',
        'This request key was already used for something else',
      );
    return {
      created: false,
      settlement: await this.get({ academyId: prior.academyId } as AcademyContext, prior.id),
    };
  }

  private translate(e: unknown) {
    const msg = e instanceof Error ? e.message : '';
    if (/overlapping teacher agreements/.test(msg))
      return this.conflict(
        'AGREEMENT_OVERLAP',
        'Another agreement of this kind already covers these dates and groups',
      );
    if (/TeacherSettlement_no_overlap|conflicting key value violates exclusion/.test(msg))
      return this.conflict('SETTLEMENT_OVERLAP', 'A settlement already covers part of that period');
    return e;
  }

  private conflict(code: string, message: string) {
    return new ConflictException({ message, code });
  }
  private bad(code: string, message: string, field?: string) {
    return new BadRequestException({ message, code, ...(field ? { field } : {}) });
  }

  private log(
    ctx: AcademyContext,
    action: string,
    entity: string,
    entityId: string,
    meta: Record<string, unknown>,
  ) {
    return this.audit.log({
      actorUserId: ctx.userId,
      action,
      entity,
      entityId,
      academyId: ctx.academyId,
      meta,
    });
  }

  private async names(ids: string[]) {
    const uniq = [...new Set(ids.filter(Boolean))];
    const users = uniq.length
      ? await this.prisma.user.findMany({
          where: { id: { in: uniq } },
          select: { id: true, fullName: true },
        })
      : [];
    return new Map(users.map((u) => [u.id, u.fullName ?? '']));
  }

  private agreementView(a: TeacherAgreement) {
    return {
      id: a.id,
      teacherUserId: a.teacherUserId,
      method: a.method,
      currency: a.currency,
      rateCents: a.rateCents,
      percentBps: a.percentBps,
      groupIds: a.groupIds,
      effectiveFrom: day(a.effectiveFrom),
      effectiveTo: a.effectiveTo ? day(a.effectiveTo) : null,
      ended: !!a.endedAt,
    };
  }

  private settlementView(s: TeacherSettlement) {
    const payable = s.grossCents + s.adjustCents;
    return {
      id: s.id,
      teacherUserId: s.teacherUserId,
      periodFrom: day(s.periodFrom),
      periodTo: day(s.periodTo),
      currency: s.currency,
      status: s.status,
      grossCents: s.grossCents,
      adjustCents: s.adjustCents,
      payableCents: payable,
      paidCents: s.paidCents,
      remainingCents: s.status === 'VOID' ? 0 : payable - s.paidCents,
      finalizedAt: s.finalizedAt.toISOString(),
      voidedAt: s.voidedAt?.toISOString() ?? null,
      voidReason: s.voidReason,
      version: s.version,
    };
  }

  private lineView(l: {
    kind: string;
    sourceId: string;
    agreementId: string;
    amountCents: number;
    detail: Prisma.JsonValue;
  }): Line {
    return {
      kind: l.kind as Line['kind'],
      sourceId: l.sourceId,
      agreementId: l.agreementId,
      amountCents: l.amountCents,
      detail: (l.detail ?? {}) as Record<string, unknown>,
    };
  }
}
