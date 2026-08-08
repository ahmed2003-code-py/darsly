import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createParamDecorator } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DeviceJwtPayload } from './device-token.service';

/**
 * Controller-level guard for the SMS listener. The device routes are @Public() to
 * the global JwtAuthGuard (which validates marketplace-user sessions); this guard
 * then validates the device-scoped Bearer token instead — verifying the `device`
 * claim and that the ListenerDevice is still registered (not revoked).
 *
 * Attaches the device to `req.device` for @CurrentDevice().
 */
@Injectable()
export class DeviceAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const [type, token] = req.headers['authorization']?.split(' ') ?? [];
    if (type !== 'Bearer' || !token) throw new UnauthorizedException('Missing device token');

    let payload: DeviceJwtPayload;
    try {
      payload = await this.jwt.verifyAsync<DeviceJwtPayload>(token, {
        secret: process.env.JWT_ACCESS_SECRET,
        algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired device token');
    }
    if (payload.typ !== 'device') throw new UnauthorizedException('Not a device token');

    const device = await this.prisma.listenerDevice.findUnique({
      where: { id: payload.sub },
      select: { id: true, phone: true, revokedAt: true },
    });
    if (!device || device.revokedAt) throw new UnauthorizedException('Device revoked');

    req.device = device;
    return true;
  }
}

export interface CurrentDeviceCtx {
  id: string;
  phone: string;
}

/** Injects the authenticated ListenerDevice: { id, phone }. */
export const CurrentDevice = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CurrentDeviceCtx => ctx.switchToHttp().getRequest().device,
);
