import { Global, Module } from '@nestjs/common';
import { AcademySiteModule } from '../academy-site/academy-site.module';
import { AiGraderService } from './ai-grader.service';
import { AssignmentsController } from './assignments.controller';
import { AssignmentsService } from './assignments.service';
import { CertificatesController } from './certificates.controller';
import { CertificatesService } from './certificates.service';
import { GradingController } from './grading.controller';
import { GradingService } from './grading.service';
import { LessonAccessService } from './lesson-access.service';
import { QuizzesController } from './quizzes.controller';
import { QuizzesService } from './quizzes.service';

/**
 * Quizzes, assignments and completion certificates. Global so the playback
 * pipeline can inject CertificatesService to issue a certificate the moment a
 * video lesson pushes a course to 100% completion.
 *
 * AcademySiteModule is imported for the AI client it exports — marking a
 * written answer against its model answer speaks to the same provider, with the
 * same key handling and the same kill switch, as the site generator.
 */
@Global()
@Module({
  imports: [AcademySiteModule],
  controllers: [
    QuizzesController,
    AssignmentsController,
    CertificatesController,
    GradingController,
  ],
  providers: [
    LessonAccessService,
    QuizzesService,
    AssignmentsService,
    CertificatesService,
    AiGraderService,
    GradingService,
  ],
  exports: [CertificatesService],
})
export class AssessmentsModule {}
