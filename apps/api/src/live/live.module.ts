import { Module } from '@nestjs/common';
import { AcademyModule } from '../academy/academy.module';
import { AcademySiteModule } from '../academy-site/academy-site.module';
import { DailyModule } from './daily.module';
import { LiveController } from './live.controller';
import { LiveService } from './live.service';

@Module({
  // AcademySiteModule for the AI job queue the summary runs on — the one this
  // project already has, rather than a second queue beside it.
  imports: [AcademyModule, AcademySiteModule, DailyModule],
  controllers: [LiveController],
  providers: [LiveService],
  // The gateway asks it who is allowed into a classroom's socket room.
  exports: [LiveService],
})
export class LiveModule {}
