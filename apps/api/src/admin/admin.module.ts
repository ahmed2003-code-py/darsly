import { Module } from '@nestjs/common';
import { AcademyModule } from '../academy/academy.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { AdminCenterThemesController, CenterStudioController } from './center-themes.controller';
import { CenterThemesService } from './center-themes.service';
import { AdminAcademiesController } from './admin-academies.controller';
import { AdminAcademiesService } from './admin-academies.service';
import { AdminAnalyticsController } from './admin-analytics.controller';
import { AdminCentersController } from './admin-centers.controller';
import { AdminCentersService } from './admin-centers.service';
import { AdminAnalyticsService } from './admin-analytics.service';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminThemeController } from './admin-theme.controller';
import { AdminThemeService } from './admin-theme.service';

@Module({
  // AnalyticsModule: platform-wide attendance/course-activity reuse
  // AnalyticsService's tenantId-nullable methods (see AdminAnalyticsService)
  // instead of a second implementation.
  // AcademyModule: the Center Studio is membership-gated like any other academy
  // surface, so it uses the same AcademyMembershipGuard/PermissionGuard pair —
  // which resolve through AcademyService — rather than a second notion of
  // "is this caller the owner of this Center".
  imports: [FeatureFlagsModule, AnalyticsModule, AcademyModule],
  controllers: [
    AdminController,
    AdminAcademiesController,
    AdminAnalyticsController,
    AdminThemeController,
    AdminCentersController,
    AdminCenterThemesController,
    CenterStudioController,
  ],
  providers: [
    AdminService,
    AdminAcademiesService,
    AdminAnalyticsService,
    AdminThemeService,
    AdminCentersService,
    CenterThemesService,
  ],
})
export class AdminModule {}
