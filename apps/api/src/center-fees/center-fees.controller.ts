import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AcademyContext, CurrentAcademy } from '../academy/academy-context';
import { AcademyMembershipGuard } from '../academy/guards/academy-membership.guard';
import { AcademyStaffFeature } from '../feature-flags/academy-staff-feature.decorator';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { PrismaService } from '../prisma/prisma.service';
import { CenterFeesService } from './center-fees.service';
import {
  AdjustDto,
  CollectDto,
  CreatePlanDto,
  DayQuery,
  MonthlyForStudentDto,
  OneTimeChargeDto,
  OutstandingQuery,
  PreviewDto,
  ReasonDto,
  UpdatePlanDto,
} from './dto';
import { FeePlansService } from './fee-plans.service';

/** A local generation top-up per academy at most this often, on reads. */
const TOP_UP_EVERY_MS = 10 * 60_000;

/**
 * The center's own fees (Center Operations C4).
 *
 * Every route but `access` sits behind @AcademyStaffFeature: an ACTIVE
 * membership in the academy named by X-Academy-Id, the capability, and the
 * `centerFees` flag. Reading needs fees.view; taking money fees.collect;
 * plans, one-time charges and voids fees.manage; discounts and corrections
 * fees.adjust; reversals fees.reverse; everyone's day and exports fees.report.
 */
@ApiTags('center-fees')
@ApiBearerAuth()
@Controller('center-fees')
export class CenterFeesController {
  private readonly toppedUp = new Map<string, number>();

  constructor(
    private readonly fees: CenterFeesService,
    private readonly plans: FeePlansService,
    private readonly flags: FeatureFlagsService,
    private readonly prisma: PrismaService,
  ) {}

  /** Post anything due now before answering a read (bounded, idempotent). */
  private async topUp(academyId: string) {
    if (Date.now() - (this.toppedUp.get(academyId) ?? 0) < TOP_UP_EVERY_MS) return;
    this.toppedUp.set(academyId, Date.now());
    await this.plans.generateAcademy(academyId);
  }

  @Get('access')
  @UseGuards(AcademyMembershipGuard)
  @ApiOperation({ summary: '[academy] Are center fees on here, and what may I do' })
  async access(@CurrentAcademy() ctx: AcademyContext) {
    const enabled = await this.flags.isEnabled(ctx.academyId, 'centerFees');
    const can = (c: Parameters<AcademyContext['can']>[0]) => enabled && ctx.can(c);
    return {
      enabled,
      canView: can('fees.view'),
      canCollect: can('fees.collect') && can('fees.view'),
      canManage: can('fees.manage'),
      canAdjust: can('fees.adjust'),
      canReverse: can('fees.reverse'),
      canReport: can('fees.report'),
      currency: enabled ? await this.fees.currencyOf(ctx.academyId) : null,
    };
  }

  // ── Plans ──

  @Get('plans')
  @AcademyStaffFeature('fees.view', 'centerFees')
  @ApiOperation({ summary: '[academy] Fee plans' })
  listPlans(@CurrentAcademy() ctx: AcademyContext) {
    return this.plans.list(ctx);
  }

  @Post('plans')
  @AcademyStaffFeature('fees.manage', 'centerFees')
  @ApiOperation({ summary: '[academy] Create a fee plan for a group (posts what is due now)' })
  createPlan(@CurrentAcademy() ctx: AcademyContext, @Body() dto: CreatePlanDto) {
    return this.plans.create(ctx, dto);
  }

  @Patch('plans/:id')
  @AcademyStaffFeature('fees.manage', 'centerFees')
  @ApiOperation({
    summary: '[academy] Change or archive a plan (posted charges keep their amount)',
  })
  updatePlan(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Body() dto: UpdatePlanDto,
  ) {
    return this.plans.update(ctx, id, dto);
  }

  @Post('plans/:id/generate')
  @HttpCode(200)
  @AcademyStaffFeature('fees.manage', 'centerFees')
  @ApiOperation({ summary: '[academy] Post what this plan has due now (safe to repeat)' })
  generate(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    return this.plans.generate(ctx, id);
  }

