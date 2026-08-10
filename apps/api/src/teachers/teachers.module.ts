import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CatalogModule } from '../catalog/catalog.module';
import { TeachersController } from './teachers.controller';
import { TeachersService } from './teachers.service';
import { StudentPriceService } from '../payments/student-price.service';

@Module({
  imports: [AuditModule, CatalogModule],
  controllers: [TeachersController],
  providers: [StudentPriceService, TeachersService],
  exports: [TeachersService],
})
export class TeachersModule {}
