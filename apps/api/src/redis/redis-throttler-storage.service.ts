import { Injectable, Logger } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { RedisService } from './redis.service';

/** Structurally identical to @nestjs/throttler's ThrottlerStorageRecord —
 *  declared locally rather than deep-importing from its dist/ path. */
export interface ThrottlerRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * Distributed replacement for @nestjs/throttler's default in-memory storage.
 * Both Railway replicas share the same Redis-held counters, so a limit like
 * "20 login attempts/minute" is the limit across the whole deployment — not
 * per instance, which is what let it become ~40 in practice before this.
 *
 * Deliberately built on plain INCR/PEXPIRE/SET, not a Lua EVAL script. The
 * first version used one atomic script, which is the textbook-correct way to
 * do this — but several managed "Redis-compatible" offerings restrict or
 * reject EVAL for multi-tenant safety while every basic command works fine,
 * and that combination is invisible from here: this service has no way to
 * know which flavor of Redis it's been pointed at. Rather than depend on a
 * capability that may silently be unavailable on some provider, this uses
 * only the commands the whole Redis-compatible ecosystem supports
 * unconditionally — the same INCR+EXPIRE pattern Redis's own docs present as
 * the standard simple rate limiter. The cost is a few real-but-narrow race
 * windows under concurrent requests from the *same* identity in the *same*
 * millisecond (a hit could in principle land between the block check and the
 * INCR, or two requests could both observe hits > limit and both write the
 * block key) — acceptable for a defense-in-depth throttle that sits on top
 * of argon2 password hashing and the account model, not in place of them,
 * and a better trade than a rate limiter that silently never engages because
 * the one command it depends on is blocked.
 */
@Injectable()
export class RedisThrottlerStorageService implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorageService.name);
  private lastErrorLoggedAt = 0;

  constructor(private readonly redis: RedisService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerRecord> {
    const client = this.redis.client;
    if (!client) return this.open();

    const hitsKey = `throttle:${key}:${throttlerName}`;
    const blockKey = `throttle:${key}:${throttlerName}:blocked`;
    try {
      // Mirrors the in-memory ThrottlerStorageService: while blocked, hits
      // don't accumulate further, and the block's own TTL — not the hit
      // window — decides when a client is unblocked.
      const blockPttl = await client.pttl(blockKey);
      if (blockPttl > 0) {
        const blockSec = Math.ceil(blockPttl / 1000);
        return {
          totalHits: 0,
          timeToExpire: blockSec,
          isBlocked: true,
          timeToBlockExpire: blockSec,
        };
      }

      const hits = await client.incr(hitsKey);
      if (hits === 1) {
        await client.pexpire(hitsKey, ttl);
      }
      let pttl = await client.pttl(hitsKey);
      if (pttl < 0) {
        // INCR on a key that raced past its own expiry between the calls
        // above — reassert the window rather than let the counter live
        // forever.
        await client.pexpire(hitsKey, ttl);
        pttl = ttl;
      }

      if (hits > limit) {
        await client.set(blockKey, '1', 'PX', blockDuration);
        return {
          totalHits: hits,
          timeToExpire: Math.ceil(pttl / 1000),
          isBlocked: true,
          timeToBlockExpire: Math.ceil(blockDuration / 1000),
        };
      }

      return {
        totalHits: hits,
        timeToExpire: Math.ceil(pttl / 1000),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    } catch (e) {
      const now = Date.now();
      if (now - this.lastErrorLoggedAt > 10_000) {
        this.lastErrorLoggedAt = now;
        this.logger.error(
          `Redis throttler storage unavailable, failing open: ${(e as Error).message}`,
        );
      }
      return this.open();
    }
  }

  private open(): ThrottlerRecord {
    return { totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 };
  }
}
