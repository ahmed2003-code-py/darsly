import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload, Role } from '@darsly/shared-types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { FixKeyDto } from './dto/grading.dto';
import { GradingService } from './grading.service';

/** A teacher's own console: the courses they wrote. */
export const own = (u: JwtPayload) => ({ tenantId: u.tenantId ?? '__none__' });

/**
 * Reading the marking queue. Nothing here writes: the two grade endpoints that
 * already exist (quiz-attempts/:id/grade, assignment-submissions/:id/grade)
 * stay the only way a mark is recorded, so this screen cannot drift away from
 * how marking has always worked.
 */
@ApiTags('grading')
@ApiBearerAuth()
@Controller()
export class GradingController {
  constructor(private readonly grading: GradingService) {}

  @Get('teacher/grading')
  @Roles(Role.TEACHER)
  @ApiOperation({ summary: '[teacher] Everything waiting to be marked, grouped by course' })
  queue(@CurrentUser() u: JwtPayload) {
    return this.grading.queue(own(u));
  }

  @Get('teacher/grading/quiz-attempts/:id')
  @Roles(Role.TEACHER)
  @ApiOperation({ summary: '[teacher] One attempt, with the answers to mark' })
  attempt(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.grading.quizAttempt(own(u), id);
  }

  @Get('teacher/grading/submissions/:id')
  @Roles(Role.TEACHER)
  @ApiOperation({ summary: '[teacher] One assignment submission, with the work to mark' })
  submission(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.grading.submission(own(u), id);
  }

  @Get('teacher/grading/analysis')
  @Roles(Role.TEACHER)
  @ApiOperation({
    summary: '[teacher] Papers that have been sat, and where students say a question is wrong',
  })
  analysis(@CurrentUser() u: JwtPayload) {
    return this.grading.analysis(own(u));
  }

  @Get('teacher/grading/quizzes/:lessonId')
  @Roles(Role.TEACHER)
  @ApiOperation({
    summary: '[teacher] One paper question by question: what the class chose, and who complained',
  })
  quizAnalysis(@CurrentUser() u: JwtPayload, @Param('lessonId') lessonId: string) {
    return this.grading.quizAnalysis(own(u), lessonId);
  }

  @Post('teacher/grading/questions/:id/key')
  @Roles(Role.TEACHER)
  @ApiOperation({ summary: '[teacher] Correct a question key and give back the marks it cost' })
  fixKey(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() dto: FixKeyDto) {
    return this.grading.fixKey(own(u), u.sub, id, dto.correctOptionIds);
  }

  @Get('teacher/grading/quizzes/:lessonId/students')
  @Roles(Role.TEACHER)
  @ApiOperation({ summary: '[teacher] Who sat this paper, and how it went for each' })
  quizStudents(@CurrentUser() u: JwtPayload, @Param('lessonId') lessonId: string) {
    return this.grading.quizStudents(own(u), lessonId);
  }

  @Get('teacher/grading/assignments/:lessonId/students')
  @Roles(Role.TEACHER)
  @ApiOperation({ summary: '[teacher] Who handed this assignment in' })
  assignmentStudents(@CurrentUser() u: JwtPayload, @Param('lessonId') lessonId: string) {
    return this.grading.assignmentStudents(own(u), lessonId);
  }

  @Get('teacher/grading/quiz-attempts/:id/review')
  @Roles(Role.TEACHER)
  @ApiOperation({ summary: "[teacher] One student's paper: what they chose, what was right" })
  review(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.grading.attemptReview(own(u), id);
  }

  @Post('teacher/grading/reports/:id/dismiss')
  @Roles(Role.TEACHER)
  @ApiOperation({ summary: '[teacher] The question was right after all' })
  dismiss(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.grading.dismissReport(own(u), u.sub, id);
  }
}
