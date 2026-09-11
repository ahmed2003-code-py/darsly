import { Module } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';

/**
 * Student prepaid wallet. LedgerService (Global, from PaymentsModule),
 * NotificationsService (Global) and PrismaService (Global) are all injected
 * without importing anything here.
 */
@Module({
  controllers: [WalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
