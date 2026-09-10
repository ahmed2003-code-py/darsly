import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { AcademyMediaKind } from '@prisma/client';

const execFileAsync = promisify(execFile);

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

export interface ProcessedVideo {
  data: Buffer;
  format: 'mp4';
  mimeType: 'video/mp4';
  width: number | null;
  height: number | null;
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
  PROMO: 1920, // unused by image processing — PROMO is video, see processVideo()
};

const ACCEPTED_INPUT = /^image\/(png|jpe?g|webp)$/;
const MAX_INPUT_DIM = 10_000;
const ACCEPTED_VIDEO = /^video\/mp4$/;
const MAX_VIDEO_BYTES = 25 * 1024 * 1024; // 25 MB — short highlight clips, not lesson video

/**
 * Pure image processing (no DB, no storage). sharp strips metadata by default,
 * so re-encoding is our EXIF/GPS scrub. Also computes a blurhash for progressive
 * loading and a content hash for dedupe.
 */
@Injectable()
export class AcademyMediaProcessor {
  private readonly logger = new Logger(AcademyMediaProcessor.name);
  // sharp is a native dep; required at construction (installed via apps/api).
  private readonly sharp = require('sharp');
  private readonly blurhashEncode = require('blurhash').encode;

  /**
   * PROMO media: a short clip stored as-is (no transcode — these are highlight
   * reels, not lesson video, and the platform's HLS pipeline is for the latter).
   * Dimensions come from `ffprobe`, already a hard dependency of the lesson-video
   * pipeline (`TranscodeService`); a probe failure is non-fatal, since it is only
   * used for a layout hint.
   */
  async processVideo(input: Buffer, mimeType: string): Promise<ProcessedVideo> {
    if (!ACCEPTED_VIDEO.test(mimeType)) {
      throw new BadRequestException('Only MP4 video is accepted');
    }
    if (input.length > MAX_VIDEO_BYTES) {
      throw new BadRequestException(`Video is too large (max ${MAX_VIDEO_BYTES / (1024 * 1024)}MB)`);
    }
    const contentHash = createHash('sha256').update(input).digest('hex');
    const dims = await this.probeDimensions(input);
    return {
      data: input,
      format: 'mp4',
      mimeType: 'video/mp4',
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      bytes: input.length,
      contentHash,
    };
  }

  private async probeDimensions(input: Buffer): Promise<{ width: number; height: number } | null> {
    const tmp = path.join(os.tmpdir(), `academy-promo-${randomUUID()}.mp4`);
    try {
      await fs.writeFile(tmp, input);
      const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height',
        '-of', 'json',
        tmp,
      ]);
      const width = Number(JSON.parse(stdout)?.streams?.[0]?.width);
      const height = Number(JSON.parse(stdout)?.streams?.[0]?.height);
      return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : null;
    } catch (e) {
      this.logger.warn(`ffprobe failed for a PROMO upload, dimensions will be null: ${(e as Error).message}`);
      return null;
    } finally {
      await fs.unlink(tmp).catch(() => undefined);
    }
  }

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
