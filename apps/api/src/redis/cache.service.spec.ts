import { CacheService } from './cache.service';
import { RedisService } from './redis.service';

/**
 * A cache is only safe if it is invisible when it breaks and honest when it is
 * stale. Both are asserted here, because a cache that fails a request during a
 * Redis blip is worse than no cache at all — this Redis is also what the rate
 * limiter reads on every request.
 */
describe('CacheService', () => {
  const svc = (client: unknown) => new CacheService({ client } as unknown as RedisService);
  const quiet = (s: CacheService) => jest.spyOn(s['logger'], 'warn').mockImplementation(() => undefined);

  describe('with no Redis at all', () => {
    it('loads directly rather than failing', async () => {
      const load = jest.fn().mockResolvedValue(['a']);
      await expect(svc(null).wrap('k', 60, load)).resolves.toEqual(['a']);
      expect(load).toHaveBeenCalledTimes(1);
    });

    it('treats invalidation as a no-op', async () => {
      await expect(svc(null).invalidate('catalog:')).resolves.toBeUndefined();
    });
  });

  describe('with a healthy Redis', () => {
    it('returns the stored value without calling the loader', async () => {
      const load = jest.fn();
      const client = { get: jest.fn().mockResolvedValue('[{"id":"s1"}]'), set: jest.fn() };
      await expect(svc(client).wrap('k', 60, load)).resolves.toEqual([{ id: 's1' }]);
      expect(load).not.toHaveBeenCalled();
    });

    it('stores a miss under the requested expiry', async () => {
      const client = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
      await svc(client).wrap('k', 600, async () => ({ n: 1 }));
      expect(client.set).toHaveBeenCalledWith('k', '{"n":1}', 'EX', 600);
    });

    /** KEYS would block the instance the rate limiter is reading. */
    it('clears a prefix with SCAN, never KEYS', async () => {
      const client = {
        scan: jest
          .fn()
          .mockResolvedValueOnce(['7', ['catalog:grades']])
          .mockResolvedValueOnce(['0', ['catalog:subjects:all']]),
        del: jest.fn(),
      };
      await svc(client).invalidate('catalog:');
      expect(client.scan).toHaveBeenCalledWith('0', 'MATCH', 'catalog:*', 'COUNT', 200);
      expect(client.scan).toHaveBeenCalledWith('7', 'MATCH', 'catalog:*', 'COUNT', 200);
      expect(client.del).toHaveBeenCalledWith('catalog:grades');
      expect(client.del).toHaveBeenCalledWith('catalog:subjects:all');
    });

    it('does not call DEL when a scan page is empty', async () => {
      const client = { scan: jest.fn().mockResolvedValue(['0', []]), del: jest.fn() };
      await svc(client).invalidate('catalog:');
      expect(client.del).not.toHaveBeenCalled();
    });
  });

  describe('when Redis misbehaves', () => {
    it('falls through to the loader when the read throws', async () => {
      const client = { get: jest.fn().mockRejectedValue(new Error('down')), set: jest.fn() };
      const s = svc(client); quiet(s);
      await expect(s.wrap('k', 60, async () => 'fresh')).resolves.toBe('fresh');
    });

    /** A value written by an older shape of the code is a miss, not a 500. */
    it('treats unreadable stored JSON as a miss', async () => {
      const client = { get: jest.fn().mockResolvedValue('{not json'), set: jest.fn() };
      const s = svc(client); quiet(s);
      await expect(s.wrap('k', 60, async () => 'fresh')).resolves.toBe('fresh');
    });

    it('still answers when the write throws', async () => {
      const client = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockRejectedValue(new Error('oom')) };
      const s = svc(client); quiet(s);
      await expect(s.wrap('k', 60, async () => 'fresh')).resolves.toBe('fresh');
    });

    it('swallows a failed invalidation rather than failing the write that triggered it', async () => {
      const client = { scan: jest.fn().mockRejectedValue(new Error('down')) };
      const s = svc(client); quiet(s);
      await expect(s.invalidate('catalog:')).resolves.toBeUndefined();
    });
  });
});
