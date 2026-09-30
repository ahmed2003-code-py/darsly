import { Module } from '@nestjs/common';
import { AcademyModule } from '../academy/academy.module';
import { ClassOpsModule } from '../class-ops/class-ops.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { DeskController } from './desk.controller';
import { DeskService } from './desk.service';

/** Center Operations C3 — QR student cards and the reception desk. */
@Module({
  imports: [AcademyModule, ClassOpsModule, FeatureFlagsModule],
  controllers: [DeskController],
  providers: [DeskService],
})
export class DeskModule {}
