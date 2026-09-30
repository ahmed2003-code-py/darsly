import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AcademyContext, CurrentAcademy } from '../academy/academy-context';
import { AcademyMembershipGuard } from '../academy/guards/academy-membership.guard';
import { AcademyStaffFeature } from '../feature-flags/academy-staff-feature.decorator';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { ClassAttendanceService } from './class-attendance.service';
import { ClassScheduleService } from './class-schedule.service';
import {
  CandidateQuery,
  CreateSlotDto,
  DayQuery,
  MakeupDto,
  MarkDto,
  RangeQuery,
  UpdateSlotDto,
} from './dto';

/**
 * Center Operations C2 — timetables, classes and their attendance. Every
 * route needs the academy's `classOperations` flag and a capability:
 * `schedule.manage` for the timetable, `attendance.mark` for classes. Both
 * are then scoped per group (AcademyOpsAccessService): an OWNER reaches every
 * group, anyone else only the groups assigned to them. The desk's Reception
 * preset holds neither, so registering students never grants a class.
 */
@ApiTags('class-ops')
@Controller('class-ops')
export class ClassOpsController {
  constructor(
    private readonly schedule: ClassScheduleService,
    private readonly attendance: ClassAttendanceService,
    private readonly flags: FeatureFlagsService,
  ) {}

  /** What this member may do here — for the menu; never a 403. */
  @Get('access')
  @UseGuards(AcademyMembershipGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[academy] Are classes on here, and may I take attendance / plan' })
  async access(@CurrentAcademy() ctx: AcademyContext) {
    const enabled = await this.flags.isEnabled(ctx.academyId, 'classOperations');
    const clock = enabled ? await this.schedule.academyClock(ctx.academyId) : null;
    return {
      enabled,
      canAttend: enabled && ctx.can('attendance.mark'),
      canSchedule: enabled && ctx.can('schedule.manage'),
      canManageGroups: enabled && ctx.can('group.manage'),
      timezone: clock?.timezone ?? null,
      today: clock?.today ?? null,
      lateGraceMin: clock?.lateGraceMin ?? null,
    };
  }

  // ── Classes ─────────────────────────────────────────────────────────────

  @Get('day')
  @AcademyStaffFeature('attendance.mark', 'classOperations')
  @ApiOperation({ summary: "[academy] One day's classes (default today) with their state" })
  day(@CurrentAcademy() ctx: AcademyContext, @Query() q: DayQuery) {
    return this.attendance.day(ctx, q.date);
  }

  @Get('groups/:groupId/classes')
  @AcademyStaffFeature('attendance.mark', 'classOperations')
  @ApiOperation({ summary: "[academy] A group's classes between two local dates" })
  groupClasses(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('groupId') groupId: string,
    @Query() q: RangeQuery,
  ) {
    return this.attendance.groupClasses(ctx, groupId, q.from, q.to);
  }

  @Get('sessions/:sessionId')
  @AcademyStaffFeature('attendance.mark', 'classOperations')
  @ApiOperation({ summary: '[academy] A class: who is expected, who came, what can be done' })
  roster(@CurrentAcademy() ctx: AcademyContext, @Param('sessionId') sessionId: string) {
    return this.attendance.roster(ctx, sessionId);
  }

  @Post('sessions/:sessionId/start')
  @AcademyStaffFeature('attendance.mark', 'classOperations')
  @ApiOperation({ summary: '[academy] Start the class (server time; repeat-safe)' })
  start(@CurrentAcademy() ctx: AcademyContext, @Param('sessionId') sessionId: string) {
    return this.attendance.start(ctx, sessionId);
  }

  @Post('sessions/:sessionId/attendance')
  @AcademyStaffFeature('attendance.mark', 'classOperations')
  @ApiOperation({ summary: '[academy] Mark or correct attendance for students of the class' })
  mark(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('sessionId') sessionId: string,
    @Body() dto: MarkDto,
  ) {
    return this.attendance.mark(ctx, sessionId, dto);
  }

  @Post('sessions/:sessionId/close')
  @AcademyStaffFeature('attendance.mark', 'classOperations')
  @ApiOperation({ summary: '[academy] Close the sheet: everyone expected and unmarked is absent' })
  close(@CurrentAcademy() ctx: AcademyContext, @Param('sessionId') sessionId: string) {
    return this.attendance.close(ctx, sessionId);
  }

  @Post('sessions/:sessionId/makeup')
  @AcademyStaffFeature('attendance.mark', 'classOperations')
  @ApiOperation({ summary: "[academy] Record another group's student attending as makeup" })
  makeup(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('sessionId') sessionId: string,
    @Body() dto: MakeupDto,
  ) {
    return this.attendance.makeup(ctx, sessionId, dto);
  }

  @Get('sessions/:sessionId/makeup-candidates')
  @AcademyStaffFeature('attendance.mark', 'classOperations')
  @ApiOperation({
    summary: '[academy] Find a student to add as makeup (by code; by name with the register)',
  })
  candidates(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('sessionId') sessionId: string,
    @Query() q: CandidateQuery,
  ) {
    return this.attendance.makeupCandidates(ctx, sessionId, q.q);
  }

  // ── Timetable ───────────────────────────────────────────────────────────

  @Get('groups/:groupId/options')
  @AcademyStaffFeature('schedule.manage', 'classOperations')
  @ApiOperation({ summary: '[academy] Rooms, teachers, subjects and years a group form can pick' })
  options(@CurrentAcademy() ctx: AcademyContext, @Param('groupId') groupId: string) {
    return this.schedule.options(ctx, groupId);
  }

  @Get('groups/:groupId/slots')
  @AcademyStaffFeature('schedule.manage', 'classOperations')
  @ApiOperation({ summary: "[academy] A group's weekly timetable" })
  slots(@CurrentAcademy() ctx: AcademyContext, @Param('groupId') groupId: string) {
    return this.schedule.listSlots(ctx, groupId);
  }

  @Post('groups/:groupId/slots')
  @AcademyStaffFeature('schedule.manage', 'classOperations')
  @ApiOperation({ summary: '[academy] Add a weekly class; its next 4 weeks are created at once' })
  createSlot(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('groupId') groupId: string,
    @Body() dto: CreateSlotDto,
  ) {
    return this.schedule.createSlot(ctx, groupId, dto);
  }

  @Patch('slots/:slotId')
  @AcademyStaffFeature('schedule.manage', 'classOperations')
  @ApiOperation({ summary: '[academy] Change a weekly class (dryRun: see what would change)' })
  updateSlot(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('slotId') slotId: string,
    @Body() dto: UpdateSlotDto,
  ) {
    return this.schedule.updateSlot(ctx, slotId, dto);
  }

  @Delete('slots/:slotId')
  @AcademyStaffFeature('schedule.manage', 'classOperations')
  @ApiOperation({ summary: '[academy] Remove a weekly class; past and touched classes stay' })
  deleteSlot(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('slotId') slotId: string,
    @Query('dryRun') dryRun?: string,
  ) {
    return this.schedule.deleteSlot(ctx, slotId, dryRun === '1' || dryRun === 'true');
  }
}
