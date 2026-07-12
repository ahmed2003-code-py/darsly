import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AcademyContext, PERMISSION_KEY } from '../academy-context';
import { Capability } from '../permissions';

/**
 * Enforces @RequirePermission('...') against the resolved AcademyContext.
 * Must run AFTER AcademyMembershipGuard (which populates the context).
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Capability>(PERMISSION_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required) return true;

    const context: AcademyContext | undefined = ctx.switchToHttp().getRequest().academyContext;
    if (!context) throw new ForbiddenException('Academy context required');
    if (!context.can(required)) throw new ForbiddenException(`Requires permission: ${required}`);
    return true;
  }
}
