import { Module } from '@nestjs/common';
import { DailyService } from './daily.service';

/**
 * The video provider on its own, so two modules can reach it without reaching
 * each other: the classroom needs it to open rooms, and the summary job needs
 * it to fetch a transcript. Without this they would import one another, and
 * this codebase has no `forwardRef` anywhere — a cycle here would be the first.
 */
@Module({
  providers: [DailyService],
  exports: [DailyService],
})
export class DailyModule {}
