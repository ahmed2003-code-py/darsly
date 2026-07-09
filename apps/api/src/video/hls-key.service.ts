import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Manages AES-128 content keys for encrypted HLS. Keys are stored server-side
 * (HlsEncryptionKey rows) and are ONLY ever emitted to an authorized,
 * watermarked playback session by the key endpoint — never bundled with media.
 *
 * Rotation: a key older than HLS_KEY_ROTATION_SECONDS is considered stale for
 * NEW packaging jobs; already-packaged assets keep their original key (the
 * segments were encrypted with it), so rotation here limits how many assets
 * share one key rather than re-encrypting existing media.
 */
@Injectable()
export class HlsKeyService {
  constructor(private readonly prisma: PrismaService) {}

  private get rotationSec() {
    return Number(process.env.HLS_KEY_ROTATION_SECONDS ?? 3600);
  }

  /** Mint a fresh 16-byte AES-128 key. */
  async createKey(): Promise<{ id: string; keyBytes: Buffer }> {
    const keyBytes = randomBytes(16);
    const row = await this.prisma.hlsEncryptionKey.create({
      data: { keyHex: keyBytes.toString('hex') },
    });
    return { id: row.id, keyBytes };
  }

  /** Reuse the current key if it is still within the rotation window, else mint. */
  async currentOrRotate(): Promise<{ id: string; keyBytes: Buffer }> {
    const latest = await this.prisma.hlsEncryptionKey.findFirst({
      orderBy: { createdAt: 'desc' },
    });
    const fresh =
      latest && Date.now() - latest.createdAt.getTime() < this.rotationSec * 1000;
    if (fresh) {
      return { id: latest.id, keyBytes: Buffer.from(latest.keyHex, 'hex') };
    }
    if (latest) {
      await this.prisma.hlsEncryptionKey.update({
        where: { id: latest.id },
        data: { rotatedAt: new Date() },
      });
    }
    return this.createKey();
  }

  async getKeyBytes(id: string): Promise<Buffer | null> {
    const row = await this.prisma.hlsEncryptionKey.findUnique({ where: { id } });
    return row ? Buffer.from(row.keyHex, 'hex') : null;
  }
}
