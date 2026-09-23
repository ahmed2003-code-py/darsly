import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * One Redis connection, shared by the distributed rate limiter
 * (RedisThrottlerStorageService) and — via `duplicate()` — the Socket.IO
 * adapter's pub/sub pair (RedisIoAdapter), rather than three independent
 * clients each opening and retrying their own connection.
 *
 * REDIS_URL unset is only tolerated outside production: validateConfig()
 * (common/config.validation.ts) makes it a fatal boot error in prod, before
 * this class is ever constructed there. A single local/dev instance has no
 * cross-replica state to share, so falling back to per-process storage there
 * is correct behaviour, not a degraded mode — see `enabled` below.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  /** null when REDIS_URL is unset (dev/test without Redis) — never in production. */
  readonly client: Redis | null;
  readonly enabled: boolean;

  constructor() {
    const url = process.env.REDIS_URL;
    this.enabled = !!url;
    if (!url) {
      this.client = null;
      return;
    }
    this.client = new Redis(url, {
      lazyConnect: true,
      // A command fails fast rather than queuing/hanging behind a dead
      // connection — every caller (throttler storage, the IO adapter) is
      // written to treat a rejected Redis call as "fall open", so a slow
      // Redis must never become a slow request.
      maxRetriesPerRequest: 1,
      retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    });
    // Never logs the URL itself (it can carry a password) — only the event.
    this.client.on('error', (err) => {
      this.logger.error(`Redis connection error: ${err.name}: ${err.message}`.split('\n')[0]);
    });
    this.client.on('connect', () => this.logger.log('Redis connected'));
    this.client.on('reconnecting', () => this.logger.warn('Redis reconnecting…'));
  }

  async onModuleInit(): Promise<void> {
    if (!this.client) {
      this.logger.warn(
        'REDIS_URL not set — rate limiting and Socket.IO room fan-out are per-process only. ' +
          'Correct for a single local instance; would be a security/correctness gap with more than one replica.',
      );
      return;
    }
    try {
      await this.client.connect();
    } catch (e) {
      // Must not crash startup over a Redis outage: every consumer already
      // falls open when the client is down, and ioredis keeps retrying in
      // the background per retryStrategy above.
      this.logger.error(
        `Redis initial connection failed, continuing without it: ${(e as Error).message}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }

  /** A second connection duplicated from the same options — Socket.IO's Redis
   *  adapter needs two (a subscribed connection can't issue other commands). */
  duplicate(): Redis | null {
    return this.client ? this.client.duplicate() : null;
  }
}
