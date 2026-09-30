import { Module } from '@nestjs/common';
import { AcademyModule } from '../academy/academy.module';
import { AcademyOpsModule } from '../academy-ops/academy-ops.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { CenterStudentsController } from './center-students.controller';
import { CenterStudentsService } from './center-students.service';
import { StudentImportService } from './student-import.service';

/** Center Operations C1 — the academy's student register. */
@Module({
  imports: [AcademyModule, AcademyOpsModule, FeatureFlagsModule],
  controllers: [CenterStudentsController],
  providers: [CenterStudentsService, StudentImportService],
})
export class CenterStudentsModule {}
