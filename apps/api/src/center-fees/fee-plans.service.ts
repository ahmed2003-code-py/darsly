import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CenterFeePlan } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AcademyContext } from '../academy/academy-context';
import { AuditService } from '../audit/audit.service';
import { ClassScheduleService } from '../class-ops/class-schedule.service';
import { dateValue, localDayBounds, wallClock } from '../class-ops/zoned-time';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePlanDto, UpdatePlanDto } from './dto';

/** How far back the per-session generator looks (it runs every half hour). */
const SESSION_LOOKBACK_DAYS = 62;

/** An instant as a UTC `timestamp` literal, so SQL compares it column-to-column (C2's lesson). */
export const utc = (d: Date) => d.toISOString();

/**
 * Center Operations C4 — fee plans and the charges they post.
 *
 * A plan belongs to one group: WHY a learner owes is always "they are in
 * group G, whose plan is P". Two kinds:
 *
 *  MONTHLY — one charge per learner per local month. Owed by whoever is in
 *  the group on the month's ANCHOR DAY: the 1st, or the plan's start day in
 *  the month it starts. Full month, no proration. A learner who joins later in
 *  the month owes nothing for it automatically ("add this month's fee" posts
 *  it on purpose); one who transfers mid-month keeps the month already posted
 *  in the old group and follows the new group from the next month; one
 *  withdrawn before the anchor day owes no further months. Due on the plan's
 *  due day, or on the anchor day if that is later. Only the CURRENT month is
 *  ever posted — never ahead, never back.
 *
 *  PER_SESSION — one charge per class actually attended (PRESENT or LATE) in
 *  the plan's own group, from the plan's start. Absences, excused absences,
 *  cancelled classes and makeups (a guest in another group's class) are not
 *  charged. Due on the class's local date.
 *
 * A plan can never start before the day it is made, so turning C4 on, or
 * creating a plan, never back-charges anyone. Posting is idempotent: the
 * partial unique indexes (plan, learner, month) and (plan, learner, class)
 * make any repeat — two replicas, a retry, a page load — post nothing new.
 * The amount is frozen into each charge; changing the plan only affects what
 * is posted afterwards.
 */
