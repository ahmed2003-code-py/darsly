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
 * KEYS[1] = hit counter, KEYS[2] = block flag. Mirrors the in-memory
 * ThrottlerStorageService's semantics exactly: while blocked, hits do not
 * accumulate further; the block key's own TTL is the authority on when a
 * client is unblocked, independent of the hit counter's window.
 */
const INCREMENT_SCRIPT = `
local hitsKey = KEYS[1]
local blockKey = KEYS[2]
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockDuration = tonumber(ARGV[3])

local blockPttl = redis.call('PTTL', blockKey)
if blockPttl > 0 then
  return {0, blockPttl, 1, blockPttl}
end

local hits = redis.call('INCR', hitsKey)
if hits == 1 then
  redis.call('PEXPIRE', hitsKey, ttl)
end
local pttl = redis.call('PTTL', hitsKey)
if pttl < 0 then
  redis.call('PEXPIRE', hitsKey, ttl)
  pttl = ttl
end

if hits > limit then
  redis.call('SET', blockKey, '1', 'PX', blockDuration)
  return {hits, pttl, 1, blockDuration}
end

return {hits, pttl, 0, 0}
`;

/**
 * Distributed replacement for @nestjs/throttler's default in-memory storage.
 * Both Railway replicas share the same Redis-held counters, so a limit like
 * "20 login attempts/minute" is the limit across the whole deployment — not
 * per instance, which is what let it become ~40 in practice before this.
 *
 * Fails OPEN: if Redis is unreachable, increment() resolves as "not limited"
 * rather than rejecting the request or throwing into the request pipeline.
 * Deliberate, not an oversight — see docs/SYSTEM.md "Rate limiting" section.
 * The alternative (fail closed) turns a transient Redis blip into a total
 * login outage for every user, which is worse than a brief window of
 * unenforced throttling; argon2 password hashing and the account model
 * itself remain the durable defenses against brute force, this limiter is a
 * second layer on top of them, not the only one.
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
      const [hits, pttl, isBlocked, blockPttl] = (await client.eval(
        INCREMENT_SCRIPT,
        2,
        hitsKey,
        blockKey,
        ttl,
        limit,
        blockDuration,
      )) as [number, number, number, number];
      return {
        totalHits: hits,
        timeToExpire: Math.ceil(pttl / 1000),
        isBlocked: isBlocked === 1,
        timeToBlockExpire: Math.ceil(blockPttl / 1000),
      };
    } catch (e) {
      const now = Date.now();
      if (now - this.lastErrorLoggedAt > 10_000) {
        this.lastErrorLoggedAt = now;
        this.logger.error(`Redis throttler storage unavailable, failing open: ${(e as Error).message}`);
      }
      return this.open();
    }
  }

  private open(): ThrottlerRecord {
    return { totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 };
  }
}
