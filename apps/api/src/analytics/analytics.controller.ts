import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AcademyContext, CurrentAcademy } from '../academy/academy-context';
import { AcademyStaff } from '../academy/academy-staff.decorator';
import { AnalyticsRange, isAnalyticsRange } from './analytics.constants';
import { AnalyticsService } from './analytics.service';

function parseRange(raw?: string): AnalyticsRange {
  const n = raw ? Number(raw) : 30;
  if (!isAnalyticsRange(n)) throw new BadRequestException('range must be one of 7, 30, 90');
  return n;
}

@ApiTags('analytics')
@AcademyStaff('analytics.read')
@Controller('teacher/analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get()
  @ApiOperation({ summary: '[academy] Teaching KPIs + revenue/enrollment trends' })
  overview(@CurrentAcademy() ctx: AcademyContext) {
    return this.analytics.teacherOverview(ctx.academyId);
  }

  @Get('students')
  @ApiOperation({ summary: '[academy] Students: total, active, new, returning, inactive' })
  students(@CurrentAcademy() ctx: AcademyContext, @Query('range') range?: string) {
    return this.analytics.students(ctx, parseRange(range));
  }

  @Get('growth')
  @ApiOperation({ summary: '[academy] Day-by-day growth: new students, enrollments, activations, course activity' })
  growth(@CurrentAcademy() ctx: AcademyContext, @Query('range') range?: string) {
    return this.analytics.growth(ctx.academyId, parseRange(range));
  }

  @Get('enrollments')
  @ApiOperation({ summary: '[academy] Enrollment breakdown by status and by source (automatic/manual/demo)' })
  enrollments(@CurrentAcademy() ctx: AcademyContext) {
    return this.analytics.enrollmentBreakdown(ctx.academyId);
  }

  @Get('attendance')
  @ApiOperation({ summary: '[academy] Attendance rate, trend, by-group breakdown, at-risk students' })
  attendance(@CurrentAcademy() ctx: AcademyContext, @Query('range') range?: string) {
    return this.analytics.attendanceStats(ctx, ctx.academyId, parseRange(range));
  }

  @Get('groups')
  @ApiOperation({ summary: '[academy] Per-group students, attendance rate, session counts, staff' })
  groups(@CurrentAcademy() ctx: AcademyContext) {
    return this.analytics.groupsOverview(ctx);
  }

  @Get('scheduling')
  @ApiOperation({ summary: '[academy] Session totals, room usage, teacher/group load' })
  scheduling(@CurrentAcademy() ctx: AcademyContext, @Query('range') range?: string) {
    return this.analytics.schedulingOverview(ctx, parseRange(range));
  }

  @Get('courses')
  @ApiOperation({ summary: '[academy] Per-course enrollments, progress, quiz pass rate, revenue' })
  courses(@CurrentAcademy() ctx: AcademyContext) {
    return this.analytics.coursesOverview(ctx.academyId);
  }

  @Get('teachers')
  @ApiOperation({ summary: '[academy] Per-staff-member groups, sessions, attendance rate — no rankings' })
  teachers(@CurrentAcademy() ctx: AcademyContext) {
    return this.analytics.teachersOverview(ctx);
  }

  @Get('financial')
  @ApiOperation({ summary: '[academy] Net revenue trend, payment counts, revenue by course — net only, never gross/commission' })
  financial(@CurrentAcademy() ctx: AcademyContext, @Query('range') range?: string) {
    return this.analytics.financialOverview(ctx.academyId, parseRange(range));
  }
}
