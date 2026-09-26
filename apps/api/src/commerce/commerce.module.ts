import { Global, Module } from '@nestjs/common';
import { CommercialTermsController } from './commercial-terms.controller';
import { CommercialTermsService } from './commercial-terms.service';

/** Darsly's commercial terms. Global: Live pricing and admin both read them. */
@Global()
@Module({
  controllers: [CommercialTermsController],
  providers: [CommercialTermsService],
  exports: [CommercialTermsService],
})
export class CommerceModule {}
