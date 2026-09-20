import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AcademyMembershipGuard } from '../academy/guards/academy-membership.guard';
import { AcademyContext, CurrentAcademy } from '../academy/academy-context';
import { SessionsService } from './sessions.service';

const MAX_RANGE_DAYS = 92; // roughly a school term — a bounded calendar query, never "everything"

@ApiTags('academy/schedule')
@ApiBearerAuth()
@Controller('academies/:slug')
export class ScheduleController {
  constructor(private readonly sessions: SessionsService) {}

  /** Any ACTIVE member of the academy — owner, staff, or student — sees the
   *  schedule, each scoped to what they're allowed to see (see
   *  SessionsService.schedule). No capability required, only membership. */
  @Get('schedule')
  @UseGuards(AcademyMembershipGuard)
  @ApiOperation({ summary: '[academy] Sessions in a date range — role-scoped' })
  schedule(@CurrentAcademy() ctx: AcademyContext, @Query('from') from?: string, @Query('to') to?: string) {
    if (!from || !to) throw new BadRequestException('from and to are required');
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || !(toDate > fromDate)) {
      throw new BadRequestException('Invalid date range');
    }
    if (toDate.getTime() - fromDate.getTime() > MAX_RANGE_DAYS * 86_400_000) {
      throw new BadRequestException(`Range too wide — max ${MAX_RANGE_DAYS} days`);
    }
    return this.sessions.schedule(ctx, fromDate, toDate);
  }
}
