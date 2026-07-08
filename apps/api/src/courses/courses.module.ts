import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CoursesService } from './courses.service';
import { PublicCoursesController } from './public-courses.controller';
import { TeacherCoursesController } from './teacher-courses.controller';

@Module({
  imports: [AuditModule],
  controllers: [TeacherCoursesController, PublicCoursesController],
  providers: [CoursesService],
  exports: [CoursesService],
})
export class CoursesModule {}
