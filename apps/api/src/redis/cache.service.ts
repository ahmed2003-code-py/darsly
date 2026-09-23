import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * A read-through cache for the handful of tables that almost never change.
 *
 * Redis was already here for rate limiting and socket fan-out; nothing was
 * cached with it. The catalogue is the clearest case: the subject and grade
 * lists are read on the registration page, the course filters and the teacher
 * onboarding flow — every one of those is an anonymous visitor hitting the
 * database for a closed list of a few dozen rows that an admin edits perhaps
 * twice a year.
 *
 * Deliberately not `@nestjs/cache-manager`. That would be three new packages
 * and a second configuration surface to reach the Redis connection this file
 * already holds, for the twenty lines below.
 *
 * Two properties it must have, both inherited from RedisService's stance that
 * a slow Redis must never become a slow request:
 *
 *  - **Falls open.** No Redis, a timeout, a parse failure — the loader runs and
 *    the caller cannot tell. A cache outage may cost latency, never an error.
 *  - **Writes invalidate immediately.** Every mutation clears the keys it
 *    affects before returning, so an admin who enables a subject sees it on the
 *    next request rather than at the end of a TTL. The TTL is the backstop for
 *    a write that happened on another replica while Redis was unreachable, not
 *    the mechanism.
 */
@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Returns the cached value for `key`, or runs `load`, stores it and returns
   * that. `ttlSeconds` bounds how long a missed invalidation can be wrong for.
   */
  async wrap<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    const client = this.redis.client;
    if (!client) return load();

    try {
      const hit = await client.get(key);
      if (hit !== null) return JSON.parse(hit) as T;
    } catch (e) {
      // Includes a JSON.parse failure on a value written by an older shape of
      // the code: treat it as a miss rather than failing the request.
      this.logger.warn(`cache read failed for ${key}, loading directly: ${(e as Error).message}`);
    }

    const value = await load();
    try {
      await client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (e) {
      this.logger.warn(`cache write failed for ${key}: ${(e as Error).message}`);
    }
    return value;
  }

  /**
   * Drops every key under a prefix.
   *
   * Uses SCAN rather than KEYS: KEYS blocks the whole Redis instance while it
   * walks the keyspace, and this instance is also what the rate limiter reads
   * on every request. An invalidation that stalls logins is not worth a cached
   * subject list.
   */
  async invalidate(prefix: string): Promise<void> {
    const client = this.redis.client;
    if (!client) return;
    try {
      let cursor = '0';
      do {
        const [next, keys] = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
        cursor = next;
        if (keys.length) await client.del(...keys);
      } while (cursor !== '0');
    } catch (e) {
      this.logger.warn(`cache invalidation failed for ${prefix}*: ${(e as Error).message}`);
    }
  }
}
