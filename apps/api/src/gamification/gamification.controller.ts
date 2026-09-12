import { Body, Controller, ForbiddenException, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtPayload, Role } from '@darsly/shared-types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { LeaderboardPeriod, LeaderboardScope, LeaderboardService } from './leaderboard.service';
import { StudentGamificationService } from './student-gamification.service';

class SetTitleDto {
  @IsOptional() @IsString() @MaxLength(60) titleKey?: string | null;
}

class RedeemDto {
  @IsString() @MaxLength(60) rewardKey: string;
}

@ApiTags('gamification')
@ApiBearerAuth()
@Roles(Role.STUDENT)
@Controller('student/gamification')
export class GamificationController {
  constructor(
    private readonly students: StudentGamificationService,
    private readonly leaderboard: LeaderboardService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @ApiOperation({ summary: '[student] The whole learning profile: level, XP, streak, missions, rank' })
  snapshot(@CurrentUser() user: JwtPayload) {
    return this.students.snapshot(user.sub);
  }

  @Get('achievements')
  @ApiOperation({ summary: '[student] Every achievement, earned and locked, with progress' })
  achievements(@CurrentUser() user: JwtPayload) {
    return this.students.achievementBoard(user.sub);
  }

  @Get('missions')
  @ApiOperation({ summary: "[student] Today's missions and this week's quests" })
  missions(@CurrentUser() user: JwtPayload) {
    return this.students.missionList(user.sub);
  }

  @Get('activity')
  @ApiOperation({ summary: '[student] XP and coin history — every award, explained' })
  activity(@CurrentUser() user: JwtPayload, @Query('limit') limit?: string) {
    return this.students.activity(user.sub, Number(limit) || 30);
  }

  /**
   * A board the student is entitled to see.
   *
   * The global board is everyone's; an academy or course board is only for
   * people learning there. Without this check a student could enumerate the
   * roster of any academy on the platform by guessing ids.
   */
  @Get('leaderboard')
  @ApiOperation({ summary: '[student] Leaderboard with the student’s own position' })
  async board(
    @CurrentUser() user: JwtPayload,
    @Query('scope') scope: LeaderboardScope = 'GLOBAL',
    @Query('scopeId') scopeId = '',
    @Query('period') period: LeaderboardPeriod = 'WEEKLY',
  ) {
    const studentId = await this.students.studentIdOf(user.sub);
    const safeScope: LeaderboardScope = ['GLOBAL', 'ACADEMY', 'COURSE'].includes(scope) ? scope : 'GLOBAL';
    const safePeriod: LeaderboardPeriod = ['WEEKLY', 'MONTHLY', 'ALLTIME'].includes(period) ? period : 'WEEKLY';

    if (safeScope === 'ACADEMY') {
      const member = await this.prisma.enrollment.count({ where: { studentId, tenantId: scopeId } });
      if (!member) throw new ForbiddenException('You are not enrolled with this academy');
    }
    if (safeScope === 'COURSE') {
      const member = await this.prisma.enrollment.count({ where: { studentId, courseId: scopeId } });
      if (!member) throw new ForbiddenException('You are not enrolled in this course');
    }

    return this.leaderboard.board({ scope: safeScope, scopeId, period: safePeriod, studentId, limit: 20 });
  }

  @Get('rewards')
  @ApiOperation({ summary: '[student] The coin store' })
  rewards(@CurrentUser() user: JwtPayload) {
    return this.students.rewards(user.sub);
  }

  @Post('rewards/redeem')
  @ApiOperation({ summary: '[student] Spend coins on a reward' })
  redeem(@CurrentUser() user: JwtPayload, @Body() dto: RedeemDto) {
    return this.students.redeem(user.sub, dto.rewardKey);
  }

  @Post('title')
  @ApiOperation({ summary: '[student] Wear an unlocked title (or none)' })
  setTitle(@CurrentUser() user: JwtPayload, @Body() dto: SetTitleDto) {
    return this.students.setTitle(user.sub, dto.titleKey ?? null);
  }
}
