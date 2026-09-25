import { Logger } from '@nestjs/common';
import {
  CF_STUN,
  CloudflareRealtimeClient,
  CloudflareRealtimeError,
  redactPath,
  toHttpError,
} from './cloudflare-realtime.client';
import { CloudflareLiveProvider } from './cloudflare-live.provider';
import { DailyLiveProvider } from './daily-live.provider';
import { LiveProviders, liveProviderFromEnv } from './live-providers';
import { buildLiveProviders } from './live-providers.module';
import { canSpeak, handStatesFor, nextHandState } from '../rtc/live-hand';

const APP = 'a'.repeat(32);
const SECRET = 'S3CR3T-cf-app-secret-value-0123456789abcdef';

async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void> | void,
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function reply(status: number, body: unknown) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

/** Every log line the client writes, to check none of them carries the secret. */
function captureLogs() {
  const lines: string[] = [];
  const spies = (['log', 'warn', 'error', 'debug'] as const).map((m) =>
    jest.spyOn(Logger.prototype, m).mockImplementation((...a: any[]) => {
      lines.push(String(a[0]));
    }),
  );
  return { lines, restore: () => spies.forEach((s) => s.mockRestore()) };
}

describe('CloudflareRealtimeClient', () => {
  const env = { CF_REALTIME_APP_ID: APP, CF_REALTIME_APP_SECRET: SECRET };

  it('uses the secret only in the Authorization header, and never logs it', () =>
    withEnv(env, async () => {
      const logs = captureLogs();
      const c = new CloudflareRealtimeClient();
      const calls: { url: string; init: RequestInit }[] = [];
      c.fetchImpl = jest.fn(async (url: any, init: any) => {
        calls.push({ url: String(url), init });
        return reply(500, { errorCode: 'X', errorDescription: `boom ${SECRET}` });
      }) as any;
      await expect(c.newSession()).rejects.toBeInstanceOf(CloudflareRealtimeError);
      expect(calls[0].url).toBe(`https://rtc.live.cloudflare.com/v1/apps/${APP}/sessions/new`);
      expect((calls[0].init.headers as any).Authorization).toBe(`Bearer ${SECRET}`);
      // An error body that echoes the secret does not carry it into a log, and
      // the app id in the path is redacted.
      expect(logs.lines.join('\n')).not.toContain(APP);
      expect(logs.lines.join('\n')).not.toContain(SECRET);
      expect(logs.lines.join('\n')).toContain('[redacted]');
      logs.restore();
    }));

  it('fails as "config" with no credentials, without calling out', () =>
    withEnv({ CF_REALTIME_APP_ID: undefined, CF_REALTIME_APP_SECRET: undefined }, async () => {
      const c = new CloudflareRealtimeClient();
      c.fetchImpl = jest.fn() as any;
      expect(c.configured).toBe(false);
      await expect(c.newSession()).rejects.toMatchObject({ failure: 'config' });
      expect(c.fetchImpl).not.toHaveBeenCalled();
    }));

  it('retries a new session once on a 5xx, never tracks/new', () =>
    withEnv(env, async () => {
      const logs = captureLogs();
      const c = new CloudflareRealtimeClient();
      const f = jest
        .fn()
        .mockResolvedValueOnce(reply(503, {}))
        .mockResolvedValueOnce(reply(201, { sessionId: 'b'.repeat(32) }));
      c.fetchImpl = f as any;
      await expect(c.newSession()).resolves.toBe('b'.repeat(32));
      expect(f).toHaveBeenCalledTimes(2);

      const g = jest.fn().mockResolvedValue(reply(502, {}));
      c.fetchImpl = g as any;
      await expect(
        c.pushTracks('s', { sdp: 'v=0', type: 'offer' }, [{ mid: '0', trackName: 't' }]),
      ).rejects.toMatchObject({ failure: 'server', status: 502 });
      expect(g).toHaveBeenCalledTimes(1);
      logs.restore();
    }));

  it('does not retry a rejected secret, and says so', () =>
    withEnv(env, async () => {
      const logs = captureLogs();
      const c = new CloudflareRealtimeClient();
      const f = jest.fn().mockResolvedValue(reply(401, { errorCode: 'unauthorized' }));
      c.fetchImpl = f as any;
      await expect(c.newSession()).rejects.toMatchObject({ failure: 'auth', status: 401 });
      expect(f).toHaveBeenCalledTimes(1);
      expect(logs.lines.some((l) => /secret was rejected/.test(l))).toBe(true);
      expect(logs.lines.join('\n')).not.toContain(SECRET);
      logs.restore();
    }));

  it('turns a hung call into a timeout', () =>
    withEnv(env, async () => {
      const logs = captureLogs();
      const c = new CloudflareRealtimeClient();
      c.fetchImpl = jest.fn(async () => {
        const e = new Error('The operation was aborted due to timeout');
        e.name = 'TimeoutError';
        throw e;
      }) as any;
      await expect(c.getSession('x')).rejects.toMatchObject({ failure: 'timeout' });
      expect(c.fetchImpl).toHaveBeenCalledTimes(2); // GET is retried once
      logs.restore();
    }));

  it('sends pulls with the simulcast layer only when asked', () =>
    withEnv(env, async () => {
      const c = new CloudflareRealtimeClient();
      const bodies: any[] = [];
      c.fetchImpl = jest.fn(async (_u: any, init: any) => {
        bodies.push(JSON.parse(init.body));
        return reply(200, { tracks: [] });
      }) as any;
      await c.pullTracks('me', [
        { sessionId: 'p', trackName: 'video-1', preferredRid: 'l' },
        { sessionId: 'p', trackName: 'audio-1' },
      ]);
      expect(bodies[0].tracks).toEqual([
        {
          location: 'remote',
          sessionId: 'p',
          trackName: 'video-1',
          simulcast: { preferredRid: 'l' },
        },
        { location: 'remote', sessionId: 'p', trackName: 'audio-1' },
      ]);
    }));

  it('closes tracks by mid, with force for the server-side teardown', () =>
    withEnv(env, async () => {
      const c = new CloudflareRealtimeClient();
      const seen: any[] = [];
      c.fetchImpl = jest.fn(async (u: any, init: any) => {
        seen.push({ u: String(u), m: init.method, b: JSON.parse(init.body) });
        return reply(200, {});
      }) as any;
      await c.closeTracks('sess', ['0', '1'], { force: true });
      expect(seen[0]).toEqual({
        u: `https://rtc.live.cloudflare.com/v1/apps/${APP}/sessions/sess/tracks/close`,
        m: 'PUT',
        b: { tracks: [{ mid: '0' }, { mid: '1' }], force: true },
      });
    }));

  it('hands out STUN only without a TURN key, and TURN when one is configured', () =>
    withEnv({ ...env, CF_TURN_KEY_ID: undefined, CF_TURN_KEY_API_TOKEN: undefined }, async () => {
      const c = new CloudflareRealtimeClient();
      c.fetchImpl = jest.fn() as any;
      expect(c.turnConfigured).toBe(false);
      await expect(c.iceServers()).resolves.toEqual([CF_STUN]);
      expect(c.fetchImpl).not.toHaveBeenCalled();

      await withEnv({ CF_TURN_KEY_ID: 'k1', CF_TURN_KEY_API_TOKEN: 'turn-token' }, async () => {
        const turn = {
          urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
          username: 'u',
          credential: 'c',
        };
        c.fetchImpl = jest.fn(async (u: any, init: any) => {
          expect(String(u)).toBe(
            'https://rtc.live.cloudflare.com/v1/turn/keys/k1/credentials/generate-ice-servers',
          );
          expect(init.headers.Authorization).toBe('Bearer turn-token');
          return reply(201, { iceServers: [CF_STUN, turn] });
        }) as any;
        await expect(c.iceServers()).resolves.toEqual([CF_STUN, turn]);
        // A TURN outage keeps everyone who does not need a relay in the class.
        const logs = captureLogs();
        c.fetchImpl = jest.fn(async () => reply(500, {})) as any;
        await expect(c.iceServers()).resolves.toEqual([CF_STUN]);
        logs.restore();
      });
    }));

  it('maps failures to the codes the classroom page already explains', () => {
    const err = (f: any, s: number | null = null) => new CloudflareRealtimeError(f, s, 'x');
    expect((toHttpError(err('config')).getResponse() as any).code).toBe('LIVE_NOT_CONFIGURED');
    expect((toHttpError(err('timeout')).getResponse() as any).code).toBe(
      'LIVE_PROVIDER_UNREACHABLE',
    );
    expect((toHttpError(err('server', 500)).getResponse() as any).code).toBe(
      'LIVE_PROVIDER_UNREACHABLE',
    );
    expect((toHttpError(err('auth', 401)).getResponse() as any).code).toBe('LIVE_PROVIDER_ERROR');
    const gone = toHttpError(err('rejected', 410));
    expect(gone.getStatus()).toBe(409);
    expect((gone.getResponse() as any).code).toBe('RTC_SESSION_EXPIRED');
    const rej = toHttpError(err('rejected', 400));
    expect(rej.getStatus()).toBe(400);
    expect((rej.getResponse() as any).code).toBe('LIVE_RTC_REJECTED');
  });

  it('redacts Cloudflare ids in logged paths', () => {
    expect(redactPath(`/sessions/${'f'.repeat(32)}/tracks/new`)).toBe('/sessions/<id>/tracks/new');
  });
});