  @Get('groups')
  @AcademyStaffFeature('fees.manage', 'centerFees')
  @ApiOperation({ summary: '[academy] Active groups, for a plan' })
  groups(@CurrentAcademy() ctx: AcademyContext) {
    return this.prisma.group.findMany({
      where: { academyId: ctx.academyId, deletedAt: null, status: 'ACTIVE' },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  // ── Who owes, what came in ──

  @Get('outstanding')
  @AcademyStaffFeature('fees.view', 'centerFees')
  @ApiOperation({ summary: '[academy] Learners with dues (search, filter, paged)' })
  async outstanding(@CurrentAcademy() ctx: AcademyContext, @Query() q: OutstandingQuery) {
    await this.topUp(ctx.academyId);
    return this.fees.outstanding(ctx, q);
  }

  @Get('collections')
  @AcademyStaffFeature('fees.view', 'centerFees')
  @ApiOperation({
    summary: "[academy] A day's recorded collections (all with fees.report, else my own)",
  })
  day(@CurrentAcademy() ctx: AcademyContext, @Query() q: DayQuery) {
    return this.fees.day(ctx, q.date, q.page ?? 1);
  }

  @Get('outstanding/export')
  @AcademyStaffFeature('fees.report', 'centerFees')
  @ApiOperation({ summary: '[academy] Dues as CSV' })
  async exportOutstanding(@CurrentAcademy() ctx: AcademyContext, @Res() res: Response) {
    const rows: string[][] = [['code', 'name', 'outstanding', 'overdue', 'paid', 'oldest_due']];
    for (let page = 1; page < 1_000; page++) {
      const r = await this.fees.outstanding(ctx, { status: 'OWING', page });
      for (const i of r.items)
        rows.push([
          i.code,
          i.fullName,
          cents(i.outstanding),
          cents(i.overdue),
          cents(i.paid),
          i.oldestDue ?? '',
        ]);
      if (page * r.pageSize >= r.total) break;
    }
    csv(res, 'dues', rows);
  }

  @Get('collections/export')
  @AcademyStaffFeature('fees.report', 'centerFees')
  @ApiOperation({ summary: "[academy] A day's collections as CSV" })
  async exportDay(
    @CurrentAcademy() ctx: AcademyContext,
    @Query() q: DayQuery,
    @Res() res: Response,
  ) {
    const rows: string[][] = [
      ['receipt', 'time', 'code', 'name', 'amount', 'method', 'collector', 'reversed'],
    ];
    for (let page = 1; page < 1_000; page++) {
      const r = await this.fees.day(ctx, q.date, page);
      for (const k of r.items)
        rows.push([
          k.receiptNumber,
          k.receivedAt,
          k.student.code,
          k.student.fullName,
          cents(k.amountCents),
          k.method,
          k.collector,
          k.reversedAt ? 'yes' : '',
        ]);
      if (page * r.pageSize >= r.total) break;
    }
    csv(res, `collections-${q.date ?? 'today'}`, rows);
  }

  // ── One learner ──

  @Get('students/:id/summary')
  @AcademyStaffFeature('fees.view', 'centerFees')
  @ApiOperation({ summary: '[academy] Owed / overdue / next due (the desk strip)' })
  async summary(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    await this.topUp(ctx.academyId);
    return this.fees.summary(ctx, id);
  }

  @Get('students/:id')
  @AcademyStaffFeature('fees.view', 'centerFees')
  @ApiOperation({ summary: "[academy] A learner's charges, adjustments and collections" })
  async student(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    await this.topUp(ctx.academyId);
    return this.fees.student(ctx, id);
  }

  @Get('students/:id/statement')
  @AcademyStaffFeature('fees.view', 'centerFees')
  @ApiOperation({ summary: '[academy] Chronological statement with the running balance' })
  statement(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    return this.fees.statement(ctx, id);
  }

  @Post('students/:id/collections/preview')
  @HttpCode(200)
  @AcademyStaffFeature('fees.collect', 'centerFees')
  @ApiOperation({ summary: '[academy] What a collection would pay (writes nothing)' })
  preview(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string, @Body() dto: PreviewDto) {
    return this.fees.preview(ctx, id, dto);
  }

  @Post('students/:id/collections')
  @AcademyStaffFeature('fees.collect', 'centerFees')
  @ApiOperation({
    summary: '[academy] Record money received; returns the receipt (safe to repeat)',
  })
  collect(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string, @Body() dto: CollectDto) {
    return this.fees.collect(ctx, id, dto);
  }

  @Post('students/:id/charges')
  @AcademyStaffFeature('fees.manage', 'centerFees')
  @ApiOperation({ summary: '[academy] A one-time charge (registration, book, exam…)' })
  oneTime(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Body() dto: OneTimeChargeDto,
  ) {
    return this.fees.oneTime(ctx, id, dto);
  }

  @Post('students/:id/monthly')
  @HttpCode(200)
  @AcademyStaffFeature('fees.manage', 'centerFees')
  @ApiOperation({
    summary: "[academy] Add this month's fee for a learner who joined after the 1st",
  })
  monthly(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Body() dto: MonthlyForStudentDto,
  ) {
    return this.plans.monthlyForStudent(ctx, id, dto.planId);
  }

  // ── Receipts and corrections ──

  @Get('collections/:id')
  @AcademyStaffFeature('fees.view', 'centerFees')
  @ApiOperation({ summary: '[academy] A receipt' })
  receipt(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    return this.fees.receipt(ctx, id);
  }

  @Post('collections/:id/reverse')
  @HttpCode(200)
  @AcademyStaffFeature('fees.reverse', 'centerFees')
  @ApiOperation({
    summary: '[academy] Reverse a collection recorded by mistake (kept, marked reversed)',
  })
  reverse(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string, @Body() dto: ReasonDto) {
    return this.fees.reverse(ctx, id, dto.reason);
  }

  @Post('charges/:id/adjustments')
  @AcademyStaffFeature('fees.adjust', 'centerFees')
  @ApiOperation({ summary: '[academy] A discount or a correction, with its reason' })
  adjust(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string, @Body() dto: AdjustDto) {
    return this.fees.adjust(ctx, id, dto);
  }

  @Post('charges/:id/void')
  @HttpCode(200)
  @AcademyStaffFeature('fees.manage', 'centerFees')
  @ApiOperation({
    summary: '[academy] Void a charge posted by mistake (only with no money against it)',
  })
  voidCharge(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Body() dto: ReasonDto,
  ) {
    return this.fees.voidCharge(ctx, id, dto.reason);
  }
}

/** Minor units as a plain decimal string, for a spreadsheet: 50000 → "500.00". */
function cents(n: number): string {
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  return `${sign}${Math.trunc(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

function csv(res: Response, name: string, rows: string[][]) {
  // Spreadsheet-formula injection: a cell starting with = + - @ is quoted as text.
  const cell = (v: string) => {
    const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send('﻿' + rows.map((r) => r.map(cell).join(',')).join('\n'));
}
