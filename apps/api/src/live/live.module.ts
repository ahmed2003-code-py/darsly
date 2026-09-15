import { Module } from '@nestjs/common';
import { AcademyModule } from '../academy/academy.module';
import { LiveController } from './live.controller';
import { LiveService } from './live.service';
import { DailyService } from './daily.service';

@Module({
  imports: [AcademyModule],
  controllers: [LiveController],
  providers: [LiveService, DailyService],
})
export class LiveModule {}
