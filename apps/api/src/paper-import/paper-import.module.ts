import { Module } from '@nestjs/common';
import { AcademyModule } from '../academy/academy.module';
import { AcademySiteModule } from '../academy-site/academy-site.module';
import { AuditModule } from '../audit/audit.module';
import { CoursesModule } from '../courses/courses.module';
import { ExamBuilderService } from './exam-builder.service';
import { ExamExportService } from './exam-export.service';
import { PaperImportController } from './paper-import.controller';
import { PaperImportCoreModule } from './paper-import-core.module';
import { PaperImportService } from './paper-import.service';

/**
 * Paper exam import: the teacher-facing half.
 *
 * `CoursesModule` and the (global) assessments module are imported for the
 * services that already know how to make a course, a lesson and a quiz —
 * making an exam here means calling those, not writing rows.
 */
@Module({
  imports: [AcademyModule, AuditModule, AcademySiteModule, CoursesModule, PaperImportCoreModule],
  controllers: [PaperImportController],
  providers: [PaperImportService, ExamBuilderService, ExamExportService],
  exports: [ExamExportService],
})
export class PaperImportModule {}
