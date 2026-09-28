import { Module } from '@nestjs/common';
import { AcademyModule } from '../academy/academy.module';
import { CoursesModule } from '../courses/courses.module';
import { LiveModule } from '../live/live.module';
import { PaperImportModule } from '../paper-import/paper-import.module';
import { LiveContentController } from './live-content.controller';
import { LiveContentService } from './live-content.service';

/**
 * Live class → course content. Built on the canonical systems only (Live,
 * Courses, Exam Studio); nothing depends back on it.
 */
@Module({
  imports: [AcademyModule, LiveModule, CoursesModule, PaperImportModule],
  controllers: [LiveContentController],
  providers: [LiveContentService],
})
export class LiveContentModule {}
