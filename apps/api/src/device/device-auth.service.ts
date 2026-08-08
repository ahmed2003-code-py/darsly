import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OtpService } from '../auth/otp.service';
import { normalizeEgyptianPhone } from '../auth/dto/auth.dto';
import { DeviceTokenService, DeviceTokens } from './device-token.service';

/**
 * OTP-based registration for the SMS listener. The verified phone number becomes
 * the device identity — the client's claimed phone is never trusted without a
 * consumed OTP. Reuses the marketplace OtpService (argon2-hashed codes, dev-mode
 * "0000") so there is one OTP implementation to secure.
 */
@Injectable()
export class DeviceAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly tokens: DeviceTokenService,
  ) {}

  async requestOtp(rawPhone: string): Promise<{ expiresInSeconds: number }> {
    const phone = normalizeEgyptianPhone(rawPhone);
    return this.otp.request(phone);
  }

  async verifyOtp(
    rawPhone: string,
    code: string,
    meta: { model?: string; appVersion?: string },
  ): Promise<DeviceTokens & { phone: string }> {
    const phone = normalizeEgyptianPhone(rawPhone);
    await this.otp.verify(phone, code); // throws on invalid/expired/too-many-attempts

    const device = await this.prisma.listenerDevice.create({
      data: { phone, model: meta.model ?? null, appVersion: meta.appVersion ?? null },
    });
    const issued = await this.tokens.issue({ id: device.id, phone });
    return { ...issued, phone };
  }

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
