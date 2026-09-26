import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { LiveCommerceService } from './live-commerce.service';

/** How often lapsed holds are given back. */
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
  async sweep(): Promise<{ expired: number }> {
    if (this.running) return { expired: 0 };
    this.running = true;
    let expired = 0;
    try {
      expired = await this.commerce.expireHolds();
      if (expired) this.logger.log(`live commerce sweep: ${expired} holds expired`);
    } catch (e) {
      this.logger.error(`live commerce sweep error: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
    return { expired };
  }
}
