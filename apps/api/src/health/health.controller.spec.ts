import { HttpStatus } from '@nestjs/common';
import { HealthController } from './health.controller';

/**
 * The distinction this endpoint set had to grow: liveness is "should this
 * process be killed", readiness is "should it be given traffic". Answering
 * both with one check meant either dependencies went unreported, or a Redis
 * outage would have restarted every replica at once.
 */
function make(over: { db?: unknown; redis?: unknown; storage?: unknown } = {}) {
  const prisma = { $queryRaw: jest.fn().mockResolvedValue(over.db ?? [{ '?column?': 1 }]) } as any;
  if (over.db instanceof Error) prisma.$queryRaw = jest.fn().mockRejectedValue(over.db);

  const redis = {
    client: over.redis === null ? null : { ping: jest.fn().mockResolvedValue('PONG') },
  } as any;
  if (over.redis instanceof Error) redis.client = { ping: jest.fn().mockRejectedValue(over.redis) };

  const storage = { exists: jest.fn().mockResolvedValue(false) } as any;
  if (over.storage instanceof Error) storage.exists = jest.fn().mockRejectedValue(over.storage);

  return { controller: new HealthController(prisma, redis, storage), prisma, redis, storage };
}

const res = () => ({ status: jest.fn() }) as any;

describe('HealthController', () => {
  describe('liveness', () => {
    it('answers ok without touching any dependency', () => {
      const { controller, prisma, redis, storage } = make();

      expect(controller.live()).toMatchObject({ status: 'ok', service: 'darsly-api' });

      // The point: a dependency's bad afternoon must not become a restart loop.
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(storage.exists).not.toHaveBeenCalled();
      expect(redis.client.ping).not.toHaveBeenCalled();
    });
  });

  describe('readiness', () => {
    it('reports every dependency when all are healthy', async () => {
      const { controller } = make();
      const r = res();

      const out = await controller.ready(r);

      expect(out).toMatchObject({ status: 'ok', checks: { database: 'ok', redis: 'ok', storage: 'ok' } });
      expect(r.status).not.toHaveBeenCalled();
    });

    it('503s when the database is unusable — nothing can be served without it', async () => {
      const { controller } = make({ db: new Error('connection refused') });
      const r = res();

      const out = await controller.ready(r);

      expect(r.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
      expect(out.checks.database).toBe('down');
      expect(out.status).toBe('degraded');
    });

    /**
     * Redis failing open is designed in — rate limiting stops enforcing,
     * Socket.IO drops to single-instance fan-out — so a replica that can still
     * answer every HTTP request stays in rotation. What was missing was that
     * nobody could *see* it had happened.
     */
    it('reports Redis down without taking the replica out of rotation', async () => {
      const { controller } = make({ redis: new Error('ECONNRESET') });
      const r = res();

      const out = await controller.ready(r);

      expect(out.checks.redis).toBe('down');
      expect(out.status).toBe('ok');
      expect(r.status).not.toHaveBeenCalled();
    });

    it('calls an absent Redis "not_configured" rather than down — it is a valid local setup', async () => {
      const { controller } = make({ redis: null });
      const r = res();

      expect((await controller.ready(r)).checks.redis).toBe('not_configured');
      expect(r.status).not.toHaveBeenCalled();
    });

    it('reports storage down without failing readiness', async () => {
      const { controller } = make({ storage: new Error('bucket unreachable') });
      const r = res();

      const out = await controller.ready(r);

      expect(out.checks.storage).toBe('down');
      expect(r.status).not.toHaveBeenCalled();
    });

    it('treats a storage probe that finds nothing as healthy — absence is the expected answer', async () => {
      const { controller, storage } = make();
      const r = res();

      expect((await controller.ready(r)).checks.storage).toBe('ok');
      expect(storage.exists).toHaveBeenCalledWith('__healthcheck__');
    });
  });

  describe('the original endpoint', () => {
    it('still answers exactly as before, so the deploy probe keeps working', async () => {
      const { controller, prisma } = make();

      const out = await controller.health();

      expect(out).toMatchObject({ status: 'ok', service: 'darsly-api' });
      expect(Object.keys(out).sort()).toEqual(['service', 'status', 'time']);
      expect(prisma.$queryRaw).toHaveBeenCalled();
    });

    it('still throws when the database is down, as it always did', async () => {
      const { controller } = make({ db: new Error('down') });

      await expect(controller.health()).rejects.toThrow();
    });
  });
});
