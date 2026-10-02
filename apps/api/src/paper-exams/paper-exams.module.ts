import { Module } from '@nestjs/common';
import { AcademyModule } from '../academy/academy.module';
import { AcademyOpsModule } from '../academy-ops/academy-ops.module';
import { ClassOpsModule } from '../class-ops/class-ops.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { GradesReadService } from './grades-read.service';
import { PaperExamsController } from './paper-exams.controller';
import { PaperExamsService } from './paper-exams.service';

/**
 * Center Operations C6 — paper exams and grades. Its own source of truth:
 * never the online Quiz / Assignment / Challenge / PaperImport models, never
 * AI, never money (paper-exams.boundary.spec.ts). Other phases read grades
 * only through GradesReadService (C5's LOW_GRADE and timeline, the guardian
 * portal).
 */
@Module({
  imports: [AcademyModule, AcademyOpsModule, ClassOpsModule, FeatureFlagsModule],
  controllers: [PaperExamsController],
  providers: [PaperExamsService, GradesReadService],
  exports: [GradesReadService],
})
export class PaperExamsModule {}
