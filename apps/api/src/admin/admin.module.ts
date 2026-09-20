import { Module } from '@nestjs/common';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { AdminAcademiesController } from './admin-academies.controller';
import { AdminAcademiesService } from './admin-academies.service';
import { AdminAnalyticsController } from './admin-analytics.controller';
import { AdminAnalyticsService } from './admin-analytics.service';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [FeatureFlagsModule],
  controllers: [AdminController, AdminAcademiesController, AdminAnalyticsController],
  providers: [AdminService, AdminAcademiesService, AdminAnalyticsService],
})
export class AdminModule {}
