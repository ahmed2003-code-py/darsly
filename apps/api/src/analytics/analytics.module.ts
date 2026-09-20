import { Module } from '@nestjs/common';
import { AcademyModule } from '../academy/academy.module';
import { AcademyOpsModule } from '../academy-ops/academy-ops.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

@Module({
  // AcademyModule supplies the membership/permission guards behind
  // @AcademyStaff. AcademyOpsModule supplies NeedsAttentionService (at-risk
  // attendance) and GroupsService (batched group + staff metadata) — see the
  // reuse note atop AnalyticsService's Phase 6 section. GamificationAnalyticsService
  // and LedgerService are both @Global() providers and need no import here.
  imports: [AcademyModule, AcademyOpsModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
