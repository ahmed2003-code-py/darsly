import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { LiveCommerceService } from './live-commerce.service';

/** How often lapsed holds are given back and delivered classes paid out. */
export const LIVE_COMMERCE_SWEEP_MS = 30_000;

/**
 * The server's side of Live commerce's clock: seats whose hold lapsed go back
 * to the pool. Everything it does is found from the data and re-checked under
 * the session lock, so a restart loses nothing and several replicas cannot
 * double anything. `LIVE_COMMERCE_WORKER_ENABLED=false` opts a replica out.
 */
@Injectable()
export class LiveCommerceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LiveCommerceWorker.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly commerce: LiveCommerceService) {}

  onModuleInit(): void {
    if ((process.env.LIVE_COMMERCE_WORKER_ENABLED ?? 'true') !== 'true') {
      this.logger.log('live commerce worker disabled (LIVE_COMMERCE_WORKER_ENABLED=false)');
      return;
    }
    this.timer = setInterval(() => void this.sweep(), LIVE_COMMERCE_SWEEP_MS);
    this.logger.log(`live commerce worker started (every ${LIVE_COMMERCE_SWEEP_MS / 1000}s)`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass. Public so a test (or an operator) can run it on demand. */
  async sweep(): Promise<{ expired: number; released: number; review: number }> {
    const out = { expired: 0, released: 0, review: 0 };
    if (this.running) return out;
    this.running = true;
    try {
      out.expired = await this.commerce.expireHolds();
      // Held money becomes earnings once a class is delivered — or waits for
      // a person when it was not. Keyed in the ledger, so a retry moves nothing.
      const r = await this.commerce.releaseDelivered();
      out.released = r.released;
      out.review = r.review;
      if (out.expired || out.released || out.review)
        this.logger.log(
          `live commerce sweep: ${out.expired} holds expired, ${out.released} released, ${out.review} to review`,
        );
    } catch (e) {
      this.logger.error(`live commerce sweep error: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
    return out;
  }
}
