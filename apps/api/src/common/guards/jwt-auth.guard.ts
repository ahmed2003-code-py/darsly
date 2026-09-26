import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { JwtPayload, Role } from '@darsly/shared-types';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { GUEST_ALLOWED_KEY } from '../decorators/guest-allowed.decorator';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Global guard: verifies the Bearer access token and rejects tokens whose
 * device session has been revoked (kicked device / logout / admin ban).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest();
    const token = this.extractToken(request);

    /**
     * Public routes still get a best-effort user attach so responses can be
     * viewer-aware (e.g. enrollment state on a public course page).
     *
     * "Best effort" used to mean two fewer checks than the protected path, and
     * both are now back:
     *
     *  - `algorithms` is pinned. This was never forgeable — `jsonwebtoken`
     *    with a string secret already confines itself to the HMAC family and
     *    rejects `alg: none` — but the protected path states the algorithm it
     *    accepts, and a security property that holds by library default rather
     *    than by declaration is one upgrade away from not holding.
     *
     *  - The session is checked for revocation. Without it a kicked or banned
     *    device kept receiving viewer-aware data on public pages until its
     *    token expired naturally: the ban applied everywhere except the pages
     *    anyone can read, which is not what "revoked" means to the person who
     *    pressed the button.
     *
     * Any failure still falls through to anonymous rather than refusing — a
     * public page must stay public for a viewer whose token is merely stale.
     */
    if (isPublic) {
      if (token) {
        try {
          const payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
            secret: process.env.JWT_ACCESS_SECRET,
            algorithms: ['HS256'],
          });
          // A guest token is for one classroom, not for being "someone" on
          // public pages: it is treated as anonymous there.
          if (payload.role !== Role.GUEST && (await this.sessionIsLive(payload))) request.user = payload;
        } catch {
          /* anonymous */
        }
      }
      return true;
    }

    if (!token) throw new UnauthorizedException('Missing access token');

    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
        secret: process.env.JWT_ACCESS_SECRET,
        algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    // Session revocation check: a kicked/banned device dies even before the
    // short-lived access token expires.
    const session = await this.prisma.deviceSession.findUnique({
      where: { id: payload.sessionId },
      select: { revokedAt: true, user: { select: { isActive: true } } },
    });
    if (!session || session.revokedAt) {
      throw new UnauthorizedException('Session revoked');
    }
    if (!session.user.isActive) {
      throw new UnauthorizedException('Account disabled');
    }

    if (payload.role === Role.GUEST) this.assertGuestScope(context, request, payload);

    request.user = payload;
    return true;
  }

  /**
   * A guest token opens one session's classroom and nothing else: the route
   * must be marked @GuestAllowed, and the session in its URL must be the one
   * the token was issued for. Everything else is refused before any handler
   * runs, whatever that handler's own checks would have said.
   */
  private assertGuestScope(context: ExecutionContext, request: { params?: Record<string, string> }, payload: JwtPayload) {
    const allowed = this.reflector.getAllAndOverride<boolean>(GUEST_ALLOWED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const target = request.params?.id;
    if (!allowed || !payload.liveSessionId || !target || target !== payload.liveSessionId) {
      throw new ForbiddenException({ message: 'Not available to a guest', code: 'GUEST_SCOPE' });
    }
  }

  /** Whether this token's device session is still usable — the same question
   *  the protected path asks, asked without throwing. */
  private async sessionIsLive(payload: JwtPayload): Promise<boolean> {
    if (!payload?.sessionId) return false;
    const session = await this.prisma.deviceSession.findUnique({
      where: { id: payload.sessionId },
      select: { revokedAt: true, user: { select: { isActive: true } } },
    });
    return !!session && !session.revokedAt && session.user.isActive;
  }

  private extractToken(request: { headers: Record<string, string> }): string | undefined {
    const [type, token] = request.headers['authorization']?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
