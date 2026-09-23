import { Global, Module } from '@nestjs/common';
import { AcademyModule } from '../academy/academy.module';
import { ProgressModule } from '../progress/progress.module';
import { AchievementsService } from './achievements.service';
import { GamificationConfigService } from './gamification.config.service';
import {
  AdminGamificationController,
  TeacherGamificationController,
} from './gamification-admin.controller';
import { GamificationAnalyticsService } from './gamification-analytics.service';
import { GamificationController } from './gamification.controller';
import { GamificationService } from './gamification.service';
import { LeaderboardService } from './leaderboard.service';
import { MissionsService } from './missions.service';
import { StudentGamificationService } from './student-gamification.service';

/**
 * Global, for the same reason NotificationsModule is: the learning flows that
 * need to report an event — playback, assessments, certificates, live, reviews
 * — are spread across the codebase, and threading an import through all of them
 * buys nothing.
 */
@Global()
@Module({
  // AcademyModule supplies the membership/permission guards behind @AcademyStaff.
  imports: [ProgressModule, AcademyModule],
  controllers: [GamificationController, TeacherGamificationController, AdminGamificationController],
  providers: [
    GamificationService,
    GamificationConfigService,
    AchievementsService,
    MissionsService,
    LeaderboardService,
    StudentGamificationService,
    GamificationAnalyticsService,
  ],
  exports: [
    GamificationService,
    GamificationConfigService,
    LeaderboardService,
    AchievementsService,
    MissionsService,
    // Phase 6: academy/platform analytics compose engagement + retention from
    // here rather than re-deriving them — see AnalyticsService.
    GamificationAnalyticsService,
  ],
})
export class GamificationModule {}
