import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { JwtPayload } from '@darsly/shared-types';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
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

    // Public routes still get a best-effort user attach so responses can be
    // viewer-aware (e.g. enrollment state on a public course page).
    if (isPublic) {
      if (token) {
        try {
          request.user = await this.jwtService.verifyAsync<JwtPayload>(token, {
            secret: process.env.JWT_ACCESS_SECRET,
          });
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

    request.user = payload;
    return true;
  }

  private extractToken(request: { headers: Record<string, string> }): string | undefined {
    const [type, token] = request.headers['authorization']?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
