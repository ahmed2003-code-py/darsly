import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthTokens, JwtPayload, Role } from '@darsly/shared-types';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';

export interface DeviceContext {
  deviceName?: string;
  ip?: string;
  userAgent?: string;
}

/**
 * Issues JWT pairs bound to a DeviceSession row.
 * Security suite (B): logging in beyond the allowed concurrent-device count
 * revokes the oldest session ("new login kicks the oldest device").
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  private get maxSessions() {
    return Number(process.env.MAX_CONCURRENT_SESSIONS_DEFAULT ?? 2);
  }

  async createSession(
    user: { id: string; role: Role; tenantId?: string },
    device: DeviceContext,
  ): Promise<AuthTokens & { kickedSessions: number }> {
    // Enforce the device cap BEFORE creating the new session.
    const active = await this.prisma.deviceSession.findMany({
      where: { userId: user.id, revokedAt: null },
      orderBy: { lastSeenAt: 'asc' },
    });
    const overflow = active.length - this.maxSessions + 1;
    let kicked = 0;
    if (overflow > 0) {
      const toKick = active.slice(0, overflow);
      await this.prisma.deviceSession.updateMany({
        where: { id: { in: toKick.map((s) => s.id) } },
        data: { revokedAt: new Date(), revokedReason: 'SESSION_LIMIT_KICK' },
      });
      kicked = toKick.length;
    }

    const session = await this.prisma.deviceSession.create({
      data: {
        userId: user.id,
        refreshTokenHash: 'pending',
        deviceName: device.deviceName,
        ip: device.ip,
        userAgent: device.userAgent,
      },
    });

    const tokens = await this.signPair({ ...user, sessionId: session.id });
    await this.prisma.deviceSession.update({
      where: { id: session.id },
      data: { refreshTokenHash: await argon2.hash(tokens.refreshToken) },
    });
    return { ...tokens, kickedSessions: kicked };
  }

  /** Refresh-token rotation: each refresh invalidates the previous token. */
  async rotate(refreshToken: string): Promise<AuthTokens> {
    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(refreshToken, {
        secret: process.env.JWT_REFRESH_SECRET,
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const session = await this.prisma.deviceSession.findUnique({
      where: { id: payload.sessionId },
    });
    if (!session || session.revokedAt) throw new UnauthorizedException('Session revoked');

    const matches = await argon2.verify(session.refreshTokenHash, refreshToken);
    if (!matches) {
      // Token reuse after rotation ⇒ likely stolen. Kill the session.
      await this.revokeSession(session.id, 'REFRESH_REUSE_DETECTED');
      throw new UnauthorizedException('Refresh token reuse detected — session revoked');
    }

    const tokens = await this.signPair({
      sub: payload.sub,
      role: payload.role,
      tenantId: payload.tenantId,
      sessionId: session.id,
    });
    await this.prisma.deviceSession.update({
      where: { id: session.id },
      data: { refreshTokenHash: await argon2.hash(tokens.refreshToken), lastSeenAt: new Date() },
    });
    return tokens;
  }

  async revokeSession(sessionId: string, reason: string): Promise<void> {
    await this.prisma.deviceSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  private async signPair(
    input: { sub?: string; id?: string; role: Role; tenantId?: string; sessionId: string },
  ): Promise<AuthTokens> {
    const payload: JwtPayload = {
      sub: input.sub ?? input.id!,
      role: input.role,
      tenantId: input.tenantId,
      sessionId: input.sessionId,
    };
    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: process.env.JWT_ACCESS_SECRET,
        expiresIn: Number(process.env.JWT_ACCESS_TTL ?? 900),
      }),
      this.jwtService.signAsync(payload, {
        secret: process.env.JWT_REFRESH_SECRET,
        expiresIn: Number(process.env.JWT_REFRESH_TTL ?? 2_592_000),
      }),
    ]);
    return { accessToken, refreshToken };
  }
}
