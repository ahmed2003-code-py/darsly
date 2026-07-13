import { Controller, Get, Module } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AcademyContext, CurrentAcademy } from '../academy/academy-context';
import { AcademyModule } from '../academy/academy.module';
import { AcademyStaff } from '../academy/academy-staff.decorator';
import { AnalyticsService } from './analytics.service';

@ApiTags('analytics')
@AcademyStaff('analytics.read')
@Controller('teacher/analytics')
class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get()
  @ApiOperation({ summary: '[academy] Teaching KPIs + revenue/enrollment trends' })
  overview(@CurrentAcademy() ctx: AcademyContext) {
    return this.analytics.teacherOverview(ctx.academyId);
  }
}

@Module({
  imports: [AcademyModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
