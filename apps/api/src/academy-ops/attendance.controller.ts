import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AcademyContext, CurrentAcademy } from '../academy/academy-context';
import { AcademyStaff } from '../academy/academy-staff.decorator';
import { AcademyStaffFeature } from '../feature-flags/academy-staff-feature.decorator';
import { AttendanceService } from './attendance.service';
import { MarkAttendanceDto } from './dto/academy-ops.dto';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function assertDate(date?: string): string {
  if (!date || !DATE_RE.test(date)) throw new BadRequestException({ message: 'date must be YYYY-MM-DD', code: 'INVALID_DATE' });
  return date;
}

@ApiTags('teacher/attendance')
@Controller('teacher')
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Get('groups/:groupId/attendance')
  @AcademyStaffFeature('attendance.mark', 'attendance')
  @ApiOperation({ summary: '[academy] Attendance for a group on one date — full roster, marked or not' })
  sessionFor(@CurrentAcademy() ctx: AcademyContext, @Param('groupId') groupId: string, @Query('date') date?: string) {
    return this.attendance.sessionFor(ctx, groupId, assertDate(date));
  }

  @Post('groups/:groupId/attendance')
  @AcademyStaffFeature('attendance.mark', 'attendance')
  @ApiOperation({ summary: '[academy] Mark or update attendance for a group on one date (bulk)' })
  mark(@CurrentAcademy() ctx: AcademyContext, @Param('groupId') groupId: string, @Body() dto: MarkAttendanceDto) {
    return this.attendance.mark(ctx, groupId, dto);
  }

  @Get('students/:studentId/attendance')
  @AcademyStaff('student.manage')
  @ApiOperation({ summary: '[academy] One student\'s attendance history in this academy' })
  history(@CurrentAcademy() ctx: AcademyContext, @Param('studentId') studentId: string) {
    return this.attendance.studentHistory(ctx, studentId);
  }
}
