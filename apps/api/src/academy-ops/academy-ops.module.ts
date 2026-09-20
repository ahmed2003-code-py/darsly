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
import { RosterController } from './roster.controller';
import { RosterService } from './roster.service';

@Module({
  imports: [AcademyModule, FeatureFlagsModule],
  controllers: [RosterController, GroupsController, AttendanceController, NeedsAttentionController],
  providers: [AcademyOpsAccessService, RosterService, GroupsService, AttendanceService, NeedsAttentionService],
})
export class AcademyOpsModule {}
