import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CouponsController } from './coupons.controller';
import { EnrollmentsController } from './enrollments.controller';
import { EnrollmentsService } from './enrollments.service';

@Module({
  imports: [AuditModule],
  controllers: [EnrollmentsController, CouponsController],
  providers: [EnrollmentsService],
})
export class EnrollmentsModule {}
