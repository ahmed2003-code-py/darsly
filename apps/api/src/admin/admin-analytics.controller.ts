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
}
