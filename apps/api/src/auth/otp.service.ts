import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomInt } from 'crypto';
import { AuthConfig } from './auth.config';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Phone OTP issuing/verification.
 * Dev mode (OTP_DEV_MODE=true): codes are logged, and "0000" is accepted as a
 * universal code so the flow is testable without an SMS provider.
 * Production: plug an SMS gateway into `deliver()` (kept as a single seam).
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AuthConfig,
  ) {}

  private get ttlSeconds() {
    return this.config.otpTtlSeconds;
  }
  private get maxAttempts() {
    return this.config.otpMaxAttempts;
  }
  private get devMode() {
    // Default OFF, and never on in production — the "0000" universal code and
    // logged OTPs must never be reachable on a real deploy. Both halves of
    // that live in AuthConfig.otpDevMode now.
    return this.config.otpDevMode;
  }

  async request(phone: string): Promise<{ expiresInSeconds: number }> {
    const code = String(randomInt(0, 10000)).padStart(4, '0');
    await this.prisma.otpCode.create({
      data: {
        phone,
        codeHash: await argon2.hash(code),
        expiresAt: new Date(Date.now() + this.ttlSeconds * 1000),
      },
    });
    await this.deliver(phone, code);
    return { expiresInSeconds: this.ttlSeconds };
  }

  async verify(phone: string, code: string): Promise<void> {
    if (this.devMode && code === '0000') return;

    const otp = await this.prisma.otpCode.findFirst({
      where: { phone, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp) throw new BadRequestException('No valid OTP — request a new code');
    if (otp.attempts >= this.maxAttempts) {
      throw new BadRequestException('Too many attempts — request a new code');
    }

    const ok = await argon2.verify(otp.codeHash, code);
    if (!ok) {
      await this.prisma.otpCode.update({
        where: { id: otp.id },
        data: { attempts: { increment: 1 } },
      });
      throw new BadRequestException('Incorrect code');
    }

    await this.prisma.otpCode.update({
      where: { id: otp.id },
      data: { consumedAt: new Date() },
    });
  }

  /** SMS delivery seam — replace with a real provider (e.g. Twilio, Vodafone). */
  private async deliver(phone: string, code: string): Promise<void> {
    if (this.devMode) {
      this.logger.log(`[DEV OTP] ${phone} → ${code}`);
      return;
    }
    throw new Error('No SMS provider configured (set OTP_DEV_MODE=true for development)');
  }
}
