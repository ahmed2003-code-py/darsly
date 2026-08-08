import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { DeviceTokenService } from './device-token.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Device token rotation + refresh-reuse detection, with a real JwtService/argon2
 * and an in-memory ListenerDevice row.
 */
describe('DeviceTokenService', () => {
  const OLD_ENV = process.env;
  let jwt: JwtService;
  let device: any;
  let prisma: PrismaService;
  let service: DeviceTokenService;

  beforeEach(() => {
    process.env = { ...OLD_ENV, JWT_ACCESS_SECRET: 'a'.repeat(40), JWT_REFRESH_SECRET: 'b'.repeat(40) };
    jwt = new JwtService({});
    device = { id: 'dev1', phone: '+201012345678', refreshTokenHash: null, revokedAt: null };
    prisma = {
      listenerDevice: {
        update: jest.fn().mockImplementation(({ data }) => {
          Object.assign(device, data);
          return device;
        }),
        updateMany: jest.fn().mockImplementation(({ data }) => {
          Object.assign(device, data);
          return { count: 1 };
        }),
        findUnique: jest.fn().mockImplementation(() => (device ? { ...device } : null)),
      },
    } as unknown as PrismaService;
    service = new DeviceTokenService(jwt, prisma);
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it('issues a device access+refresh pair carrying the device claim', async () => {
    const t = await service.issue({ id: 'dev1', phone: '+201012345678' });
    expect(t.deviceId).toBe('dev1');
    const decoded: any = jwt.verify(t.accessToken, { secret: process.env.JWT_ACCESS_SECRET });
    expect(decoded).toMatchObject({ sub: 'dev1', typ: 'device', phone: '+201012345678' });
  });

  it('rotates the refresh token (a new pair is issued and stored)', async () => {
    const first = await service.issue({ id: 'dev1', phone: '+201012345678' });
    const rotated = await service.rotate(first.refreshToken);
    expect(rotated.refreshToken).not.toBe(first.refreshToken);
  });

  it('detects refresh-token reuse and revokes the device', async () => {
    const first = await service.issue({ id: 'dev1', phone: '+201012345678' });
    await service.rotate(first.refreshToken); // rotates hash away from `first`
    await expect(service.rotate(first.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(device.revokedAt).toBeTruthy();
    expect(device.revokedReason).toBe('REFRESH_REUSE_DETECTED');
  });

  it('rejects a rotate on a revoked device', async () => {
    await service.issue({ id: 'dev1', phone: '+201012345678' });
    device.revokedAt = new Date();
    const anotherRefresh = await jwt.signAsync(
      { sub: 'dev1', typ: 'device', phone: '+201012345678' },
      { secret: process.env.JWT_REFRESH_SECRET, expiresIn: 100 },
    );
    await expect(service.rotate(anotherRefresh)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a non-device token', async () => {
    const userRefresh = await jwt.signAsync(
      { sub: 'u1', role: 'STUDENT' },
      { secret: process.env.JWT_REFRESH_SECRET, expiresIn: 100 },
    );
    await expect(service.rotate(userRefresh)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
