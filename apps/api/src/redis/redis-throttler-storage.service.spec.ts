import { RedisThrottlerStorageService } from './redis-throttler-storage.service';
import type { RedisService } from './redis.service';

describe('RedisThrottlerStorageService', () => {
  it('resolves as "not limited" when no Redis client is configured (REDIS_URL unset)', async () => {
    const storage = new RedisThrottlerStorageService({ client: null } as unknown as RedisService);
    const record = await storage.increment('1.2.3.4', 60_000, 20, 60_000, 'default');
    expect(record).toEqual({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 });
  });

  it('fails OPEN — a broken Redis connection never blocks or throws into the request', async () => {
    const brokenClient = { eval: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
    const storage = new RedisThrottlerStorageService({ client: brokenClient } as unknown as RedisService);
    const record = await storage.increment('1.2.3.4', 60_000, 20, 60_000, 'default');
    expect(record.isBlocked).toBe(false);
    expect(record).toEqual({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 });
  });

  it('does not spam the error log on every failed call while Redis stays down', async () => {
    const brokenClient = { eval: jest.fn().mockRejectedValue(new Error('down')) };
    const storage = new RedisThrottlerStorageService({ client: brokenClient } as unknown as RedisService);
    for (let i = 0; i < 5; i++) await storage.increment('k', 60_000, 20, 60_000, 'default');
    // Five failures in the same instant log at most once (the 10s dedup window).
    expect(brokenClient.eval).toHaveBeenCalledTimes(5);
  });

  it('passes the real @nestjs/throttler ThrottlerStorage shape through eval() correctly on success', async () => {
    const client = { eval: jest.fn().mockResolvedValue([3, 45_000, 0, 0]) };
    const storage = new RedisThrottlerStorageService({ client } as unknown as RedisService);
    const record = await storage.increment('student:abc', 60_000, 20, 60_000, 'default');
    expect(record).toEqual({ totalHits: 3, timeToExpire: 45, isBlocked: false, timeToBlockExpire: 0 });
    expect(client.eval).toHaveBeenCalledWith(
      expect.any(String),
      2,
      'throttle:student:abc:default',
      'throttle:student:abc:default:blocked',
      60_000,
      20,
      60_000,
    );
  });

  it('reports a block exactly as the script returns it', async () => {
    const client = { eval: jest.fn().mockResolvedValue([21, 12_000, 1, 30_000]) };
    const storage = new RedisThrottlerStorageService({ client } as unknown as RedisService);
    const record = await storage.increment('ip:1.2.3.4', 60_000, 20, 30_000, 'default');
    expect(record).toEqual({ totalHits: 21, timeToExpire: 12, isBlocked: true, timeToBlockExpire: 30 });
  });
});
