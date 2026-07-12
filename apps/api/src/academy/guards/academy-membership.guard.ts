import { CanActivate, ExecutionContext, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtPayload } from '@darsly/shared-types';
import { AcademyService } from '../academy.service';

/**
 * Resolves the target academy for the request and requires the caller to hold an
 * ACTIVE membership in it. Attaches the AcademyContext to the request. Any miss
 * (no academy, no membership, feature disabled) is a 404 — never reveal existence.
 * Route-level only; existing endpoints are untouched.
 */
@Injectable()
export class AcademyMembershipGuard implements CanActivate {
  constructor(private readonly academy: AcademyService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    if (!this.academy.isEnabled()) throw new NotFoundException('Academy not found');

    const user: JwtPayload | undefined = req.user;
    if (!user) throw new UnauthorizedException();

    const academyId = await this.academy.resolveAcademyId(req);
    if (!academyId) throw new NotFoundException('Academy not found');

    const context = await this.academy.buildContext(user.sub, academyId, user.role);
    if (!context) throw new NotFoundException('Academy not found');

    req.academyContext = context;
    return true;
  }
}