@Injectable()
export class FeePlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly schedule: ClassScheduleService,
    private readonly audit: AuditService,
  ) {}

  async list(ctx: AcademyContext) {
    const plans = await this.prisma.centerFeePlan.findMany({
      where: { academyId: ctx.academyId },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      include: {
        group: { select: { id: true, name: true } },
        _count: { select: { charges: true } },
      },
    });
    return plans.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      amountCents: p.amountCents,
      currency: p.currency,
      dueDay: p.dueDay,
      startsOn: p.startsOn.toISOString().slice(0, 10),
      status: p.status,
      group: p.group,
      charges: p._count.charges,
    }));
  }

  async create(ctx: AcademyContext, dto: CreatePlanDto) {
    const group = await this.prisma.group.findFirst({
      where: { id: dto.groupId, academyId: ctx.academyId, deletedAt: null },
      select: { id: true },
    });
    if (!group)
      throw new NotFoundException({ message: 'Group not found', code: 'GROUP_NOT_FOUND' });
    const clock = await this.schedule.academyClock(ctx.academyId);
    const startsOn = dto.startsOn ?? clock.today;
    if (startsOn < clock.today)
      throw new BadRequestException({
        message: 'A plan cannot start in the past',
        code: 'PLAN_START_IN_PAST',
      });
    if (dto.type === 'MONTHLY' && dto.dueDay == null) dto.dueDay = 1;
    if (dto.type === 'PER_SESSION' && dto.dueDay != null)
      throw new BadRequestException({
        message: 'A per-class plan has no due day',
        code: 'VALIDATION_FAILED',
      });
    const academy = await this.prisma.academy.findUniqueOrThrow({
      where: { id: ctx.academyId },
      select: { currency: true },
    });
    const plan = await this.prisma.centerFeePlan.create({
      data: {
        academyId: ctx.academyId,
        groupId: group.id,
        name: dto.name.trim(),
        type: dto.type,
        amountCents: dto.amountCents,
        currency: academy.currency,
        dueDay: dto.dueDay ?? null,
        startsOn: dateValue(startsOn),
        createdBy: ctx.userId,
      },
    });
    await this.audit.log({
      actorUserId: ctx.userId,
      action: 'fees.plan.create',
      entity: 'CenterFeePlan',
      entityId: plan.id,
      academyId: ctx.academyId,
      meta: {
        groupId: group.id,
        type: plan.type,
        amountCents: plan.amountCents,
        currency: plan.currency,
        startsOn,
      },
    });
    const posted = await this.generatePlan(plan);
    return { ...(await this.list(ctx)).find((p) => p.id === plan.id)!, posted };
  }

  async update(ctx: AcademyContext, planId: string, dto: UpdatePlanDto) {
    const plan = await this.planIn(ctx, planId);
    if (plan.type === 'PER_SESSION' && dto.dueDay != null)
      throw new BadRequestException({
        message: 'A per-class plan has no due day',
        code: 'VALIDATION_FAILED',
      });
    const updated = await this.prisma.centerFeePlan.update({
      where: { id: plan.id },
      data: {
        ...(dto.name != null ? { name: dto.name.trim() } : {}),
        ...(dto.amountCents != null ? { amountCents: dto.amountCents } : {}),
        ...(dto.dueDay != null ? { dueDay: dto.dueDay } : {}),
        ...(dto.status != null ? { status: dto.status } : {}),
      },
    });
    await this.audit.log({
      actorUserId: ctx.userId,
      action: dto.status === 'ARCHIVED' ? 'fees.plan.archive' : 'fees.plan.update',
      entity: 'CenterFeePlan',
      entityId: plan.id,
      academyId: ctx.academyId,
      meta: {
        before: { amountCents: plan.amountCents, dueDay: plan.dueDay, status: plan.status },
        after: { amountCents: updated.amountCents, dueDay: updated.dueDay, status: updated.status },
      },
    });
    return (await this.list(ctx)).find((p) => p.id === plan.id)!;
  }

  /** Post what is due now for one plan (owner's "generate"); safe to repeat. */
  async generate(ctx: AcademyContext, planId: string) {
    const plan = await this.planIn(ctx, planId);
    return { posted: await this.generatePlan(plan) };
  }

  /** Every active plan of an academy (worker sweep / top-up on read). */
  async generateAcademy(academyId: string) {
    const plans = await this.prisma.centerFeePlan.findMany({
      where: { academyId, status: 'ACTIVE' },
    });
    let posted = 0;
    for (const p of plans) posted += await this.generatePlan(p);
    return posted;
  }

  /**
   * "Add this month's fee": a learner who joined the group after the month's
   * anchor day, charged for the current month on purpose. Only while they
   * are in the plan's group and active; idempotent (the month is owed once).
   */
  async monthlyForStudent(ctx: AcademyContext, academyStudentId: string, planId: string) {
    const plan = await this.planIn(ctx, planId);
    if (plan.type !== 'MONTHLY' || plan.status !== 'ACTIVE')
      throw new ConflictException({
        message: 'Not an active monthly plan',
        code: 'PLAN_NOT_MONTHLY',
      });
    const s = await this.prisma.academyStudent.findFirst({
      where: { id: academyStudentId, academyId: ctx.academyId },
      select: { id: true, studentId: true, status: true },
    });
    if (!s)
      throw new NotFoundException({ message: 'Student not found', code: 'STUDENT_NOT_FOUND' });
    if (s.status !== 'ACTIVE')
      throw new ConflictException({
        message: 'This student has withdrawn',
        code: 'STUDENT_WITHDRAWN',
      });
    const member = await this.prisma.groupMembership.findFirst({
      where: {
        groupId: plan.groupId,
        studentId: s.studentId,
        academyId: ctx.academyId,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!member)
      throw new ConflictException({
        message: 'This student is not in the plan’s group',
        code: 'NOT_IN_GROUP',
      });
    const clock = await this.schedule.academyClock(ctx.academyId);
    const period = clock.today.slice(0, 7);
    const startDay = plan.startsOn.toISOString().slice(0, 10);
    if (startDay > clock.today)
      throw new ConflictException({
        message: 'This plan has not started yet',
        code: 'PLAN_NOT_STARTED',
      });
    const anchor = startDay.slice(0, 7) === period ? startDay : `${period}-01`;
    const res = await this.prisma.centerCharge.createMany({
      data: [this.monthlyRow(plan, s.id, period, anchor)],
      skipDuplicates: true,
    });
    if (res.count)
      await this.audit.log({
        actorUserId: ctx.userId,
        action: 'fees.charge.monthly',
        entity: 'CenterFeePlan',
        entityId: plan.id,
        academyId: ctx.academyId,
        meta: { academyStudentId: s.id, period, amountCents: plan.amountCents },
      });
    return { posted: res.count };
  }

  // ── Generation ──────────────────────────────────────────────────────────

  async generatePlan(plan: CenterFeePlan, opts: { today?: string } = {}): Promise<number> {
    if (plan.status !== 'ACTIVE') return 0;
    const group = await this.prisma.group.findUnique({
      where: { id: plan.groupId },
      select: { deletedAt: true, status: true },
    });
    if (!group || group.deletedAt || group.status !== 'ACTIVE') return 0;
    const clock = await this.schedule.academyClock(plan.academyId);
    const today = opts.today ?? clock.today;
    return plan.type === 'MONTHLY'
      ? this.postMonth(plan, today, clock.timezone)
      : this.postSessions(plan, clock.timezone);
  }

  /** The current local month for a monthly plan: members on its anchor day. */
  private async postMonth(plan: CenterFeePlan, today: string, timezone: string) {
    const period = today.slice(0, 7);
    const startDay = plan.startsOn.toISOString().slice(0, 10);
    if (startDay > today) return 0; // not started
    const anchor = startDay.slice(0, 7) === period ? startDay : `${period}-01`;
    if (anchor > today) return 0;
    const { start, end } = localDayBounds(anchor, timezone);
    // In the group at some moment of the anchor day, and not withdrawn before it.
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT s.id
      FROM "GroupMembership" m
      JOIN "AcademyStudent" s ON s."academyId" = m."academyId" AND s."studentId" = m."studentId"
      WHERE m."groupId" = ${plan.groupId} AND m."academyId" = ${plan.academyId}
        AND m."addedAt" < (${utc(end)}::timestamptz AT TIME ZONE 'UTC')
        AND (m."deletedAt" IS NULL OR m."deletedAt" > (${utc(start)}::timestamptz AT TIME ZONE 'UTC'))
        AND (s.status = 'ACTIVE' OR s."leftAt" > (${utc(start)}::timestamptz AT TIME ZONE 'UTC'))`;
    if (!rows.length) return 0;
    const res = await this.prisma.centerCharge.createMany({
      data: rows.map((r) => this.monthlyRow(plan, r.id, period, anchor)),
      skipDuplicates: true,
    });
    return res.count;
  }

  private monthlyRow(
    plan: CenterFeePlan,
    academyStudentId: string,
    period: string,
    anchor: string,
  ) {
    const due = `${period}-${String(plan.dueDay ?? 1).padStart(2, '0')}`;
    return {
      id: randomUUID(),
      academyId: plan.academyId,
      academyStudentId,
      kind: 'MONTHLY' as const,
      planId: plan.id,
      period,
      description: plan.name,
      amountCents: plan.amountCents,
      currency: plan.currency,
      // Due on the plan's day of the month — or the anchor day, if that is later.
      dueOn: dateValue(due < anchor ? anchor : due),
    };
  }

  /** Classes attended (PRESENT / LATE) in the plan's group since it started. */
  private async postSessions(plan: CenterFeePlan, timezone: string) {
    const startDay = plan.startsOn.toISOString().slice(0, 10);
    const since = localDayBounds(startDay, timezone).start;
    const lookback = new Date(Date.now() - SESSION_LOOKBACK_DAYS * 86_400_000);
    const from = since > lookback ? since : lookback;
    const rows = await this.prisma.$queryRaw<
      { studentId: string; sessionId: string; startAt: Date }[]
    >`
      SELECT s.id AS "studentId", gs.id AS "sessionId", gs."startAt"
      FROM "GroupSession" gs
      JOIN "AttendanceSession" sh ON sh."groupSessionId" = gs.id AND sh."deletedAt" IS NULL
      JOIN "AttendanceRecord" r ON r."sessionId" = sh.id AND r."deletedAt" IS NULL
      JOIN "AcademyStudent" s ON s."academyId" = gs."academyId" AND s."studentId" = r."studentId"
      WHERE gs."groupId" = ${plan.groupId} AND gs."academyId" = ${plan.academyId}
        AND gs.status <> 'CANCELLED'
        AND gs."startAt" >= (${utc(from)}::timestamptz AT TIME ZONE 'UTC')
        AND r.status IN ('PRESENT', 'LATE')
        AND r."homeGroupId" IS NULL`;
    if (!rows.length) return 0;
    const res = await this.prisma.centerCharge.createMany({
      data: rows.map((r) => ({
        id: randomUUID(),
        academyId: plan.academyId,
        academyStudentId: r.studentId,
        kind: 'PER_SESSION' as const,
        planId: plan.id,
        groupSessionId: r.sessionId,
        description: plan.name,
        amountCents: plan.amountCents,
        currency: plan.currency,
        dueOn: dateValue(wallClock(r.startAt, timezone).date),
      })),
      skipDuplicates: true,
    });
    return res.count;
  }

  private async planIn(ctx: AcademyContext, planId: string) {
    const plan = await this.prisma.centerFeePlan.findFirst({
      where: { id: planId, academyId: ctx.academyId },
    });
    if (!plan) throw new NotFoundException({ message: 'Plan not found', code: 'PLAN_NOT_FOUND' });
    return plan;
  }
}
