import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { AdminAcademiesController } from './admin-academies.controller';
import { AdminAcademiesService } from './admin-academies.service';
import { AdminAnalyticsController } from './admin-analytics.controller';
import { AdminAnalyticsService } from './admin-analytics.service';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminThemeController } from './admin-theme.controller';
import { AdminThemeService } from './admin-theme.service';

@Module({
  // AnalyticsModule: platform-wide attendance/course-activity reuse
  // AnalyticsService's tenantId-nullable methods (see AdminAnalyticsService)
  // instead of a second implementation.
  imports: [FeatureFlagsModule, AnalyticsModule],
  controllers: [AdminController, AdminAcademiesController, AdminAnalyticsController, AdminThemeController],
  providers: [AdminService, AdminAcademiesService, AdminAnalyticsService, AdminThemeService],
})
export class AdminModule {}
