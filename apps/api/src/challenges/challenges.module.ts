import { Module } from '@nestjs/common';
import { ProgressModule } from '../progress/progress.module';
import { ChallengeScoringService } from './challenge-scoring.service';
import { ChallengesAccessService } from './challenges-access.service';
import { ChallengesController } from './challenges.controller';
import { ChallengesService } from './challenges.service';
import { TeacherChallengesController } from './teacher-challenges.controller';

/**
 * Challenges — the gamified, student-facing "Challenge" concept. Deliberately
 * its own module rather than folded into AssessmentsModule: it shares grading
 * primitives (isCorrectAnswer) and the gamification/notifications engines by
 * import, not by inheritance, because a Challenge is not a Quiz — see the
 * Prisma schema comment above the Challenge model for why.
 */
@Module({
  imports: [ProgressModule],
  controllers: [ChallengesController, TeacherChallengesController],
  providers: [ChallengesService, ChallengesAccessService, ChallengeScoringService],
})
export class ChallengesModule {}
