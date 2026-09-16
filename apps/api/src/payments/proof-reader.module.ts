import { Global, Module } from '@nestjs/common';
import { AcademySiteModule } from '../academy-site/academy-site.module';
import { ProofReaderService } from './proof-reader.service';

/**
 * Reading transfer receipts, available to both places that take one.
 *
 * Its own module because the two callers sit on opposite sides of an existing
 * dependency — PaymentsModule imports WalletModule — so neither can import the
 * other. Global, and importing AcademySiteModule for `AiClient`.
 */
@Global()
@Module({
  imports: [AcademySiteModule],
  providers: [ProofReaderService],
  exports: [ProofReaderService],
})
export class ProofReaderModule {}
