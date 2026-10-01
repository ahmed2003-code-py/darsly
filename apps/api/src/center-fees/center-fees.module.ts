import { Module } from '@nestjs/common';
import { AcademyModule } from '../academy/academy.module';
import { ClassOpsModule } from '../class-ops/class-ops.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { CenterFeesController } from './center-fees.controller';
import { CenterFeesService } from './center-fees.service';
import { CenterFeesWorker } from './center-fees.worker';
import { FeePlansService } from './fee-plans.service';

/**
 * Center Operations C4 — the center's own fees, collections and receipts.
 * Deliberately imports nothing from payments, ledger, wallet or payouts:
 * center money is not platform money (center-fees.boundary.spec.ts).
 */
@Module({
  imports: [AcademyModule, ClassOpsModule, FeatureFlagsModule],
  controllers: [CenterFeesController],
  providers: [CenterFeesService, FeePlansService, CenterFeesWorker],
  // C5 reads fees only through CenterFeesService (never the models).
  exports: [CenterFeesService],
})
export class CenterFeesModule {}
