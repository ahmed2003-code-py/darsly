import { Module } from '@nestjs/common';
import { AcademyModule } from '../academy/academy.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { AcademyOpsAccessService } from './academy-ops-access.service';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';
import { NeedsAttentionController } from './needs-attention.controller';
import { NeedsAttentionService } from './needs-attention.service';
import { RoomsController } from './rooms.controller';
import { RoomsService } from './rooms.service';
import { RosterController } from './roster.controller';
import { RosterService } from './roster.service';
import { ScheduleController } from './schedule.controller';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

@Module({
  imports: [AcademyModule, FeatureFlagsModule],
  controllers: [
    RosterController,
    GroupsController,
    AttendanceController,
    NeedsAttentionController,
    RoomsController,
    SessionsController,
    ScheduleController,
  ],
  providers: [
    AcademyOpsAccessService,
    RosterService,
    GroupsService,
    AttendanceService,
    NeedsAttentionService,
    RoomsService,
    SessionsService,
  ],
  // Phase 6: AnalyticsService composes the existing at-risk-attendance rule
  // (NeedsAttentionService), resource-scope check (AcademyOpsAccessService),
  // and group listing (GroupsService, for staff-batched group metadata)
  // rather than re-deriving any of them.
  exports: [NeedsAttentionService, AcademyOpsAccessService, GroupsService],
})
export class AcademyOpsModule {}
