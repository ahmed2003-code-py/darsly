import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AcademySiteConfig } from '../academy-site.config';
import { AcademyMediaService } from './academy-media.service';

const SWEEP_MS = 15 * 60_000; // every 15 minutes

/**
 * Periodic media housekeeping (no @nestjs/schedule dependency): fails uploads
 * stuck in UPLOADING/PROCESSING and purges old REJECTED media so storage does
 * not leak. Only runs when the feature and worker are enabled. Cleanup of media
 * unreferenced by any site document is added in a later slice, once sites exist
 * (deleting "unreferenced" media before any document exists would delete
 * everything).
 */
@Injectable()
export class MediaMaintenanceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MediaMaintenanceWorker.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly config: AcademySiteConfig,
    private readonly media: AcademyMediaService,
  ) {}

  onModuleInit(): void {
    if (!this.config.enabled || !this.config.workerEnabled) return;
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.logger.log('media maintenance worker started');
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const stuck = await this.media.sweepStuck();
      const purged = await this.media.purgeRejected();
      if (stuck || purged) {
        this.logger.log(`media sweep: ${stuck} stuck→rejected, ${purged} purged`);
      }
    } catch (e) {
      this.logger.error(`media sweep error: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
