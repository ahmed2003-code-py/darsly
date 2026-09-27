import { Global, Module } from '@nestjs/common';
import { AcademyModule } from '../academy/academy.module';
import { WalletModule } from '../wallet/wallet.module';
import { LedgerService } from './ledger.service';
import { WalletController } from './wallet.controller';
import { ManualPaymentsController } from './manual-payments.controller';
import { ManualPaymentsService } from './manual-payments.service';
import { PaymentAccountsService } from './payment-accounts.service';
import { PaymentEventsController } from './payment-events.controller';
import { PaymentMatchingService } from './payment-matching.service';
import { PaymentTargets } from './payment-targets';
import { UnmatchedTransfersService } from './unmatched-transfers.service';
import { PaymentExpiryWorker } from './payment-expiry.worker';

/** Global so EnrollmentsService / payouts / admin can record + read the ledger. */
@Global()
@Module({
  imports: [AcademyModule, WalletModule],
  controllers: [WalletController, ManualPaymentsController, PaymentEventsController],
  providers: [
    LedgerService,
    ManualPaymentsService,
    PaymentAccountsService,
    PaymentMatchingService,
    PaymentTargets,
    UnmatchedTransfersService,
    PaymentExpiryWorker,
  ],
  exports: [LedgerService, PaymentMatchingService, PaymentTargets, PaymentAccountsService, UnmatchedTransfersService],
})
export class PaymentsModule {}
