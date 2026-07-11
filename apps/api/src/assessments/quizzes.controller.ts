import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload, Role } from '@darsly/shared-types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { QuizzesService } from './quizzes.service';
import {
  GradeAttemptDto,
  SetQuizQuestionsDto,
  SubmitAttemptDto,
  UpsertQuizDto,
} from './dto/quiz.dto';

@ApiTags('assessments')
@ApiBearerAuth()
@Controller()
export class QuizzesController {
  constructor(private readonly quizzes: QuizzesService) {}

  // ── Teacher authoring ──────────────────────────────────────────────────────

  @Put('teacher/lessons/:lessonId/quiz')
  @Roles(Role.TEACHER)
  @ApiOperation({ summary: '[teacher] Create/update the quiz on a lesson' })
  upsert(@CurrentUser() u: JwtPayload, @Param('lessonId') lessonId: string, @Body() dto: UpsertQuizDto) {
    return this.quizzes.upsertForTeacher(u.tenantId!, lessonId, dto);
  }

  @Put('teacher/lessons/:lessonId/quiz/questions')
  @Roles(Role.TEACHER)
  @ApiOperation({ summary: '[teacher] Replace the quiz question set' })
  setQuestions(@CurrentUser() u: JwtPayload, @Param('lessonId') lessonId: string, @Body() dto: SetQuizQuestionsDto) {
    return this.quizzes.setQuestions(u.tenantId!, lessonId, dto);
  }

  @Get('teacher/lessons/:lessonId/quiz')
  @Roles(Role.TEACHER)
  @ApiOperation({ summary: '[teacher] Quiz with questions + attempts' })
  getForTeacher(@CurrentUser() u: JwtPayload, @Param('lessonId') lessonId: string) {
    return this.quizzes.getForTeacher(u.tenantId!, lessonId);
  }

  @Post('teacher/quiz-attempts/:attemptId/grade')
  @Roles(Role.TEACHER)
  @ApiOperation({ summary: '[teacher] Grade short-answer questions & finalize score' })
  grade(@CurrentUser() u: JwtPayload, @Param('attemptId') attemptId: string, @Body() dto: GradeAttemptDto) {
    return this.quizzes.gradeAttempt(u.tenantId!, u.sub, attemptId, dto);
  }

  // ── Student ────────────────────────────────────────────────────────────────

  @Get('lessons/:lessonId/quiz')
  @Roles(Role.STUDENT)
  @ApiOperation({ summary: '[student] Quiz to take (answers hidden) + my last attempt' })
  getForStudent(@CurrentUser() u: JwtPayload, @Param('lessonId') lessonId: string) {
    return this.quizzes.getForStudent(u.sub, lessonId);
  }

  @Post('lessons/:lessonId/quiz/attempts')
  @Roles(Role.STUDENT)
  @ApiOperation({ summary: '[student] Submit answers — auto-graded, short-answer pends' })
  submit(@CurrentUser() u: JwtPayload, @Param('lessonId') lessonId: string, @Body() dto: SubmitAttemptDto) {
    return this.quizzes.submit(u.sub, lessonId, dto);
  }
}
