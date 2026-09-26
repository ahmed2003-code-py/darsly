import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { LiveRecordingService } from './recording/live-recording.service';
import { LiveService } from './live.service';
import { LiveRetentionService } from './retention/live-retention.service';

/** Temporary media is swept this often (it is hours old by the time it matters). */
export const LIVE_RETENTION_EVERY_MS = 30 * 60_000;

/** How often the sweep looks for classes whose time is up. */
export const LIVE_END_SWEEP_MS = 15_000;
/** At most this many classes closed per sweep (a backlog drains over a few). */
export const LIVE_END_BATCH = 25;

/**
 * Ends classes whose effective end has passed — the server's side of "the
 * class is over", so it never depends on a teacher's browser being open.
 *
 * The database is the whole schedule. There is no timer per class to cancel
 * when a class is extended, so there is no stale timer to fire: each sweep
 * reads the ends as they are *now* (overdueLiveSessionIds), and
 * LiveService.endSession re-checks the current end under the row lock before
 * doing anything. A class extended a second before its old end is simply not
 * overdue.
 *
 * Survives restarts for the same reason: a sweep missed while the process was
 * down is the next sweep's work — an overdue class is found by its data, not
 * by a timer that had to still be alive. Safe on several replicas: each end
 * takes the row lock, and a second replica finds the class already ENDED.
 *
 * `LIVE_END_WORKER_ENABLED=false` opts a replica out (default on), like the
 * other workers' flags.
 */
@Injectable()
export class LiveEndWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LiveEndWorker.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly live: LiveService,
    @Optional() private readonly recordings?: LiveRecordingService,
    @Optional() private readonly retention?: LiveRetentionService,
  ) {}
  private lastRetention = 0;

  onModuleInit(): void {
    if ((process.env.LIVE_END_WORKER_ENABLED ?? 'true') !== 'true') {
      this.logger.log('live end worker disabled (LIVE_END_WORKER_ENABLED=false)');
      return;
    }
    this.timer = setInterval(() => void this.sweep(), LIVE_END_SWEEP_MS);
    this.logger.log(`live end worker started (every ${LIVE_END_SWEEP_MS / 1000}s)`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass. Public so a test (or an operator) can run it on demand. */
  async sweep(): Promise<{ ended: number; failed: number }> {
    if (this.running) return { ended: 0, failed: 0 };
    this.running = true;
    let ended = 0;
    let failed = 0;
    try {
      const ids = await this.live.overdueLiveSessionIds(LIVE_END_BATCH);
      for (const id of ids) {
        try {
          const r = await this.live.endSession(id, 'SCHEDULED_END');
          if (r.outcome === 'ended') ended++;
        } catch (e) {
          // Most likely the provider refused to close the room. The class
          // stays LIVE, so the next sweep tries again.
          failed++;
          this.logger.warn(
            `live end sweep: liveSession=${id} not closed yet, will retry: ${(e as Error).message}`,
          );
        }
      }
      if (ended || failed) this.logger.log(`live end sweep: ${ended} ended, ${failed} retrying`);
    } catch (e) {
      this.logger.error(`live end sweep error: ${(e as Error).message}`);
    }
    try {
      // Provider teardown still owed — a Cloudflare class's tracks after it
      // ended, a revoked speaker whose close did not reach the SFU. Retried
      // here, from the data, like the ends themselves.
      const c = await this.live.sweepProviderCleanups(LIVE_END_BATCH);
      if (c.closed || c.pending) {
        this.logger.log(`live cleanup sweep: ${c.closed} closed, ${c.pending} retrying`);
      }
    } catch (e) {
      this.logger.error(`live cleanup sweep error: ${(e as Error).message}`);
    }
    try {
      // Recordings nobody is working on: never started, or recorder gone.
      await this.recordings?.sweepStale();
    } catch (e) {
      this.logger.error(`live recording sweep error: ${(e as Error).message}`);
    }
    try {
      // Transcription audio and failed recordings' pieces past their window.
      if (this.retention && Date.now() - this.lastRetention >= LIVE_RETENTION_EVERY_MS) {
        this.lastRetention = Date.now();
        await this.retention.sweep();
      }
    } catch (e) {
      this.logger.error(`live retention sweep error: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
    return { ended, failed };
  }
}
