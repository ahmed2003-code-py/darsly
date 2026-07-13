import { Global, Module } from '@nestjs/common';
import { AcademyModule } from '../academy/academy.module';
import { LedgerService } from './ledger.service';
import { WalletController } from './wallet.controller';
import { ManualPaymentsController } from './manual-payments.controller';
import { ManualPaymentsService } from './manual-payments.service';
import { PaymentAccountsService } from './payment-accounts.service';
import { PaymentEventsController } from './payment-events.controller';
import { PaymentMatchingService } from './payment-matching.service';

/** Global so EnrollmentsService / payouts / admin can record + read the ledger. */
@Global()
@Module({
  imports: [AcademyModule],
  controllers: [WalletController, ManualPaymentsController, PaymentEventsController],
  providers: [LedgerService, ManualPaymentsService, PaymentAccountsService, PaymentMatchingService],
  exports: [LedgerService],
})
export class PaymentsModule {}
