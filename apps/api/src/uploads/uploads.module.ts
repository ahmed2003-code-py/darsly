import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { VideoModule } from '../video/video.module';
import { UploadsController } from './uploads.controller';

@Module({
  imports: [AuditModule, VideoModule],
  controllers: [UploadsController],
})
export class UploadsModule {}
