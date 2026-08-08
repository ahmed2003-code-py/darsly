import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Device-scoped JWTs for the SMS listener. Mirrors the marketplace TokenService
 * (rotation + refresh-reuse detection) but is bound to a ListenerDevice row and
 * carries a distinct `typ: 'device'` claim, so a device token can never satisfy
 * a user-facing route and vice-versa. Signed with the same JWT secrets to avoid
 * a second key to manage.
 */

export interface DeviceJwtPayload {
  sub: string; // ListenerDevice.id
  typ: 'device';
  phone: string;
  jti?: string; // unique per token so rotations are never byte-identical
}

export interface DeviceTokens {
  accessToken: string;
  refreshToken: string;
  deviceId: string;
}

@Injectable()
export class DeviceTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  private get accessTtl() {
    return Number(process.env.DEVICE_JWT_ACCESS_TTL ?? process.env.JWT_ACCESS_TTL ?? 900);
  }
  private get refreshTtl() {
    return Number(process.env.DEVICE_JWT_REFRESH_TTL ?? process.env.JWT_REFRESH_TTL ?? 2_592_000);
  }

  async issue(device: { id: string; phone: string }): Promise<DeviceTokens> {
    const tokens = await this.signPair(device);
    await this.prisma.listenerDevice.update({
      where: { id: device.id },
      data: { refreshTokenHash: await argon2.hash(tokens.refreshToken), lastSeenAt: new Date() },
    });
    return tokens;
  }

  /** Rotate: each refresh invalidates the previous refresh token for the device. */
  async rotate(refreshToken: string): Promise<DeviceTokens> {
    let payload: DeviceJwtPayload;
    try {
      payload = await this.jwt.verifyAsync<DeviceJwtPayload>(refreshToken, {
        secret: process.env.JWT_REFRESH_SECRET,
        algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (payload.typ !== 'device') throw new UnauthorizedException('Not a device token');

    const device = await this.prisma.listenerDevice.findUnique({ where: { id: payload.sub } });
    if (!device || device.revokedAt) throw new UnauthorizedException('Device revoked');
    if (!device.refreshTokenHash) throw new UnauthorizedException('Device has no active session');

    const matches = await argon2.verify(device.refreshTokenHash, refreshToken);
    if (!matches) {
      // Presenting a rotated-away refresh token ⇒ likely stolen ⇒ kill the device.
      await this.revoke(device.id, 'REFRESH_REUSE_DETECTED');
      throw new UnauthorizedException('Refresh token reuse detected — device revoked');
    }

    return this.issue({ id: device.id, phone: device.phone });
  }

  async revoke(deviceId: string, reason: string): Promise<void> {
    await this.prisma.listenerDevice.updateMany({
      where: { id: deviceId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason, refreshTokenHash: null },
    });
  }

  private async signPair(device: { id: string; phone: string }): Promise<DeviceTokens> {
    const payload: DeviceJwtPayload = { sub: device.id, typ: 'device', phone: device.phone, jti: randomUUID() };
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(payload, {
        secret: process.env.JWT_ACCESS_SECRET,
        expiresIn: this.accessTtl,
      }),
      this.jwt.signAsync(payload, {
        secret: process.env.JWT_REFRESH_SECRET,
        expiresIn: this.refreshTtl,
      }),
    ]);
    return { accessToken, refreshToken, deviceId: device.id };
  }
}
