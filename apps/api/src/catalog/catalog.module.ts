import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { SubjectExclusivityService } from './subject-exclusivity.service';

@Module({
  controllers: [CatalogController],
  // Shared by both discovery surfaces — courses and teachers — so the rule about
  // who a student may be shown is written once rather than per endpoint.
  providers: [SubjectExclusivityService],
  exports: [SubjectExclusivityService],
})
export class CatalogModule {}
