import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomInt } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeEgyptianPhone } from '../auth/dto/auth.dto';
import { DeviceTokenService, DeviceTokens } from './device-token.service';

/**
 * How a listener phone joins the platform.
 *
 * An SMS OTP is the wrong control here, and in production it is also impossible:
 * there is no SMS gateway, so `OtpService.deliver()` throws. More importantly, the
 * listener runs on a handset the operator physically owns — the question is not
 * "does this person control this number?" but "did an admin authorise this
 * handset?".
 *
 * So a super-admin mints a short-lived, single-use code bound to the phone number
 * the device will be registered under, reads it out to whoever is holding the
 * phone, and the app exchanges it for device tokens. The client can never choose
 * its own phone number — it comes from the code.
 */
@Injectable()
export class DeviceEnrollmentService {
  private readonly logger = new Logger(DeviceEnrollmentService.name);

  /** Unambiguous alphabet: no O/0, I/1, or similar look-alikes to misread aloud. */
  private static readonly ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  private static readonly GROUP = 4;
  private static readonly TTL_SECONDS = 15 * 60;
  /** Active codes are few and short-lived; bound the verify scan regardless. */
  private static readonly MAX_ACTIVE_SCAN = 20;
  private static readonly MAX_ATTEMPTS = 10;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: DeviceTokenService,
  ) {}

  /**
   * Mint a code for a phone number. The plaintext is returned exactly once — only
   * an argon2 hash is stored, so a database dump yields no usable code.
   */
  async mint(
    rawPhone: string,
    label: string | undefined,
    createdById: string,
  ): Promise<{ code: string; phone: string; expiresAt: string }> {
    const phone = normalizeEgyptianPhone(rawPhone);
    const code = this.generateCode();
    const expiresAt = new Date(Date.now() + DeviceEnrollmentService.TTL_SECONDS * 1000);

    await this.prisma.deviceEnrollmentCode.create({
      data: {
        phone,
        codeHash: await argon2.hash(code),
        label: label ?? null,
        expiresAt,
        createdById,
      },
    });
    // The code itself is never logged.
    this.logger.log(`Enrollment code minted for ${phone} (expires ${expiresAt.toISOString()})`);
    return { code, phone, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Exchange a code for device tokens. Single use: the first successful redemption
   * consumes it, so a code read out loud cannot enroll a second handset.
   */
  async enroll(
    rawCode: string,
    meta: { model?: string; appVersion?: string },
  ): Promise<DeviceTokens & { phone: string }> {
    const code = this.normalizeCode(rawCode);
    if (!code) throw new BadRequestException('Enrollment code is required');

    const candidates = await this.prisma.deviceEnrollmentCode.findMany({
      where: {
        consumedAt: null,
        expiresAt: { gt: new Date() },
        attempts: { lt: DeviceEnrollmentService.MAX_ATTEMPTS },
      },
      orderBy: { createdAt: 'desc' },
      take: DeviceEnrollmentService.MAX_ACTIVE_SCAN,
    });

    for (const candidate of candidates) {
      const matches = await argon2.verify(candidate.codeHash, code).catch(() => false);
      if (!matches) continue;

      // Consume conditionally: two handsets racing the same code, only one wins.
      const claimed = await this.prisma.deviceEnrollmentCode.updateMany({
        where: { id: candidate.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      if (claimed.count === 0) break; // someone else just used it

      const device = await this.prisma.listenerDevice.create({
        data: {
          phone: candidate.phone,
          model: meta.model ?? null,
          appVersion: meta.appVersion ?? null,
        },
      });
      await this.prisma.deviceEnrollmentCode.update({
        where: { id: candidate.id },
        data: { consumedByDeviceId: device.id },
      });

      const issued = await this.tokens.issue({ id: device.id, phone: candidate.phone });
      this.logger.log(`Device ${device.id} enrolled for ${candidate.phone}`);
      return { ...issued, phone: candidate.phone };
    }

    // Count the failure against every live code so guessing is bounded.
    await this.prisma.deviceEnrollmentCode.updateMany({
      where: { consumedAt: null, expiresAt: { gt: new Date() } },
      data: { attempts: { increment: 1 } },
    });
    throw new BadRequestException('Invalid or expired enrollment code');
  }

  /** Admin view: codes that are still usable, never the codes themselves. */
  async listActive() {
    const rows = await this.prisma.deviceEnrollmentCode.findMany({
      where: { consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, phone: true, label: true, expiresAt: true, attempts: true, createdAt: true },
    });
    return rows;
  }

  /** Admin view: enrolled listener phones. */
  async listDevices() {
    return this.prisma.listenerDevice.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true, phone: true, model: true, appVersion: true,
        lastSeenAt: true, revokedAt: true, revokedReason: true, createdAt: true,
        _count: { select: { smsEvents: true } },
      },
    });
  }

  async revoke(deviceId: string, reason: string) {
    await this.tokens.revoke(deviceId, reason);
    return { ok: true };
  }

  /** e.g. "K7QM-3XPD" — grouped for reading aloud without mistakes. */
  private generateCode(): string {
    const pick = () =>
      Array.from(
        { length: DeviceEnrollmentService.GROUP },
        () => DeviceEnrollmentService.ALPHABET[randomInt(0, DeviceEnrollmentService.ALPHABET.length)],
      ).join('');
    return `${pick()}-${pick()}`;
  }

  /** Accept it however the user typed it: spaces, dashes, lower case. */
  private normalizeCode(input: string): string {
    const cleaned = (input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (cleaned.length !== DeviceEnrollmentService.GROUP * 2) return '';
    return `${cleaned.slice(0, DeviceEnrollmentService.GROUP)}-${cleaned.slice(DeviceEnrollmentService.GROUP)}`;
  }
}
