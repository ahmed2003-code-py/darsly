import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload, Role } from '@darsly/shared-types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { ChallengesService } from './challenges.service';
import { SubmitChallengeAnswerDto } from './dto/challenge.dto';

/** Student-facing "Challenges" — never "Exam" in any route summary or response copy. */
@ApiTags('challenges')
@ApiBearerAuth()
@Controller('challenges')
@Roles(Role.STUDENT)
export class ChallengesController {
  constructor(private readonly challenges: ChallengesService) {}

  @Get()
  @ApiOperation({ summary: '[student] Browse Challenges — available / in progress / completed' })
  list(
    @CurrentUser() u: JwtPayload,
    @Query('tab') tab?: 'available' | 'in_progress' | 'completed',
  ) {
    return this.challenges.listForStudent(u.sub, tab);
  }

  @Get(':id')
  @ApiOperation({ summary: '[student] One Challenge, with my attempt state' })
  detail(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.challenges.detailForStudent(u.sub, id);
  }

  @Get(':id/leaderboard')
  @ApiOperation({ summary: "[student] This Challenge's own leaderboard" })
  leaderboard(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.challenges.leaderboard(u.sub, id);
  }

  @Post(':id/attempts')
  @ApiOperation({ summary: '[student] Start (or resume) an attempt' })
  start(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.challenges.startAttempt(u.sub, id);
  }

  @Get(':id/attempts/:attemptId')
  @ApiOperation({ summary: '[student] Reconnect to an in-progress attempt' })
  getAttempt(
    @CurrentUser() u: JwtPayload,
    @Param('id') id: string,
    @Param('attemptId') attemptId: string,
  ) {
    return this.challenges.getAttempt(u.sub, id, attemptId);
  }

  @Post(':id/attempts/:attemptId/answers')
  @ApiOperation({
    summary: '[student] Answer the current question — server-timed and server-scored',
  })
  answer(
    @CurrentUser() u: JwtPayload,
    @Param('id') id: string,
    @Param('attemptId') attemptId: string,
    @Body() dto: SubmitChallengeAnswerDto,
  ) {
    return this.challenges.answer(u.sub, id, attemptId, dto);
  }

  @Post(':id/attempts/:attemptId/complete')
  @ApiOperation({ summary: '[student] Finish the attempt and collect the result' })
  complete(
    @CurrentUser() u: JwtPayload,
    @Param('id') id: string,
    @Param('attemptId') attemptId: string,
  ) {
    return this.challenges.complete(u.sub, id, attemptId);
  }

  @Post(':id/attempts/:attemptId/retry-mistakes')
  @ApiOperation({
    summary: '[student] A fresh mini attempt containing only the questions I got wrong',
  })
  retryMistakes(
    @CurrentUser() u: JwtPayload,
    @Param('id') id: string,
    @Param('attemptId') attemptId: string,
  ) {
    return this.challenges.retryMistakes(u.sub, id, attemptId);
  }
}