describe('provider selection', () => {
  it('reads LIVE_PROVIDER: cloudflare by default, daily on request, nothing else', () => {
    expect(liveProviderFromEnv({})).toBe('CLOUDFLARE');
    expect(liveProviderFromEnv({ LIVE_PROVIDER: ' Cloudflare ' })).toBe('CLOUDFLARE');
    expect(liveProviderFromEnv({ LIVE_PROVIDER: 'daily' })).toBe('DAILY');
    expect(() => liveProviderFromEnv({ LIVE_PROVIDER: 'zoom' })).toThrow(/not a live provider/);
  });

  const daily = () => new DailyLiveProvider({ configured: true } as any);
  const cf = (configured: boolean) =>
    new CloudflareLiveProvider(
      {} as any,
      {
        configured,
        turnConfigured: false,
      } as any,
    );

  it('refuses to boot with cloudflare selected and no credentials — no silent fallback', () => {
    const logs = captureLogs();
    expect(() => buildLiveProviders(daily(), cf(false), { NODE_ENV: 'production' })).toThrow(
      /CF_REALTIME_APP_ID/,
    );
    expect(() => buildLiveProviders(daily(), cf(false), { NODE_ENV: 'development' })).toThrow();
    // Daily selected: Cloudflare's credentials are not needed.
    expect(buildLiveProviders(daily(), cf(false), { LIVE_PROVIDER: 'daily' }).defaultKind).toBe(
      'DAILY',
    );
    expect(buildLiveProviders(daily(), cf(true), {}).defaultKind).toBe('CLOUDFLARE');
    logs.restore();
  });

  it('keeps each class on the provider it was created with', () => {
    const reg = new LiveProviders([daily(), cf(true)], 'CLOUDFLARE');
    expect(reg.forSession({ provider: 'DAILY' }).kind).toBe('DAILY');
    expect(reg.forSession({ provider: 'CLOUDFLARE' }).kind).toBe('CLOUDFLARE');
    // Rows from before the column existed ran on Daily.
    expect(reg.forSession({}).kind).toBe('DAILY');
    expect(reg.forSession({ provider: null }).kind).toBe('DAILY');
    expect(reg.default.kind).toBe('CLOUDFLARE');
  });

  it('opens a Cloudflare class with no provider call, and a fresh run key each time', async () => {
    const p = cf(true);
    const a = await p.openRoom({ sessionId: 'ls1', startsAtMs: 0 });
    await new Promise((r) => setTimeout(r, 2));
    const b = await p.openRoom({ sessionId: 'ls1', startsAtMs: 0 });
    expect(a.url).toBeNull();
    expect(a.name).toMatch(/^cf-ls1-/);
    expect(b.name).not.toBe(a.name);
    await expect(p.closeRoom()).resolves.toBe('cleanup-pending');
  });

  it('gives the browser Darsly endpoints and ICE servers — never a secret', async () => {
    const p = new CloudflareLiveProvider(
      {} as any,
      {
        configured: true,
        iceServers: async () => [CF_STUN],
      } as any,
    );
    const access = await p.participantAccess({
      session: { id: 'ls1', roomName: 'cf-ls1-x', roomUrl: null },
      userId: 'u',
      userName: 'n',
      role: 'STUDENT',
      endsAtMs: 0,
    });
    expect(access).toEqual({
      provider: 'cloudflare',
      iceServers: [CF_STUN],
      rtcPath: '/live/ls1/rtc',
    });
  });
});

