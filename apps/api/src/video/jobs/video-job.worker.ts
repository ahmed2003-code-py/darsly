import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { VideoJob } from '@prisma/client';
import { VideoProcessingService } from '../video-processing.service';
import { VideoJobConfig } from './video-job.config';
import { VideoJobError, VideoJobService } from './video-job.service';

const POLL_MS = 3_000;
/**
 * Long enough that a genuinely slow encode is not declared dead, short enough
 * that a crashed one is picked up while the teacher is still watching the
 * page. The heartbeat below renews it, so this is the grace period after a
 * worker stops breathing, not a cap on how long work may take.
 */
const LEASE_MS = 5 * 60_000;
/** How long a shutdown waits for in-flight encodes before giving up on them. */
const DRAIN_TIMEOUT_MS = 30_000;

/**
 * Drains the VideoJob queue, one encode at a time by default.
 *
 * Deliberately close in shape to `academy-site/jobs/ai-job.worker.ts` — same
 * poll, same claim, same heartbeat — so there is one worker pattern here, not
 * two. Two things are different, and both are the point of this change:
 *
 *  1. **It drains on shutdown.** The AI worker clears its timer and returns,
 *     abandoning whatever is mid-flight to be re-run after its lease expires.
 *     That is survivable for a text generation and wasteful for a five-minute
 *     transcode, so this one waits for the encode it is holding.
 *
 *  2. **It is not gated on the AI feature flag.** `AI_ACADEMY_ENABLED` ships
 *     `false`; wiring video to it would mean turning off AI silently stops
 *     every upload from ever becoming playable.
 *
 * Note that `onModuleDestroy` only ever runs because `main.ts` now calls
 * `app.enableShutdownHooks()`. Without it Nest never sees SIGTERM and no
 * amount of draining code in here would execute.
 */
@Injectable()
export class VideoJobWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VideoJobWorker.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = 0;
  private ticking = false;
  private stopping = false;

  constructor(
    private readonly config: VideoJobConfig,
    private readonly jobs: VideoJobService,
    private readonly processing: VideoProcessingService,
  ) {}

  onModuleInit(): void {
    if (!this.config.workerEnabled) {
      this.logger.log('Video job worker disabled (VIDEO_WORKER_ENABLED=false)');
      return;
    }
    this.logger.log(`Video job worker started (concurrency=${this.config.workerConcurrency})`);
    this.timer = setInterval(() => void this.tick(), POLL_MS);
  }

  /**
   * Stop taking work, then wait for what is already running.
   *
   * A redeploy that kills ffmpeg halfway wastes everything it had done; the
   * lease makes that recoverable rather than fatal, but recoverable work still
   * costs a teacher several minutes. Waiting is bounded — Railway will not wait
   * forever either, and a job we abandon at the timeout is still safe, just
   * slower, because its lease expires and another replica takes it.
   */
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.active) return;

    this.logger.log(`Draining ${this.active} in-flight video job(s)…`);
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (this.active > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (this.active > 0) {
      this.logger.warn(
        `Shutdown timeout with ${this.active} job(s) still running; their leases will expire and another replica will re-claim them.`,
      );
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      while (!this.stopping && this.active < this.config.workerConcurrency) {
        const job = await this.jobs.claimNext(LEASE_MS);
        if (!job) break;
        this.active++;
        void this.run(job).finally(() => {
          this.active--;
        });
      }
    } catch (e) {
      this.logger.error(`claim loop error: ${(e as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async run(job: VideoJob): Promise<void> {
    const heartbeat = setInterval(
      () => void this.jobs.renewLease(job.id, LEASE_MS).catch(() => undefined),
      Math.floor(LEASE_MS / 2),
    );
    try {
      this.logger.log(`job ${job.id} packaging asset ${job.videoAssetId} (attempt ${job.attempts})`);
      await this.processing.process(job.videoAssetId);
      await this.jobs.succeed(job.id);
    } catch (e) {
      // Anything not explicitly classified is treated as retryable: assuming a
      // failure is permanent is how work gets thrown away, and the attempt cap
      // bounds the cost of being wrong in the other direction.
      const errorClass = e instanceof VideoJobError ? e.errorClass : 'RETRYABLE';
      const message = e instanceof Error ? e.message : String(e);
      const willRetry = await this.jobs.fail(job.id, { message, errorClass });
      // Only tell the teacher it failed once it really has. A job with retries
      // left is still in progress, and marking the asset FAILED here would put
      // an error on their screen that the next attempt silently contradicts.
      if (!willRetry) await this.processing.markFailed(job.videoAssetId);
    } finally {
      clearInterval(heartbeat);
    }
  }
}
