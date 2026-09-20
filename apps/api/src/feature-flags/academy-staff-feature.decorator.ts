import { applyDecorators, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { RequirePermission } from '../academy/academy-context';
import { AcademyMembershipGuard } from '../academy/guards/academy-membership.guard';
import { PermissionGuard } from '../academy/guards/permission.guard';
import { Capability } from '../academy/permissions';
import { RequireFeature } from './feature-flag.decorator';
import { FeatureFlagGuard } from './guards/feature-flag.guard';
import { FeatureFlagKey } from './feature-flags.service';

/**
 * @AcademyStaff(capability) plus a feature-flag gate: resolve the active
 * academy, require an ACTIVE membership, require the named capability, AND
 * require the named feature to be enabled for that academy. Same
 * OWNER-passes/everyone-else-needs-the-capability semantics as @AcademyStaff;
 * on top of that, a disabled flag 403s the request server-side regardless of
 * capability, per the FeatureFlagGuard convention from Phase 1.
 */
export const AcademyStaffFeature = (perm: Capability, feature: FeatureFlagKey) =>
  applyDecorators(
    UseGuards(AcademyMembershipGuard, PermissionGuard, FeatureFlagGuard),
    RequirePermission(perm),
    RequireFeature(feature),
    ApiBearerAuth(),
  );
