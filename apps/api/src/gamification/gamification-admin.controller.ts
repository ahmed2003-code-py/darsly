import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { Role } from '@darsly/shared-types';
import { AcademyContext, CurrentAcademy } from '../academy/academy-context';
import { AcademyStaff } from '../academy/academy-staff.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { GamificationAnalyticsService } from './gamification-analytics.service';
import { GamificationConfigService } from './gamification.config.service';
import { LeaderboardPeriod, LeaderboardService } from './leaderboard.service';

class UpdateXpRuleDto {
  @IsOptional() @IsInt() @Min(0) xp?: number;
  @IsOptional() @IsInt() @Min(0) coins?: number;
  @IsOptional() @IsInt() @Min(0) dailyCap?: number;
  @IsOptional() @IsInt() @Min(0) perEntityLimit?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class UpdateLevelDto {
  @IsOptional() @IsInt() @Min(0) minXp?: number;
  @IsOptional() @IsString() @MaxLength(60) nameAr?: string;
  @IsOptional() @IsString() @MaxLength(60) nameEn?: string;
  @IsOptional() @IsInt() @Min(0) coinReward?: number;
}

class UpdateAchievementDto {
  @IsOptional() @IsInt() @Min(1) threshold?: number;
  @IsOptional() @IsInt() @Min(0) xpReward?: number;
  @IsOptional() @IsInt() @Min(0) coinReward?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class UpdateRewardDto {
  @IsOptional() @IsInt() @Min(0) costCoins?: number;
  @IsOptional() @IsInt() @Min(0) stock?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

/**
 * The teacher's view of engagement in their own academy.
 *
 * Tenant-scoped through the same membership guard every other academy route
 * uses, so a teacher sees their students and no one else's — including on the
 * leaderboard, which is the one screen where a leak would be most visible.
 */
@ApiTags('gamification/teacher')
@ApiBearerAuth()
@Controller('teacher/gamification')
export class TeacherGamificationController {
  constructor(
    private readonly analytics: GamificationAnalyticsService,
    private readonly leaderboard: LeaderboardService,
  ) {}

  @Get('analytics')
  @AcademyStaff('analytics.read')
  @ApiOperation({ summary: '[teacher] Engagement and retention for this academy' })
  overview(@CurrentAcademy() ctx: AcademyContext) {
    return this.analytics.overview(ctx.academyId);
  }

  @Get('leaderboard')
  @AcademyStaff('analytics.read')
  @ApiOperation({ summary: '[teacher] This academy’s leaderboard' })
  board(@CurrentAcademy() ctx: AcademyContext, @Query('period') period: LeaderboardPeriod = 'WEEKLY') {
    const safe: LeaderboardPeriod = ['WEEKLY', 'MONTHLY', 'ALLTIME'].includes(period) ? period : 'WEEKLY';
    return this.leaderboard.board({ scope: 'ACADEMY', scopeId: ctx.academyId, period: safe, limit: 50 });
  }
}

/**
 * The platform control centre.
 *
 * The economy is data, not code — an admin can retune what a lesson is worth,
 * move a level threshold, or retire an achievement without a deploy. Edits
 * drop the config cache immediately so the change is live within the same
 * request rather than a minute later.
 */
@ApiTags('gamification/admin')
@ApiBearerAuth()
@Roles(Role.SUPER_ADMIN)
@Controller('admin/gamification')
export class AdminGamificationController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: GamificationAnalyticsService,
    private readonly config: GamificationConfigService,
  ) {}

  @Get('analytics')
  @ApiOperation({ summary: '[admin] Platform-wide engagement and retention' })
  overview() {
    return this.analytics.overview(null);
  }

  @Get('config')
  @ApiOperation({ summary: '[admin] The whole economy: rules, levels, achievements, rewards' })
  async configAll() {
    const [rules, levels, achievements, rewards] = await Promise.all([
      this.prisma.xpRule.findMany({ orderBy: { event: 'asc' } }),
      this.prisma.levelTier.findMany({ orderBy: { level: 'asc' } }),
      this.prisma.achievement.findMany({ orderBy: { sortOrder: 'asc' } }),
      this.prisma.reward.findMany({ orderBy: { sortOrder: 'asc' } }),
    ]);
    return { rules, levels, achievements, rewards };
  }

  @Patch('xp-rules/:event')
  @ApiOperation({ summary: '[admin] Retune what an event pays' })
  async updateRule(@Param('event') event: string, @Body() dto: UpdateXpRuleDto) {
    const row = await this.prisma.xpRule.update({ where: { event }, data: { ...dto } });
    this.config.invalidate();
    return row;
  }

  @Patch('levels/:level')
  @ApiOperation({ summary: '[admin] Move a level threshold or rename a tier' })
  async updateLevel(@Param('level') level: string, @Body() dto: UpdateLevelDto) {
    const row = await this.prisma.levelTier.update({ where: { level: Number(level) }, data: { ...dto } });
    this.config.invalidate();
    return row;
  }

  @Patch('achievements/:key')
  @ApiOperation({ summary: '[admin] Retune or retire an achievement' })
  updateAchievement(@Param('key') key: string, @Body() dto: UpdateAchievementDto) {
    return this.prisma.achievement.update({ where: { key }, data: { ...dto } });
  }

  @Patch('rewards/:key')
  @ApiOperation({ summary: '[admin] Reprice, restock or withdraw a reward' })
  updateReward(@Param('key') key: string, @Body() dto: UpdateRewardDto) {
    return this.prisma.reward.update({ where: { key }, data: { ...dto } });
  }

  /**
   * Real-world prizes never fulfil themselves. Redeeming one only reserves it;
   * a human decides it actually happened.
   */
  @Get('redemptions')
  @ApiOperation({ summary: '[admin] Reward redemptions awaiting a human' })
  pending() {
    return this.prisma.rewardRedemption.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: 100,
      include: {
        reward: { select: { key: true, titleAr: true, titleEn: true, kind: true } },
        student: { select: { user: { select: { fullName: true, email: true } } } },
      },
    });
  }

  @Post('redemptions/:id/fulfil')
  @ApiOperation({ summary: '[admin] Mark a real-world reward as delivered' })
  fulfil(@Param('id') id: string) {
    return this.prisma.rewardRedemption.update({ where: { id }, data: { status: 'FULFILLED' } });
  }
}
