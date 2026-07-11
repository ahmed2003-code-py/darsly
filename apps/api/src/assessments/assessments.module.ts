import { Global, Module } from '@nestjs/common';
import { AssignmentsController } from './assignments.controller';
import { AssignmentsService } from './assignments.service';
import { CertificatesController } from './certificates.controller';
import { CertificatesService } from './certificates.service';
import { LessonAccessService } from './lesson-access.service';
import { QuizzesController } from './quizzes.controller';
import { QuizzesService } from './quizzes.service';

/**
 * Quizzes, assignments and completion certificates. Global so the playback
 * pipeline can inject CertificatesService to issue a certificate the moment a
 * video lesson pushes a course to 100% completion.
 */
@Global()
@Module({
  controllers: [QuizzesController, AssignmentsController, CertificatesController],
  providers: [LessonAccessService, QuizzesService, AssignmentsService, CertificatesService],
  exports: [CertificatesService],
})
export class AssessmentsModule {}
