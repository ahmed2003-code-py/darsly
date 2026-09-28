import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload } from '@darsly/shared-types';
import { AcademyContext, CurrentAcademy } from '../academy/academy-context';
import { AcademyStaff } from '../academy/academy-staff.decorator';
import { StaffScopeService } from '../academy/staff-scope.service';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AssignmentsService } from './assignments.service';
import { GradeSubmissionDto } from './dto/assignment.dto';
import { GradeAttemptDto } from './dto/quiz.dto';
import { GradingService } from './grading.service';
import { QuizzesService } from './quizzes.service';

/**
 * Marking, for staff who are not the course's author: the same queue and the
 * same two grade actions a teacher has, narrowed to the member's courses by
 * StaffScopeService and recorded under the marker's own identity. Fixing an
 * answer key and dismissing a report stay with the author — they change the
 * exam, not one student's mark.
 */
@ApiTags('grading')
@ApiBearerAuth()
@Controller('staff/grading')
export class StaffGradingController {
  constructor(
    private readonly grading: GradingService,
    private readonly quizzes: QuizzesService,
    private readonly assignments: AssignmentsService,
    private readonly scopes: StaffScopeService,
    private readonly audit: AuditService,
  ) {}

  private async courses(ctx: AcademyContext) {
    return (await this.scopes.forContext(ctx)).courses;
  }

  @Get()
  @AcademyStaff('assessment.grade')
  @ApiOperation({ summary: '[staff] What is waiting to be marked in my courses' })
  async queue(@CurrentAcademy() ctx: AcademyContext) {
    return this.grading.queue(await this.courses(ctx));
  }

  @Get('quiz-attempts/:id')
  @AcademyStaff('assessment.grade')
  async quizAttempt(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    return this.grading.quizAttempt(await this.courses(ctx), id);
  }

  @Get('submissions/:id')
  @AcademyStaff('assessment.grade')
  async submission(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    return this.grading.submission(await this.courses(ctx), id);
  }

  @Post('quiz-attempts/:id/grade')
  @AcademyStaff('assessment.grade')
  @ApiOperation({ summary: '[staff] Mark a quiz attempt in my courses' })
  async gradeAttempt(
    @CurrentUser() u: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Body() dto: GradeAttemptDto,
  ) {
    const result = await this.quizzes.gradeAttempt(await this.courses(ctx), u.sub, id, dto);
    await this.audit.log({
      actorUserId: u.sub,
      action: 'grade.quizAttempt',
      entity: 'QuizAttempt',
      entityId: id,
      academyId: ctx.academyId,
      meta: { role: ctx.role },
    });
    return result;
  }

  @Post('submissions/:id/grade')
  @AcademyStaff('assessment.grade')
  @ApiOperation({ summary: '[staff] Mark an assignment in my courses' })
  async gradeSubmission(
    @CurrentUser() u: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Body() dto: GradeSubmissionDto,
  ) {
    const result = await this.assignments.gradeSubmission(await this.courses(ctx), u.sub, id, dto);
    await this.audit.log({
      actorUserId: u.sub,
      action: 'grade.submission',
      entity: 'AssignmentSubmission',
      entityId: id,
      academyId: ctx.academyId,
      meta: { role: ctx.role, score: dto.score },
    });
    return result;
  }
}
