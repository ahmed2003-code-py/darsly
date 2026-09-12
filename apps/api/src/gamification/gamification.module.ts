import { Global, Module } from '@nestjs/common';
import { ProgressModule } from '../progress/progress.module';
import { AchievementsService } from './achievements.service';
import { GamificationConfigService } from './gamification.config.service';
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
  imports: [ProgressModule],
  controllers: [GamificationController],
  providers: [
    GamificationService,
    GamificationConfigService,
    AchievementsService,
    MissionsService,
    LeaderboardService,
    StudentGamificationService,
  ],
  exports: [GamificationService, GamificationConfigService, LeaderboardService, AchievementsService, MissionsService],
})
export class GamificationModule {}
