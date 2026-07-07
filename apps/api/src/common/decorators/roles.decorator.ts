import { SetMetadata } from '@nestjs/common';
import { Role } from '@darsly/shared-types';

export const ROLES_KEY = 'roles';
/** Restricts a route to the given roles. SUPER_ADMIN always passes. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
