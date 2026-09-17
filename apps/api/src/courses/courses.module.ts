import { Module } from '@nestjs/common';
import { AcademyModule } from '../academy/academy.module';
import { AcademySiteModule } from '../academy-site/academy-site.module';
import { LessonDescriptionService } from '../video/lesson-description.service';
import { AuditModule } from '../audit/audit.module';
import { CatalogModule } from '../catalog/catalog.module';
import { VideoModule } from '../video/video.module';
import { CoursesService } from './courses.service';
import { PublicCoursesController } from './public-courses.controller';
import { TeacherCoursesController } from './teacher-courses.controller';
import { StudentPriceService } from '../payments/student-price.service';

@Module({
  imports: [AuditModule, AcademyModule, AcademySiteModule, CatalogModule, VideoModule],
  controllers: [TeacherCoursesController, PublicCoursesController],
  providers: [LessonDescriptionService, StudentPriceService, CoursesService],
  exports: [CoursesService],
})
export class CoursesModule {}
