import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Manages AES-128 content keys for encrypted HLS. Keys are stored server-side
 * (HlsEncryptionKey rows) and are ONLY ever emitted to an authorized,
 * watermarked playback session by the key endpoint — never bundled with media.
 *
 * Isolation: each packaging job mints its OWN key (see createKey), so every asset
 * is encrypted under a distinct key. A leak of one key cannot decrypt another
 * asset's segments. Already-packaged assets keep the key they were encrypted with.
 */
@Injectable()
export class HlsKeyService {
  constructor(private readonly prisma: PrismaService) {}

  /** Mint a fresh 16-byte AES-128 key (one per asset). */
  async createKey(): Promise<{ id: string; keyBytes: Buffer }> {
    const keyBytes = randomBytes(16);
    const row = await this.prisma.hlsEncryptionKey.create({
      data: { keyHex: keyBytes.toString('hex') },
    });
    return { id: row.id, keyBytes };
  }

  async getKeyBytes(id: string): Promise<Buffer | null> {
    const row = await this.prisma.hlsEncryptionKey.findUnique({ where: { id } });
    return row ? Buffer.from(row.keyHex, 'hex') : null;
  }
}
