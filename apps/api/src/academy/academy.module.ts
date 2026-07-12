import { Module } from '@nestjs/common';
import { AcademyController } from './academy.controller';
import { AcademyService } from './academy.service';
import { AcademyMembershipGuard } from './guards/academy-membership.guard';
import { PermissionGuard } from './guards/permission.guard';

/**
 * Academy context + authorization layer (Phase 2). Exports the service and guards
 * so later phases can make existing modules academy-aware. Registering this module
 * changes NO existing behaviour — it only adds new routes and reusable guards.
 */
@Module({
  controllers: [AcademyController],
  providers: [AcademyService, AcademyMembershipGuard, PermissionGuard],
  exports: [AcademyService, AcademyMembershipGuard, PermissionGuard],
})
export class AcademyModule {}
