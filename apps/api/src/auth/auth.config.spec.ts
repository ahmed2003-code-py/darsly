import { AuthConfig } from './auth.config';

/**
 * Defaults and fallbacks, asserted once here instead of being repeated —
 * differently — at each call site.
 *
 * That repetition is the reason this class exists: `JWT_ACCESS_TTL ?? 900`
 * appeared in two files and `JWT_ACCESS_SECRET` in eight, and nothing made the
 * defaults agree except everyone writing the same number.
 */
describe('AuthConfig', () => {
  const OLD = process.env;

  beforeEach(() => {
    process.env = { ...OLD };
  });
  afterAll(() => {
    process.env = OLD;
  });

  const clear = (...keys: string[]) => keys.forEach((k) => delete process.env[k]);

  describe('token lifetimes', () => {
    it('defaults to 15 minutes and 30 days', () => {
      clear('JWT_ACCESS_TTL', 'JWT_REFRESH_TTL');
      const c = new AuthConfig();

      expect(c.accessTtlSeconds).toBe(900);
      expect(c.refreshTtlSeconds).toBe(2_592_000);
    });

    it('takes the configured values when they are set', () => {
      process.env.JWT_ACCESS_TTL = '60';
      process.env.JWT_REFRESH_TTL = '120';
      const c = new AuthConfig();

      expect(c.accessTtlSeconds).toBe(60);
      expect(c.refreshTtlSeconds).toBe(120);
    });

    /**
     * `Number('fifteen')` is NaN, and `expiresIn: NaN` is not a token lifetime
     * — it is a token the library may treat as already expired or never
     * expiring. Falling back is the only safe reading of a nonsense value.
     */
    it.each([['a word', 'fifteen'], ['empty', ''], ['zero', '0'], ['negative', '-5']])(
      'falls back rather than trusting %s',
      (_label, value) => {
        process.env.JWT_ACCESS_TTL = value;

        expect(new AuthConfig().accessTtlSeconds).toBe(900);
      },
    );
  });

  describe('device lifetimes', () => {
    it('fall back to the web ones when unset', () => {
      clear('DEVICE_JWT_ACCESS_TTL', 'DEVICE_JWT_REFRESH_TTL');
      process.env.JWT_ACCESS_TTL = '111';
      process.env.JWT_REFRESH_TTL = '222';
      const c = new AuthConfig();

      expect(c.deviceAccessTtlSeconds).toBe(111);
      expect(c.deviceRefreshTtlSeconds).toBe(222);
    });

    it('override the web ones when set — a windowsill device is not a browser', () => {
      process.env.JWT_ACCESS_TTL = '111';
      process.env.DEVICE_JWT_ACCESS_TTL = '999';

      expect(new AuthConfig().deviceAccessTtlSeconds).toBe(999);
    });

    it('fall all the way through to the base defaults when nothing is set', () => {
      clear('DEVICE_JWT_ACCESS_TTL', 'DEVICE_JWT_REFRESH_TTL', 'JWT_ACCESS_TTL', 'JWT_REFRESH_TTL');
      const c = new AuthConfig();

      expect(c.deviceAccessTtlSeconds).toBe(900);
      expect(c.deviceRefreshTtlSeconds).toBe(2_592_000);
    });
  });

  describe('secrets', () => {
    it('are read, not defaulted — boot already refuses a missing one', () => {
      process.env.JWT_ACCESS_SECRET = 'access-secret';
      process.env.JWT_REFRESH_SECRET = 'refresh-secret';
      const c = new AuthConfig();

      expect(c.accessSecret).toBe('access-secret');
      expect(c.refreshSecret).toBe('refresh-secret');
    });

    it('are undefined rather than invented when absent', () => {
      clear('JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET');
      const c = new AuthConfig();

      // A fabricated fallback secret would be far worse than a loud failure:
      // config.validation.ts refuses to boot without these, and that refusal
      // is the protection.
      expect(c.accessSecret).toBeUndefined();
      expect(c.refreshSecret).toBeUndefined();
    });
  });

  describe('OTP dev mode — the backdoor', () => {
    it('is off by default', () => {
      clear('OTP_DEV_MODE');

      expect(new AuthConfig().otpDevMode).toBe(false);
    });

    it('is on when explicitly enabled outside production', () => {
      process.env.OTP_DEV_MODE = 'true';
      process.env.NODE_ENV = 'development';

      expect(new AuthConfig().otpDevMode).toBe(true);
    });

    /**
     * The condition that matters: a production deploy inheriting
     * OTP_DEV_MODE=true from a copied env file must still refuse. The
     * universal "0000" code and logged OTPs are unreachable on a real deploy.
     */
    it('is OFF in production even when explicitly enabled', () => {
      process.env.OTP_DEV_MODE = 'true';
      process.env.NODE_ENV = 'production';

      expect(new AuthConfig().otpDevMode).toBe(false);
    });

    it('treats any value other than the exact string "true" as off', () => {
      process.env.NODE_ENV = 'development';
      for (const v of ['TRUE', '1', 'yes', 'on', '']) {
        process.env.OTP_DEV_MODE = v;
        expect(new AuthConfig().otpDevMode).toBe(false);
      }
    });
  });

  describe('other limits', () => {
    it('defaults OTP ttl and attempts', () => {
      clear('OTP_TTL_SECONDS', 'OTP_MAX_ATTEMPTS');
      const c = new AuthConfig();

      expect(c.otpTtlSeconds).toBe(300);
      expect(c.otpMaxAttempts).toBe(5);
    });

    it('defaults concurrent sessions to two', () => {
      clear('MAX_CONCURRENT_SESSIONS_DEFAULT');

      expect(new AuthConfig().maxConcurrentSessions).toBe(2);
    });

    it('reads values live, so a test that sets an env var sees it', () => {
      const c = new AuthConfig();
      process.env.MAX_CONCURRENT_SESSIONS_DEFAULT = '7';

      expect(c.maxConcurrentSessions).toBe(7);
    });
  });
});
