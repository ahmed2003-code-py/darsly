import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { AcademyMediaKind } from '@prisma/client';

export interface ProcessedImage {
  data: Buffer;
  format: 'webp';
  mimeType: 'image/webp';
  width: number;
  height: number;
  blurhash: string;
  bytes: number;
  contentHash: string;
}

// Per-kind processing targets. Single-instance kinds (LOGO/COVER/AVATAR) and the
// repeatable GALLERY each get a sensible max dimension; everything is re-encoded
// to webp, which also drops all original metadata (EXIF/GPS) for privacy.
const KIND_MAX_DIM: Record<AcademyMediaKind, number> = {
  LOGO: 512,
  AVATAR: 512,
  COVER: 1920,
  GALLERY: 1600,
  PROMO: 1920, // not used yet (video promo deferred)
};

const ACCEPTED_INPUT = /^image\/(png|jpe?g|webp)$/;
const MAX_INPUT_DIM = 10_000;

/**
 * Pure image processing (no DB, no storage). sharp strips metadata by default,
 * so re-encoding is our EXIF/GPS scrub. Also computes a blurhash for progressive
 * loading and a content hash for dedupe.
 */
@Injectable()
export class AcademyMediaProcessor {
  // sharp is a native dep; required at construction (installed via apps/api).
  private readonly sharp = require('sharp');
  private readonly blurhashEncode = require('blurhash').encode;

  async process(input: Buffer, mimeType: string, kind: AcademyMediaKind): Promise<ProcessedImage> {
    if (!ACCEPTED_INPUT.test(mimeType)) {
      throw new BadRequestException('Only PNG, JPEG and WebP images are accepted');
    }
    const contentHash = createHash('sha256').update(input).digest('hex');

    let meta: any;
    try {
      meta = await this.sharp(input).metadata();
    } catch {
      throw new BadRequestException('File is not a valid image');
    }
    if (!meta.format || !meta.width || !meta.height) {
      throw new BadRequestException('File is not a valid image');
    }
    if (meta.width > MAX_INPUT_DIM || meta.height > MAX_INPUT_DIM) {
      throw new BadRequestException(`Image is too large (max ${MAX_INPUT_DIM}px per side)`);
    }

    const maxDim = KIND_MAX_DIM[kind];
    const { data, info } = await this.sharp(input)
      .rotate() // auto-orient from EXIF, then metadata is dropped
      .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });

    const blurhash = await this.blurhashFor(data);
    return {
      data,
      format: 'webp',
      mimeType: 'image/webp',
      width: info.width,
      height: info.height,
      blurhash,
      bytes: data.length,
      contentHash,
    };
  }

  private async blurhashFor(webp: Buffer): Promise<string> {
    try {
      const { data, info } = await this.sharp(webp)
        .raw()
        .ensureAlpha()
        .resize(32, 32, { fit: 'inside' })
        .toBuffer({ resolveWithObject: true });
      return this.blurhashEncode(new Uint8ClampedArray(data), info.width, info.height, 4, 4);
    } catch {
      return ''; // blurhash is decorative; never fail an upload over it
    }
  }
}
