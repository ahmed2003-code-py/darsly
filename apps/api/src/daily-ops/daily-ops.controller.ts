import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AcademyContext, CurrentAcademy } from '../academy/academy-context';
import { AcademyMembershipGuard } from '../academy/guards/academy-membership.guard';
import { AcademyStaffFeature } from '../feature-flags/academy-staff-feature.decorator';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { DailyOpsService } from './daily-ops.service';
import { CloseDayDto, DayQuery } from './dto';

/**
 * The day's operations and its close (Center Operations C7). Every route but
 * the access probe sits behind @AcademyStaffFeature: an ACTIVE membership in
 * the academy named by X-Academy-Id, the capability, and the dailyOperations
 * flag. Reading needs daily.view; closing daily.close. Money, follow-up and
 * exam sections are further limited to fees.report / followup.view / an
 * all-groups grades.view.
 */
@ApiTags('daily-ops')
@ApiBearerAuth()
@Controller('daily-ops')
export class DailyOpsController {
  constructor(
    private readonly ops: DailyOpsService,
    private readonly flags: FeatureFlagsService,
  ) {}

  @Get('access')
  @UseGuards(AcademyMembershipGuard)
  @ApiOperation({ summary: "[academy] Is the day's operations page on here, and what may I do" })
  async access(@CurrentAcademy() ctx: AcademyContext) {
    const enabled = await this.flags.isEnabled(ctx.academyId, 'dailyOperations');
    return {
      enabled,
      canView: enabled && ctx.can('daily.view'),
      canClose: enabled && ctx.can('daily.view') && ctx.can('daily.close'),
    };
  }

  @Get('day')
  @AcademyStaffFeature('daily.view', 'dailyOperations')
  @ApiOperation({
    summary: "[academy] One business day's operations (default today) and its closes",
  })
  day(@CurrentAcademy() ctx: AcademyContext, @Query() q: DayQuery) {
    return this.ops.day(ctx, q.date);
  }

  @Post('close')
  @HttpCode(200)
  @AcademyStaffFeature('daily.close', 'dailyOperations')
  @ApiOperation({
    summary: '[academy] Close a business day (a versioned snapshot; safe to repeat)',
  })
  close(@CurrentAcademy() ctx: AcademyContext, @Body() dto: CloseDayDto) {
    return this.ops.close(ctx, dto);
  }
}
