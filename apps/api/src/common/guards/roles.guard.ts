import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtPayload, Role } from '@darsly/shared-types';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { GUEST_ALLOWED_KEY } from '../decorators/guest-allowed.decorator';

/** Enforces @Roles(...) on routes. SUPER_ADMIN passes every role check. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const user: JwtPayload | undefined = context.switchToHttp().getRequest().user;
    if (!user) return false;
    if (user.role === Role.SUPER_ADMIN) return true;
    // A guest passes only where the route admits guests (JwtAuthGuard has
    // already bound it to that route's session); nowhere else, whatever roles.
    if (user.role === Role.GUEST) {
      const allowed = this.reflector.getAllAndOverride<boolean>(GUEST_ALLOWED_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (allowed) return true;
      throw new ForbiddenException({ message: 'Not available to a guest', code: 'GUEST_SCOPE' });
    }
    if (!required.includes(user.role)) {
      throw new ForbiddenException(`Requires role: ${required.join(' | ')}`);
    }
    return true;
  }
}
