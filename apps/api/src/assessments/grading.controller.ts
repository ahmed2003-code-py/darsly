import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload, Role } from '@darsly/shared-types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { GradingService } from './grading.service';

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
    return this.grading.queue(u.tenantId!);
  }

  @Get('teacher/grading/quiz-attempts/:id')
  @Roles(Role.TEACHER)
  @ApiOperation({ summary: '[teacher] One attempt, with the answers to mark' })
  attempt(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.grading.quizAttempt(u.tenantId!, id);
  }

  @Get('teacher/grading/submissions/:id')
  @Roles(Role.TEACHER)
  @ApiOperation({ summary: '[teacher] One assignment submission, with the work to mark' })
  submission(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.grading.submission(u.tenantId!, id);
  }
}