describe('raise hand state machine', () => {
  it('moves only along the drawn edges', () => {
    expect(nextHandState('IDLE', 'raise')).toBe('HAND_RAISED');
    expect(nextHandState('RELEASED', 'raise')).toBe('HAND_RAISED');
    expect(nextHandState('HAND_RAISED', 'approve')).toBe('APPROVED_TO_SPEAK');
    expect(nextHandState('HAND_RAISED', 'reject')).toBe('IDLE');
    expect(nextHandState('HAND_RAISED', 'lower')).toBe('IDLE');
    expect(nextHandState('APPROVED_TO_SPEAK', 'published')).toBe('ACTIVE_SPEAKER');
    expect(nextHandState('ACTIVE_SPEAKER', 'revoke')).toBe('RELEASED');
    expect(nextHandState('APPROVED_TO_SPEAK', 'revoke')).toBe('RELEASED');
    expect(nextHandState('ACTIVE_SPEAKER', 'lower')).toBe('RELEASED');
  });

  it('refuses everything else', () => {
    expect(nextHandState('IDLE', 'approve')).toBeNull(); // no approval without a hand
    expect(nextHandState('IDLE', 'revoke')).toBeNull();
    expect(nextHandState('HAND_RAISED', 'raise')).toBeNull();
    expect(nextHandState('ACTIVE_SPEAKER', 'approve')).toBeNull();
    expect(nextHandState('RELEASED', 'published')).toBeNull();
    expect(handStatesFor('revoke').sort()).toEqual(['ACTIVE_SPEAKER', 'APPROVED_TO_SPEAK']);
  });

  it('lets only an approved or active speaker send', () => {
    expect(canSpeak('APPROVED_TO_SPEAK')).toBe(true);
    expect(canSpeak('ACTIVE_SPEAKER')).toBe(true);
    for (const s of ['IDLE', 'HAND_RAISED', 'RELEASED', null, undefined] as const) {
      expect(canSpeak(s as any)).toBe(false);
    }
  });
});

