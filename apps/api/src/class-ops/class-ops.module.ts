import { Module } from '@nestjs/common';
import { AcademyModule } from '../academy/academy.module';
import { AcademyOpsModule } from '../academy-ops/academy-ops.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { ClassAttendanceService } from './class-attendance.service';
import { ClassOpsController } from './class-ops.controller';
import { ClassOpsWorker } from './class-ops.worker';
import { ClassScheduleService } from './class-schedule.service';

/** Center Operations C2 — weekly timetables, real classes, their attendance. */
@Module({
  imports: [AcademyModule, AcademyOpsModule, FeatureFlagsModule],
  controllers: [ClassOpsController],
  providers: [ClassScheduleService, ClassAttendanceService, ClassOpsWorker],
  // The reception desk (C3) checks in through the same attendance engine.
  exports: [ClassScheduleService, ClassAttendanceService],
})
export class ClassOpsModule {}
