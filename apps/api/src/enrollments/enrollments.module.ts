import { Module } from '@nestjs/common';
import { AcademyModule } from '../academy/academy.module';
import { AuditModule } from '../audit/audit.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { CouponsController } from './coupons.controller';
import { EnrollmentsController } from './enrollments.controller';
import { EnrollmentsService } from './enrollments.service';

@Module({
  imports: [AuditModule, AcademyModule, FeatureFlagsModule],
  controllers: [EnrollmentsController, CouponsController],
  providers: [EnrollmentsService],
})
export class EnrollmentsModule {}
