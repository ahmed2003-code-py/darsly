import express from 'express';
import request from 'supertest';

/**
 * Proves the exact mechanism @nestjs/throttler's default rate limiter keys
 * on (ThrottlerGuard.getTracker returns req.ip) resolves correctly with the
 * `app.set('trust proxy', true)` line in main.ts.
 *
 * Found live in production: 5 consecutive requests from the same client
 * returned x-ratelimit-remaining 15, 19, 17, 16, 19 — non-monotonic, because
 * without trust proxy, req.ip is Railway's own edge/proxy address (which
 * varies request to request across its edge nodes), not the real client. The
 * rate limiter was never broken; it was faithfully rate-limiting a different
 * "client" on every request. This doesn't boot the full Nest app (that would
 * need a database and every module) — it proves the one Express behavior
 * main.ts depends on, directly.
 */
describe('trust proxy — the mechanism the rate limiter tracker depends on', () => {
  function appWithTrustProxy(trustProxy: boolean) {
    const app = express();
    if (trustProxy) app.set('trust proxy', true);
    app.get('/whoami', (req, res) => res.json({ ip: req.ip }));
    return app;
  }

  it('without trust proxy, req.ip is the raw socket peer — spoofable-looking and, behind a real proxy, not the real client', async () => {
    const app = appWithTrustProxy(false);
    const res = await request(app).get('/whoami').set('X-Forwarded-For', '203.0.113.7');
    expect(res.body.ip).not.toBe('203.0.113.7');
  });

  it('with trust proxy enabled, req.ip resolves to the original client from X-Forwarded-For', async () => {
    const app = appWithTrustProxy(true);
    const res = await request(app).get('/whoami').set('X-Forwarded-For', '203.0.113.7');
    expect(res.body.ip).toBe('203.0.113.7');
  });

  it('with trust proxy enabled, the SAME client is resolved to the SAME address across repeated requests', async () => {
    const app = appWithTrustProxy(true);
    const ips = await Promise.all(
      Array.from({ length: 5 }, () => request(app).get('/whoami').set('X-Forwarded-For', '198.51.100.42')),
    );
    const distinct = new Set(ips.map((r) => r.body.ip));
    // This is exactly the property that was missing in production: one real
    // client must resolve to one identity, every time, for the rate limiter's
    // per-client counter to mean anything.
    expect(distinct.size).toBe(1);
    expect([...distinct][0]).toBe('198.51.100.42');
  });

  it('takes the leftmost (original client) address from a multi-hop X-Forwarded-For chain', async () => {
    const app = appWithTrustProxy(true);
    const res = await request(app).get('/whoami').set('X-Forwarded-For', '203.0.113.7, 10.0.0.5, 10.0.0.6');
    expect(res.body.ip).toBe('203.0.113.7');
  });
});
