import { Module } from '@nestjs/common';
import { AcademyModule } from '../academy/academy.module';
import { AuthModule } from '../auth/auth.module';
import { StaffModule } from '../staff/staff.module';
import { GuardianController, GuardianStaffController } from './guardian.controller';
import { GuardianService } from './guardian.service';

/** Phase 2: guardians — staff-issued access links and a read-only view of their children. */
@Module({
  imports: [AcademyModule, AuthModule, StaffModule],
  controllers: [GuardianStaffController, GuardianController],
  providers: [GuardianService],
})
export class GuardianModule {}