describe('usage capture (cost tracking)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { usageOf, EST_GB_PER_RECEIVER_HOUR } = require('./live-usage');
  const T = Date.UTC(2026, 8, 25, 10, 0, 0);
  const at = (min: number) => new Date(T + min * 60_000);

  it('adds minutes by role, clips at the end, and finds the peak', () => {
    const u = usageOf(
      [
        { role: 'TEACHER', purpose: 'SEND', createdAt: at(0), closedAt: at(60) },
        { role: 'STUDENT', purpose: 'RECEIVE', createdAt: at(0), closedAt: at(60) },
        { role: 'STUDENT', purpose: 'RECEIVE', createdAt: at(10), closedAt: at(30) },
        // Still open when the class ended: counted to the end, not beyond.
        { role: 'STUDENT', purpose: 'RECEIVE', createdAt: at(20), closedAt: null },
        { role: 'RECORDER', purpose: 'RECEIVE', createdAt: at(5), closedAt: at(95) },
      ],
      { endedAt: at(60), recordedSec: 55 * 60, now: at(61) },
    );
    expect(u.sendMinutes).toEqual({ teacher: 60, student: 0 });
    expect(u.receiveMinutes).toEqual({ teacher: 0, student: 60 + 20 + 40, recorder: 55 });
    expect(u.peakReceivers).toBe(4); // 20–30: three students and the recorder
    expect(u.recordedMinutes).toBe(55);
    const hours = (120 + 55) / 60;
    expect(u.estimate.egressGb).toBeCloseTo(hours * EST_GB_PER_RECEIVER_HOUR, 2);
    expect(u.estimate.basis).toMatch(/^ESTIMATED/);
  });
});
