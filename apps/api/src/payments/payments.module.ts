import { Global, Module } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import { WalletController } from './wallet.controller';

/** Global so EnrollmentsService / payouts / admin can record + read the ledger. */
@Global()
@Module({
  controllers: [WalletController],
  providers: [LedgerService],
  exports: [LedgerService],
})
export class PaymentsModule {}
