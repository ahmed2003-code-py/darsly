import { Global, Module } from '@nestjs/common';
import { AcademyModule } from '../academy/academy.module';
import { AuditModule } from '../audit/audit.module';
import { PayoutsController } from './payouts.controller';
import { PayoutsService } from './payouts.service';

/** Global so AdminModule can reuse PayoutsService for the processing queue. */
@Global()
@Module({
  imports: [AuditModule, AcademyModule],
  controllers: [PayoutsController],
  providers: [PayoutsService],
  exports: [PayoutsService],
})
export class PayoutsModule {}
