import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload, Role } from '@darsly/shared-types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AssignmentsService } from './assignments.service';
import {
  GradeSubmissionDto,
  SubmitAssignmentDto,
  UpsertAssignmentDto,
} from './dto/assignment.dto';

@ApiTags('assessments')
@ApiBearerAuth()
@Controller()
export class AssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  // ── Teacher authoring ──────────────────────────────────────────────────────

  @Put('teacher/lessons/:lessonId/assignment')
  @Roles(Role.TEACHER)
  @ApiOperation({ summary: '[teacher] Create/update the assignment on a lesson' })
  upsert(@CurrentUser() u: JwtPayload, @Param('lessonId') lessonId: string, @Body() dto: UpsertAssignmentDto) {
    return this.assignments.upsertForTeacher(u.tenantId!, lessonId, dto);
  }

  @Get('teacher/lessons/:lessonId/assignment')
  @Roles(Role.TEACHER)
  @ApiOperation({ summary: '[teacher] Assignment with submissions' })
  getForTeacher(@CurrentUser() u: JwtPayload, @Param('lessonId') lessonId: string) {
    return this.assignments.getForTeacher(u.tenantId!, lessonId);
  }

  @Post('teacher/assignment-submissions/:submissionId/grade')
  @Roles(Role.TEACHER)
  @ApiOperation({ summary: '[teacher] Grade a submission (score + feedback)' })
  grade(@CurrentUser() u: JwtPayload, @Param('submissionId') submissionId: string, @Body() dto: GradeSubmissionDto) {
    return this.assignments.gradeSubmission(u.tenantId!, submissionId, dto);
  }

  // ── Student ────────────────────────────────────────────────────────────────

  @Get('lessons/:lessonId/assignment')
  @Roles(Role.STUDENT)
  @ApiOperation({ summary: '[student] Assignment + my submission' })
  getForStudent(@CurrentUser() u: JwtPayload, @Param('lessonId') lessonId: string) {
    return this.assignments.getForStudent(u.sub, lessonId);
  }

  @Post('lessons/:lessonId/assignment/submissions')
  @Roles(Role.STUDENT)
  @ApiOperation({ summary: '[student] Submit / update my assignment answer' })
  submit(@CurrentUser() u: JwtPayload, @Param('lessonId') lessonId: string, @Body() dto: SubmitAssignmentDto) {
    return this.assignments.submit(u.sub, lessonId, dto);
  }
}
