import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload, Role } from '@darsly/shared-types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { ChallengesService } from './challenges.service';
import { SetChallengeQuestionsDto, UpsertChallengeDto } from './dto/challenge.dto';

@ApiTags('challenges')
@ApiBearerAuth()
@Controller('teacher/challenges')
@Roles(Role.TEACHER)
export class TeacherChallengesController {
  constructor(private readonly challenges: ChallengesService) {}

  @Get()
  @ApiOperation({ summary: '[teacher] My Challenges' })
  list(@CurrentUser() u: JwtPayload, @Query('status') status?: string) {
    return this.challenges.listForTeacher(u.tenantId!, status);
  }

  @Post()
  @ApiOperation({ summary: '[teacher] Create a new Challenge (draft)' })
  create(@CurrentUser() u: JwtPayload, @Body() dto: UpsertChallengeDto) {
    return this.challenges.create(u.tenantId!, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: '[teacher] One Challenge with its questions' })
  get(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.challenges.getForTeacher(u.tenantId!, id);
  }

  @Put(':id')
  @ApiOperation({ summary: '[teacher] Update basic info & settings' })
  update(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() dto: UpsertChallengeDto) {
    return this.challenges.update(u.tenantId!, id, dto);
  }

  @Put(':id/questions')
  @ApiOperation({ summary: '[teacher] Replace the question set (draft only)' })
  setQuestions(
    @CurrentUser() u: JwtPayload,
    @Param('id') id: string,
    @Body() dto: SetChallengeQuestionsDto,
  ) {
    return this.challenges.setQuestions(u.tenantId!, id, dto);
  }

  @Post(':id/publish')
  @ApiOperation({ summary: '[teacher] Validate and publish' })
  publish(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.challenges.publish(u.tenantId!, id);
  }

  @Post(':id/unpublish')
  @ApiOperation({ summary: '[teacher] Back to draft' })
  unpublish(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.challenges.unpublish(u.tenantId!, id);
  }

  @Post(':id/close')
  @ApiOperation({ summary: '[teacher] Close — no new attempts, existing ones keep their results' })
  close(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.challenges.close(u.tenantId!, id);
  }

  @Post(':id/duplicate')
  @ApiOperation({ summary: '[teacher] Duplicate as a new draft' })
  duplicate(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.challenges.duplicate(u.tenantId!, id);
  }

  @Delete(':id')
  @ApiOperation({
    summary:
      '[teacher] Delete (archives instead if it has attempts, unless ?force=true). Earned XP is never touched.',
  })
  remove(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Query('force') force?: string) {
    return this.challenges.remove(u.tenantId!, id, { force: force === 'true' });
  }

  @Get(':id/submissions')
  @ApiOperation({ summary: "[teacher] Every student's result on this Challenge" })
  submissions(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.challenges.submissions(u.tenantId!, id);
  }

  @Get(':id/analytics')
  @ApiOperation({ summary: '[teacher] Participation, scores and per-question stats' })
  analytics(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.challenges.analytics(u.tenantId!, id);
  }
}
