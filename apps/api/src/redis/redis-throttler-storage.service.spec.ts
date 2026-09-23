import { RedisThrottlerStorageService } from './redis-throttler-storage.service';
import type { RedisService } from './redis.service';

function fakeClient(
  overrides: Partial<Record<'pttl' | 'incr' | 'pexpire' | 'set', jest.Mock>> = {},
) {
  return {
    pttl: jest.fn().mockResolvedValue(-2), // no such key by default
    incr: jest.fn().mockResolvedValue(1),
    pexpire: jest.fn().mockResolvedValue(1),
    set: jest.fn().mockResolvedValue('OK'),
    ...overrides,
  };
}

describe('RedisThrottlerStorageService', () => {
  it('resolves as "not limited" when no Redis client is configured (REDIS_URL unset)', async () => {
    const storage = new RedisThrottlerStorageService({ client: null } as unknown as RedisService);
    const record = await storage.increment('1.2.3.4', 60_000, 20, 60_000, 'default');
    expect(record).toEqual({
      totalHits: 0,
      timeToExpire: 0,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
  });

  it('fails OPEN — a broken Redis connection never blocks or throws into the request', async () => {
    const client = fakeClient({ pttl: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) });
    const storage = new RedisThrottlerStorageService({ client } as unknown as RedisService);
    const record = await storage.increment('1.2.3.4', 60_000, 20, 60_000, 'default');
    expect(record).toEqual({
      totalHits: 0,
      timeToExpire: 0,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
  });

  it('does not spam the error log on every failed call while Redis stays down', async () => {
    const client = fakeClient({ pttl: jest.fn().mockRejectedValue(new Error('down')) });
    const storage = new RedisThrottlerStorageService({ client } as unknown as RedisService);
    for (let i = 0; i < 5; i++) await storage.increment('k', 60_000, 20, 60_000, 'default');
    expect(client.pttl).toHaveBeenCalledTimes(5);
  });

  it('uses only INCR/PEXPIRE/SET/PTTL — never EVAL — so a Redis that restricts scripting still works', async () => {
    const client = fakeClient();
    const storage = new RedisThrottlerStorageService({ client } as unknown as RedisService);
    expect((client as Record<string, unknown>).eval).toBeUndefined();
    await storage.increment('student:abc', 60_000, 20, 60_000, 'default');
    expect(client.pttl).toHaveBeenCalledWith('throttle:student:abc:default:blocked');
    expect(client.incr).toHaveBeenCalledWith('throttle:student:abc:default');
  });

  it('sets the window TTL only on the first hit, not every hit', async () => {
    const client = fakeClient({
      incr: jest.fn().mockResolvedValue(3),
      pttl: jest.fn().mockResolvedValueOnce(-2).mockResolvedValueOnce(45_000),
    });
    const storage = new RedisThrottlerStorageService({ client } as unknown as RedisService);
    const record = await storage.increment('k', 60_000, 20, 60_000, 'default');
    expect(client.pexpire).not.toHaveBeenCalled(); // hits=3, not the first hit
    expect(record).toEqual({
      totalHits: 3,
      timeToExpire: 45,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
  });

  it('reasserts the window if the counter key raced past its own expiry', async () => {
    const client = fakeClient({
      incr: jest.fn().mockResolvedValue(1),
      pttl: jest.fn().mockResolvedValueOnce(-2).mockResolvedValueOnce(-1),
    });
    const storage = new RedisThrottlerStorageService({ client } as unknown as RedisService);
    const record = await storage.increment('k', 60_000, 20, 60_000, 'default');
    expect(client.pexpire).toHaveBeenCalledTimes(2); // once for the first-hit branch, once for the race reassertion
    expect(record.timeToExpire).toBe(60);
  });

  it('writes the block key once the limit is exceeded and reports it blocked', async () => {
    const client = fakeClient({
      incr: jest.fn().mockResolvedValue(21),
      pttl: jest.fn().mockResolvedValueOnce(-2).mockResolvedValueOnce(12_000),
    });
    const storage = new RedisThrottlerStorageService({ client } as unknown as RedisService);
    const record = await storage.increment('ip:1.2.3.4', 60_000, 20, 30_000, 'default');
    expect(client.set).toHaveBeenCalledWith(
      'throttle:ip:1.2.3.4:default:blocked',
      '1',
      'PX',
      30_000,
    );
    expect(record).toEqual({
      totalHits: 21,
      timeToExpire: 12,
      isBlocked: true,
      timeToBlockExpire: 30,
    });
  });

  it('reports isBlocked from the block key alone, without incrementing the hit counter further', async () => {
    const client = fakeClient({ pttl: jest.fn().mockResolvedValue(25_000) }); // block key already active
    const storage = new RedisThrottlerStorageService({ client } as unknown as RedisService);
    const record = await storage.increment('ip:1.2.3.4', 60_000, 20, 30_000, 'default');
    expect(client.incr).not.toHaveBeenCalled();
    expect(record).toEqual({
      totalHits: 0,
      timeToExpire: 25,
      isBlocked: true,
      timeToBlockExpire: 25,
    });
  });
});
