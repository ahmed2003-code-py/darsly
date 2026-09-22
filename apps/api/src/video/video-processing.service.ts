import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProvider } from '../storage/storage.provider';
import { DRM_PROVIDER, IDrmProvider } from './drm/drm.provider';
import { VideoJobError, VideoJobService } from './jobs/video-job.service';

/**
 * Orchestrates a VideoAsset from raw upload to READY encrypted HLS:
 *   UPLOADING → PROCESSING → (package via DRM provider) → READY | FAILED
 *
 * The packaging itself is unchanged. What changed is how it is started: the
 * upload handler used to call `void this.process(id).catch(log)`, which left
 * no record that the work was owed, so a crash or a Railway redeploy mid-ffmpeg
 * stranded the asset in PROCESSING with nothing to pick it up. Now `enqueue`
 * writes a VideoJob row and `VideoJobWorker` is what calls `process`.
 *
 * The raw source is deleted from storage once packaging succeeds — only
 * encrypted HLS remains, and it is never served directly. That deletion is
 * exactly why `process` has to be safe to run twice; see the guard at the top
 * of it.
 */
@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageProvider,
    @Inject(DRM_PROVIDER) private readonly drm: IDrmProvider,
    private readonly jobs: VideoJobService,
  ) {}

  /**
   * Promise that this asset will be packaged.
   *
   * Returns as soon as the promise is written down — the caller still does not
   * wait for ffmpeg — but the promise now outlives this process. Accepts a
   * transaction client so the asset and its job can be committed together:
   * an asset with no job is work that will never happen.
   *
   * The asset is moved to PROCESSING here rather than when a worker picks it
   * up, so `GET /uploads/videos/:id/status` answers exactly what it answered
   * before this change instead of showing UPLOADING for the few seconds
   * between the insert and the claim.
   */
  async enqueue(assetId: string, tenantId: string, tx?: Prisma.TransactionClient): Promise<void> {
    const db = tx ?? this.prisma;
    await db.videoAsset.update({ where: { id: assetId }, data: { status: 'PROCESSING' } });
    await this.jobs.enqueue(assetId, tenantId, tx);
  }

  /** Mark an asset failed — called by the worker once a job has no retries left. */
  async markFailed(assetId: string): Promise<void> {
    await this.prisma.videoAsset
      .update({ where: { id: assetId }, data: { status: 'FAILED' } })
      .catch(() => undefined);
  }

  async process(assetId: string): Promise<void> {
    const asset = await this.prisma.videoAsset.findUnique({ where: { id: assetId } });
    // A missing asset will be missing on every retry too, so this is terminal:
    // three attempts at a row that was deleted is three wasted claims.
    if (!asset) throw new VideoJobError(`VideoAsset ${assetId} not found`, 'TERMINAL');

    /**
     * Already done — stop.
     *
     * This is what makes the job safe to run twice, and it is not theoretical:
     * a successful run *deletes the source* (below), so a retry that lands
     * after a completed-but-unacknowledged attempt — a worker that packaged
     * the video and was killed before it could write SUCCEEDED — would find no
     * source and fail forever, turning a finished video into a permanent
     * error. The asset's own state is the authority on whether the work is
     * done, not the job's.
     */
    if (asset.status === 'READY' && asset.hlsMasterKey) {
      this.logger.log(`Asset ${assetId} already READY; nothing to package`);
      return;
    }

    await this.prisma.videoAsset.update({
      where: { id: assetId },
      data: { status: 'PROCESSING' },
    });

    // Give ffmpeg a real filesystem path — direct for local, staged for remote.
    let sourcePath = this.storage.localPath(asset.originalKey);
    let stagedTmp: string | null = null;
    try {
      if (!sourcePath) {
        // Streamed, not buffered: a lesson can be a couple of gigabytes, and
        // `getBuffer` held the whole of it in memory on a container that does
        // not have that to spare.
        stagedTmp = path.join(os.tmpdir(), `darsly-src-${assetId}${path.extname(asset.originalKey)}`);
        const { stream } = await this.storage.getStream(asset.originalKey);
        await pipeline(stream, createWriteStream(stagedTmp));
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

      // The video is the only source a lesson's length has — teachers no longer
      // type it in — so the probe always wins. Filling only an empty duration
      // meant swapping in a longer take left the old one on display forever.
      await this.prisma.lesson.updateMany({
        where: { videoAssetId: assetId },
        data: { durationSec: result.durationSec },
      });

      // The raw source is no longer needed; encrypted HLS is the only artifact.
      await this.storage.delete(asset.originalKey).catch(() => undefined);
      this.logger.log(`Asset ${assetId} READY (${result.renditions.length} renditions)`);
    } catch (err: any) {
      // Deliberately does NOT mark the asset FAILED. A job with retries left
      // has not failed yet, and showing the teacher an error that the next
      // attempt silently contradicts is worse than showing them nothing.
      // VideoJobWorker calls markFailed() once the attempts are spent.
      throw err;
    } finally {
      if (stagedTmp) await fs.rm(stagedTmp, { force: true });
    }
  }
}
