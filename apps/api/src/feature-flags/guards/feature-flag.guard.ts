import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AcademyContext } from '../../academy/academy-context';
import { FEATURE_FLAG_KEY } from '../feature-flag.decorator';
import { FeatureFlagKey, FeatureFlagsService } from '../feature-flags.service';

/**
 * Enforces @RequireFeature('...') against the resolved AcademyContext. A
 * disabled flag 403s the API directly — never relies on the frontend nav
 * simply hiding the entry point. Must run AFTER AcademyMembershipGuard.
 */
@Injectable()
export class FeatureFlagGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly flags: FeatureFlagsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<FeatureFlagKey>(FEATURE_FLAG_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required) return true;

    const context: AcademyContext | undefined = ctx.switchToHttp().getRequest().academyContext;
    if (!context) throw new ForbiddenException('Academy context required');

    const enabled = await this.flags.isEnabled(context.academyId, required);
    if (!enabled) throw new ForbiddenException(`Feature disabled for this academy: ${required}`);
    return true;
  }
}
