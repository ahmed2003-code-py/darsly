import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Read-side of a registered listener device.
 *
 * Registration itself lives in DeviceEnrollmentService — an admin-issued code,
 * not an SMS OTP. See the note there for why.
 */
@Injectable()
export class DeviceAuthService {
  constructor(private readonly prisma: PrismaService) {}

  async me(deviceId: string) {
    const device = await this.prisma.listenerDevice.findUnique({
      where: { id: deviceId },
      select: { id: true, phone: true, platform: true, model: true, appVersion: true, revokedAt: true, lastSeenAt: true, createdAt: true },
    });
    return device;
  }

  async heartbeat(deviceId: string): Promise<{ ok: true; serverTime: string }> {
    await this.prisma.listenerDevice.update({
      where: { id: deviceId },
      data: { lastSeenAt: new Date() },
    });
    return { ok: true, serverTime: new Date().toISOString() };
  }
}
