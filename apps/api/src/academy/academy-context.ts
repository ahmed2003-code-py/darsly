import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { AcademyRole, MembershipStatus } from '@prisma/client';
import type { Capability } from './permissions';

/**
 * The resolved per-request academy authority. Services receive this instead of a
 * bare tenantId string, so authorization is explicit and testable.
 */
export interface AcademyContext {
  academyId: string;
  userId: string;
  role: AcademyRole;
  status: MembershipStatus;
  /** true for the platform super admin acting via an explicit platform context */
  isPlatformAdmin: boolean;
  can(capability: Capability): boolean;
}

/** Injects the resolved AcademyContext (populated by AcademyMembershipGuard). */
export const CurrentAcademy = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AcademyContext | undefined =>
    ctx.switchToHttp().getRequest().academyContext,
);

export const PERMISSION_KEY = 'academy_permission';
/** Requires a named capability inside the resolved academy (PermissionGuard). */
export const RequirePermission = (capability: Capability) =>
  SetMetadata(PERMISSION_KEY, capability);
