import { Module } from '@nestjs/common';
import { AcademyModule } from '../academy/academy.module';
import { CenterFeesModule } from '../center-fees/center-fees.module';
import { ClassOpsModule } from '../class-ops/class-ops.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { DailyOpsController } from './daily-ops.controller';
import { DailyOpsService } from './daily-ops.service';

/**
 * Center Operations C7 — the day's operations and its close. Reads C2–C6;
 * writes only CenterDayClose (daily-ops.boundary.spec.ts).
 */
@Module({
  imports: [AcademyModule, ClassOpsModule, FeatureFlagsModule, CenterFeesModule],
  controllers: [DailyOpsController],
  providers: [DailyOpsService],
})
export class DailyOpsModule {}
