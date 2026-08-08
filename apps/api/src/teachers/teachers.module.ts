import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { TeachersController } from './teachers.controller';
import { TeachersService } from './teachers.service';
import { StudentPriceService } from '../payments/student-price.service';

@Module({
  imports: [AuditModule],
  controllers: [TeachersController],
  providers: [StudentPriceService, TeachersService],
  exports: [TeachersService],
})
export class TeachersModule {}
