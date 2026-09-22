import { BadRequestException, Controller, ForbiddenException, Get, Query } from '@nestjs/common';
import { JwtPayload } from '@darsly/shared-types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AcademyContext, CurrentAcademy } from '../academy/academy-context';
import { AcademyStaff } from '../academy/academy-staff.decorator';
import { AnalyticsRange, isAnalyticsRange } from './analytics.constants';
import { AnalyticsService } from './analytics.service';
import { AuditService } from '../audit/audit.service';

/**
 * Academy-wide analytics are the owner's view of the organisation. A TEACHER
 * member holds `analytics.read` for their own scope (GET me) — never for the
 * whole Center. A platform admin arrives as a synthetic OWNER and passes.
 */
function ownerOnly(ctx: AcademyContext) {
  if (ctx.role !== 'OWNER') {
    throw new ForbiddenException({ message: 'Academy-wide analytics are for the academy owner', code: 'ANALYTICS_OWNER_ONLY' });
  }
}

function parseRange(raw?: string): AnalyticsRange {
  const n = raw ? Number(raw) : 30;
  if (!isAnalyticsRange(n)) throw new BadRequestException('range must be one of 7, 30, 90');
  return n;
}

@ApiTags('analytics')
@AcademyStaff('analytics.read')
@Controller('teacher/analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService, private readonly auditService: AuditService) {}

  @Get()
  @ApiOperation({ summary: '[academy] Teaching KPIs + revenue/enrollment trends' })
  overview(@CurrentAcademy() ctx: AcademyContext) {
    ownerOnly(ctx);
    return this.analytics.teacherOverview(ctx.academyId);
  }

  @Get('students')
  @ApiOperation({ summary: '[academy] Students: total, active, new, returning, inactive' })
  students(@CurrentAcademy() ctx: AcademyContext, @Query('range') range?: string) {
    ownerOnly(ctx);
    return this.analytics.students(ctx, parseRange(range));
  }

  @Get('growth')
  @ApiOperation({ summary: '[academy] Day-by-day growth: new students, enrollments, activations, course activity' })
  growth(@CurrentAcademy() ctx: AcademyContext, @Query('range') range?: string) {
    ownerOnly(ctx);
    return this.analytics.growth(ctx.academyId, parseRange(range));
  }

  @Get('enrollments')
  @ApiOperation({ summary: '[academy] Enrollment breakdown by status and by source (automatic/manual/demo)' })
  enrollments(@CurrentAcademy() ctx: AcademyContext) {
    ownerOnly(ctx);
    return this.analytics.enrollmentBreakdown(ctx.academyId);
  }

  @Get('attendance')
  @ApiOperation({ summary: '[academy] Attendance rate, trend, by-group breakdown, at-risk students' })
  attendance(@CurrentAcademy() ctx: AcademyContext, @Query('range') range?: string) {
    ownerOnly(ctx);
    return this.analytics.attendanceStats(ctx, ctx.academyId, parseRange(range));
  }

  @Get('groups')
  @ApiOperation({ summary: '[academy] Per-group students, attendance rate, session counts, staff' })
  groups(@CurrentAcademy() ctx: AcademyContext) {
    ownerOnly(ctx);
    return this.analytics.groupsOverview(ctx);
  }

  @Get('scheduling')
  @ApiOperation({ summary: '[academy] Session totals, room usage, teacher/group load' })
  scheduling(@CurrentAcademy() ctx: AcademyContext, @Query('range') range?: string) {
    ownerOnly(ctx);
    return this.analytics.schedulingOverview(ctx, parseRange(range));
  }

  @Get('courses')
  @ApiOperation({ summary: '[academy] Per-course enrollments, progress, quiz pass rate, revenue' })
  courses(@CurrentAcademy() ctx: AcademyContext) {
    ownerOnly(ctx);
    return this.analytics.coursesOverview(ctx.academyId);
  }

  @Get('teachers')
  @ApiOperation({ summary: '[academy] Per-staff-member groups, sessions, attendance rate — no rankings' })
  teachers(@CurrentAcademy() ctx: AcademyContext) {
    ownerOnly(ctx);
    return this.analytics.teachersOverview(ctx);
  }

  @Get('financial')
  @ApiOperation({ summary: '[academy] Net revenue trend, payment counts, revenue by course — net only, never gross/commission' })
  financial(@CurrentAcademy() ctx: AcademyContext, @Query('range') range?: string) {
    ownerOnly(ctx);
    return this.analytics.financialOverview(ctx.academyId, parseRange(range));
  }

  @Get('center')
  @ApiOperation({ summary: '[academy] Center dashboard — organisation-scoped operational counts (no finance)' })
  center(@CurrentAcademy() ctx: AcademyContext) {
    ownerOnly(ctx);
    return this.analytics.centerOverview(ctx);
  }

  @Get('me')
  @ApiOperation({ summary: '[academy] My own teaching numbers inside the active academy' })
  me(@CurrentUser() user: JwtPayload, @CurrentAcademy() ctx: AcademyContext, @Query('range') range?: string) {
    return this.analytics.myTeaching(ctx, user.tenantId, parseRange(range));
  }

  @Get('activity')
  @ApiOperation({ summary: "[academy] The Center's own audit trail — who did what, cursor-paginated (owner-only)" })
  activity(@CurrentAcademy() ctx: AcademyContext, @Query('cursor') cursor?: string, @Query('take') take?: string) {
    ownerOnly(ctx);
    return this.auditService.listForAcademy(ctx.academyId, { cursor, take: take ? Number(take) : undefined });
  }
}
