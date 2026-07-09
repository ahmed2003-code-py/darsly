import { Inject, Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProvider } from '../storage/storage.provider';
import { DRM_PROVIDER, IDrmProvider } from './drm/drm.provider';

/**
 * Orchestrates a VideoAsset from raw upload to READY encrypted HLS:
 *   UPLOADING → PROCESSING → (package via DRM provider) → READY | FAILED
 *
 * Runs the ffmpeg packaging off the request thread (fire-and-forget from the
 * upload handler). The raw source is deleted from storage once packaging
 * succeeds — only encrypted HLS remains, and it is never served directly.
 */
@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageProvider,
    @Inject(DRM_PROVIDER) private readonly drm: IDrmProvider,
  ) {}

  /** Kick off processing without blocking the caller. */
  enqueue(assetId: string): void {
    void this.process(assetId).catch((err) =>
      this.logger.error(`Asset ${assetId} processing failed: ${err.message}`),
    );
  }

  async process(assetId: string): Promise<void> {
    const asset = await this.prisma.videoAsset.findUnique({ where: { id: assetId } });
    if (!asset) throw new Error(`VideoAsset ${assetId} not found`);

    await this.prisma.videoAsset.update({
      where: { id: assetId },
      data: { status: 'PROCESSING' },
    });

    // Give ffmpeg a real filesystem path — direct for local, staged for remote.
    let sourcePath = this.storage.localPath(asset.originalKey);
    let stagedTmp: string | null = null;
    try {
      if (!sourcePath) {
        const buf = await this.storage.getBuffer(asset.originalKey);
        stagedTmp = path.join(os.tmpdir(), `darsly-src-${assetId}${path.extname(asset.originalKey)}`);
        await fs.writeFile(stagedTmp, buf);
        sourcePath = stagedTmp;
      }

      const result = await this.drm.package({
        assetId,
        sourcePath,
        tenantId: asset.tenantId,
      });

      await this.prisma.videoAsset.update({
        where: { id: assetId },
        data: {
          status: 'READY',
          hlsMasterKey: result.masterKey,
          encryptionKeyId: result.encryptionKeyId,
          durationSec: result.durationSec,
          renditions: result.renditions as any,
        },
      });

      // Propagate duration to the lesson if it didn't have one.
      await this.prisma.lesson.updateMany({
        where: { videoAssetId: assetId, durationSec: 0 },
        data: { durationSec: result.durationSec },
      });

      // The raw source is no longer needed; encrypted HLS is the only artifact.
      await this.storage.delete(asset.originalKey).catch(() => undefined);
      this.logger.log(`Asset ${assetId} READY (${result.renditions.length} renditions)`);
    } catch (err: any) {
      await this.prisma.videoAsset.update({
        where: { id: assetId },
        data: { status: 'FAILED' },
      });
      throw err;
    } finally {
      if (stagedTmp) await fs.rm(stagedTmp, { force: true });
    }
  }
}
