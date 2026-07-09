import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { SignedUrlService } from '../../playback/signed-url.service';
import { StorageProvider } from '../../storage/storage.provider';
import { HlsKeyService } from '../hls-key.service';
import { KEY_URI_PLACEHOLDER, TranscodeService } from '../transcode.service';
import {
  IDrmProvider,
  LicenseContext,
  PackageInput,
  PackageResult,
  PlaybackCredentials,
} from './drm.provider';

/**
 * Default provider: AES-128 encrypted HLS ("clear-key"), where the key is
 * gated per authorized, watermarked session. Real server-side access control
 * without a licensed CDM. All HLS objects are stored under hls/<assetId>/ and
 * streamed by the app through signed URLs; the raw source is never packaged
 * into anything downloadable.
 */
@Injectable()
export class NativeAesDrmProvider implements IDrmProvider {
  readonly scheme = 'AES_128_CLEARKEY' as const;
  readonly hardwareBacked = false;
  private readonly logger = new Logger(NativeAesDrmProvider.name);

  constructor(
    private readonly transcoder: TranscodeService,
    private readonly keys: HlsKeyService,
    private readonly storage: StorageProvider,
    private readonly signer: SignedUrlService,
  ) {}

  async package(input: PackageInput): Promise<PackageResult> {
    const key = await this.keys.currentOrRotate();
    const out = await this.transcoder.packageHls(input.sourcePath, key.keyBytes, KEY_URI_PLACEHOLDER);

    // Upload every produced file under hls/<assetId>/, preserving structure.
    const prefix = `hls/${input.assetId}`;
    try {
      const files = await this.walk(out.workDir);
      for (const abs of files) {
        const rel = path.relative(out.workDir, abs).split(path.sep).join('/');
        const body = await fs.readFile(abs);
        await this.storage.put(`${prefix}/${rel}`, body, {
          contentType: rel.endsWith('.m3u8')
            ? 'application/vnd.apple.mpegurl'
            : 'video/mp2t',
          cacheControl: 'private, max-age=31536000',
        });
      }
    } finally {
      await fs.rm(out.workDir, { recursive: true, force: true });
    }

    return {
      scheme: this.scheme,
      masterKey: `${prefix}/${out.masterName}`,
      renditions: out.renditions.map((r) => ({
        height: r.height,
        bandwidth: r.bandwidth,
        playlistKey: `${prefix}/${r.playlistName}`,
      })),
      durationSec: out.durationSec,
      encryptionKeyId: key.id,
    };
  }

  /**
   * Native scheme: the "license" is a signed key URL. One playback token
   * authorizes the master playlist, its media playlists, segments, and the key
   * endpoint for this asset, bound to the session + watermark, short-lived.
   */
  async issueCredentials(ctx: LicenseContext): Promise<PlaybackCredentials> {
    const token = this.signer.sign({
      sid: ctx.sessionId,
      uid: ctx.studentId,
      aid: ctx.assetId,
      lid: '', // not needed for URL scoping
      wm: ctx.watermarkId,
      ...(ctx.preview ? { pv: 1 as const } : {}),
    });
    return {
      scheme: this.scheme,
      masterUrl: `/api/v1/playback/hls/${token}/master.m3u8`,
      keyUrl: `/api/v1/playback/key/${token}`,
    };
  }

  private async walk(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await this.walk(abs)));
      else out.push(abs);
    }
    return out;
  }
}
