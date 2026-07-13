import { applyDecorators, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { RequirePermission } from './academy-context';
import { AcademyMembershipGuard } from './guards/academy-membership.guard';
import { PermissionGuard } from './guards/permission.guard';
import { Capability } from './permissions';

/**
 * One decorator for every academy staff route: resolve the active academy,
 * require an ACTIVE membership, and enforce a named capability in it. The OWNER
 * (via JWT-tenant fallback) and any staff member with the capability pass;
 * everyone else gets 404/403. Replaces `@Roles(TEACHER)` + JWT tenantId.
 */
export const AcademyStaff = (perm: Capability) =>
  applyDecorators(
    UseGuards(AcademyMembershipGuard, PermissionGuard),
    RequirePermission(perm),
    ApiBearerAuth(),
  );
