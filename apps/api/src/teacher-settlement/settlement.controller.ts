import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
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
import {
  AdjustDto,
  CreateAgreementDto,
  EndAgreementDto,
  FinalizeDto,
  ListQuery,
  PayDto,
  PeriodQuery,
  VoidDto,
} from './dto';
import { TeacherSettlementService } from './settlement.service';

/**
 * What the center owes and pays its teachers (Center Operations C8). Every
 * route but the access probe sits behind @AcademyStaffFeature: an ACTIVE
 * membership in the academy named by X-Academy-Id, the capability, and the
 * teacherSettlement flag. Reading needs settlement.view; agreements and
 * adjustments settlement.manage; finalizing and voiding settlement.finalize;
 * recording a payment settlement.pay. None is a role default.
 */
@ApiTags('teacher-settlement')
@ApiBearerAuth()
@Controller('teacher-settlement')
export class TeacherSettlementController {
  constructor(
    private readonly settlements: TeacherSettlementService,
    private readonly flags: FeatureFlagsService,
  ) {}

  @Get('access')
  @UseGuards(AcademyMembershipGuard)
  @ApiOperation({ summary: '[academy] Are teacher settlements on here, and what may I do' })
  async access(@CurrentAcademy() ctx: AcademyContext) {
    const enabled = await this.flags.isEnabled(ctx.academyId, 'teacherSettlement');
    const can = (c: Parameters<AcademyContext['can']>[0]) =>
      enabled && ctx.can('settlement.view') && ctx.can(c);
    return {
      enabled,
      canView: can('settlement.view'),
      canManage: can('settlement.manage'),
      canFinalize: can('settlement.finalize'),
      canPay: can('settlement.pay'),
    };
  }

  @Get('teachers')
  @AcademyStaffFeature('settlement.view', 'teacherSettlement')
  @ApiOperation({ summary: '[academy] Teachers and their pay agreements' })
  teachers(@CurrentAcademy() ctx: AcademyContext) {
    return this.settlements.teachers(ctx);
  }

  @Get('groups')
  @AcademyStaffFeature('settlement.view', 'teacherSettlement')
  @ApiOperation({ summary: "[academy] Groups, for an agreement's scope" })
  groups(@CurrentAcademy() ctx: AcademyContext) {
    return this.settlements.groups(ctx);
  }

  @Post('agreements')
  @AcademyStaffFeature('settlement.manage', 'teacherSettlement')
  @ApiOperation({ summary: '[academy] A pay agreement from a date (idempotent by request key)' })
  createAgreement(@CurrentAcademy() ctx: AcademyContext, @Body() dto: CreateAgreementDto) {
    return this.settlements.createAgreement(ctx, dto);
  }

  @Post('agreements/:id/end')
  @HttpCode(200)
  @AcademyStaffFeature('settlement.manage', 'teacherSettlement')
  @ApiOperation({ summary: '[academy] End an agreement on a date (a new rate is a new agreement)' })
  endAgreement(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Body() dto: EndAgreementDto,
  ) {
    return this.settlements.endAgreement(ctx, id, dto.effectiveTo);
  }

  @Get('preview')
  @AcademyStaffFeature('settlement.view', 'teacherSettlement')
  @ApiOperation({ summary: '[academy] What a teacher would be paid for a period (writes nothing)' })
  preview(@CurrentAcademy() ctx: AcademyContext, @Query() q: PeriodQuery) {
    return this.settlements.preview(ctx, q.teacherUserId, q.from, q.to);
  }

  @Get('settlements')
  @AcademyStaffFeature('settlement.view', 'teacherSettlement')
  @ApiOperation({ summary: '[academy] Finalized settlements' })
  list(@CurrentAcademy() ctx: AcademyContext, @Query() q: ListQuery) {
    return this.settlements.list(ctx, q.teacherUserId, q.page ?? 1);
  }

  @Post('settlements')
  @AcademyStaffFeature('settlement.finalize', 'teacherSettlement')
  @ApiOperation({ summary: '[academy] Finalize a settlement (frozen; safe to repeat)' })
  finalize(@CurrentAcademy() ctx: AcademyContext, @Body() dto: FinalizeDto) {
    return this.settlements.finalize(ctx, dto);
  }

  @Get('settlements/:id')
  @AcademyStaffFeature('settlement.view', 'teacherSettlement')
  @ApiOperation({ summary: '[academy] One settlement: frozen lines, adjustments, payments, drift' })
  get(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    return this.settlements.get(ctx, id);
  }

  @Post('settlements/:id/void')
  @HttpCode(200)
  @AcademyStaffFeature('settlement.finalize', 'teacherSettlement')
  @ApiOperation({ summary: '[academy] Void an unpaid settlement, with a reason' })
  voidSettlement(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Body() dto: VoidDto,
  ) {
    return this.settlements.voidSettlement(ctx, id, dto.reason);
  }

  @Post('settlements/:id/adjustments')
  @AcademyStaffFeature('settlement.manage', 'teacherSettlement')
  @ApiOperation({ summary: '[academy] A bonus, deduction or correction, with a reason' })
  adjust(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string, @Body() dto: AdjustDto) {
    return this.settlements.adjust(ctx, id, dto);
  }

  @Post('settlements/:id/payments')
  @AcademyStaffFeature('settlement.pay', 'teacherSettlement')
  @ApiOperation({ summary: '[academy] Record that the center paid the teacher (never a payout)' })
  pay(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string, @Body() dto: PayDto) {
    return this.settlements.pay(ctx, id, dto);
  }

  @Get('settlements/:id/statement')
  @AcademyStaffFeature('settlement.view', 'teacherSettlement')
  @ApiOperation({ summary: '[academy] The settlement statement as CSV' })
  async statement(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const { filename, csv } = await this.settlements.statementCsv(ctx, id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  }
}
