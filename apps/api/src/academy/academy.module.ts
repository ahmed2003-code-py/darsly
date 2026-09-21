import { Module } from '@nestjs/common';
import { AcademyController } from './academy.controller';
import { AcademyService } from './academy.service';
import { AcademyMembershipGuard } from './guards/academy-membership.guard';
import { InvitationLinksController } from './invitation-links.controller';
import { InvitationLinksService } from './invitation-links.service';
import { PermissionGuard } from './guards/permission.guard';

/**
 * Academy context + authorization layer (Phase 2). Exports the service and guards
 * so later phases can make existing modules academy-aware. Registering this module
 * changes NO existing behaviour — it only adds new routes and reusable guards.
 * Phase 3 adds shareable staff invitation links alongside the existing email invite.
 */
@Module({
  controllers: [AcademyController, InvitationLinksController],
  providers: [AcademyService, AcademyMembershipGuard, PermissionGuard, InvitationLinksService],
  exports: [AcademyService, AcademyMembershipGuard, PermissionGuard],
})
export class AcademyModule {}
