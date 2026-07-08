import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { UploadsController } from './uploads.controller';

@Module({
  imports: [AuditModule],
  controllers: [UploadsController],
})
export class UploadsModule {}
