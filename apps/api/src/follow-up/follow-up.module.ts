import { Module } from '@nestjs/common';
import { AcademyModule } from '../academy/academy.module';
import { CenterFeesModule } from '../center-fees/center-fees.module';
import { ClassOpsModule } from '../class-ops/class-ops.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { FollowUpController } from './follow-up.controller';
import { FollowUpService } from './follow-up.service';
import { GuardianFeesView } from './guardian-fees.view';
import { FollowUpSettingsService } from './settings.service';
import { FollowUpSignalsService } from './signals.service';
import { TimelineService } from './timeline.service';

/**
 * Center Operations C5 — student follow-up and guardian connection. Owns only
 * cases and contacts; reads attendance (C2), fees (C4, via CenterFeesService
 * only) and guardians; writes nothing in any of them (follow-up.boundary.spec.ts).
 */
@Module({
  imports: [AcademyModule, ClassOpsModule, FeatureFlagsModule, CenterFeesModule],
  controllers: [FollowUpController],
  providers: [
    FollowUpService,
    FollowUpSignalsService,
    FollowUpSettingsService,
    TimelineService,
    GuardianFeesView,
  ],
  exports: [GuardianFeesView],
})
export class FollowUpModule {}
