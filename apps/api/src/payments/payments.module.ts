import { Global, Module } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import { WalletController } from './wallet.controller';
import { ManualPaymentsController } from './manual-payments.controller';
import { ManualPaymentsService } from './manual-payments.service';
import { PaymentAccountsService } from './payment-accounts.service';

/** Global so EnrollmentsService / payouts / admin can record + read the ledger. */
@Global()
@Module({
  controllers: [WalletController, ManualPaymentsController],
  providers: [LedgerService, ManualPaymentsService, PaymentAccountsService],
  exports: [LedgerService],
})
export class PaymentsModule {}
