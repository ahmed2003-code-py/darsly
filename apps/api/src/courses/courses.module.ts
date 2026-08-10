import { Module } from '@nestjs/common';
import { AcademyModule } from '../academy/academy.module';
import { AuditModule } from '../audit/audit.module';
import { CatalogModule } from '../catalog/catalog.module';
import { CoursesService } from './courses.service';
import { PublicCoursesController } from './public-courses.controller';
import { TeacherCoursesController } from './teacher-courses.controller';
import { StudentPriceService } from '../payments/student-price.service';

@Module({
  imports: [AuditModule, AcademyModule, CatalogModule],
  controllers: [TeacherCoursesController, PublicCoursesController],
  providers: [StudentPriceService, CoursesService],
  exports: [CoursesService],
})
export class CoursesModule {}
