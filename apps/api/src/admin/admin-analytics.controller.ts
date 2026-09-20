import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@darsly/shared-types';
import { Roles } from '../common/decorators/roles.decorator';
import { AdminAnalyticsService, GrowthRange, isGrowthRange } from './admin-analytics.service';

function parseRange(raw?: string): GrowthRange {
  const n = raw ? Number(raw) : 30;
  if (!isGrowthRange(n)) throw new BadRequestException('range must be one of 7, 30, 90');
  return n;
}

@ApiTags('admin/analytics')
@ApiBearerAuth()
@Roles(Role.SUPER_ADMIN)
@Controller('admin/analytics')
export class AdminAnalyticsController {
  constructor(private readonly analytics: AdminAnalyticsService) {}

  @Get('growth')
  @ApiOperation({ summary: '[admin] Academy / student / enrollment growth over 7, 30 or 90 days' })
  growth(@Query('range') range?: string) {
    return this.analytics.growthTrend(parseRange(range));
  }

  @Get('revenue')
  @ApiOperation({ summary: '[admin] Daily gross revenue + platform fee over 7, 30 or 90 days' })
  revenue(@Query('range') range?: string) {
    return this.analytics.revenueTrend(parseRange(range));
  }

  @Get('attendance')
  @ApiOperation({ summary: '[admin] Platform-wide attendance rate + trend' })
  attendance(@Query('range') range?: string) {
    return this.analytics.attendanceAggregate(parseRange(range));
  }

  @Get('financial')
  @ApiOperation({ summary: '[admin] Platform gross/commission + payment conversion' })
  financial(@Query('range') range?: string) {
    return this.analytics.financialOverview(parseRange(range));
  }

  @Get('active-academies')
  @ApiOperation({ summary: '[admin] Share of ACTIVE academies with a recent enrollment' })
  activeAcademies(@Query('range') range?: string) {
    return this.analytics.activeAcademyRate(parseRange(range));
  }
}
