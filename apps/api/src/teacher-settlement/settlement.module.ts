import { Module } from '@nestjs/common';
import { AcademyModule } from '../academy/academy.module';
import { CenterFeesModule } from '../center-fees/center-fees.module';
import { ClassOpsModule } from '../class-ops/class-ops.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { TeacherSettlementController } from './settlement.controller';
import { TeacherSettlementService } from './settlement.service';

/**
 * Center Operations C8 — what the center owes and pays its teachers. Its own
 * books; reads classes (C2) and collections through CenterFeesService (C4);
 * never platform money (teacher-settlement.boundary.spec.ts).
 */
@Module({
  imports: [AcademyModule, ClassOpsModule, FeatureFlagsModule, CenterFeesModule],
  controllers: [TeacherSettlementController],
  providers: [TeacherSettlementService],
})
export class TeacherSettlementModule {}
