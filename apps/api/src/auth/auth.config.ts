import { Injectable } from '@nestjs/common';

function seconds(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Every environment value the auth and token paths depend on, in one place.
 *
 * `@nestjs/config` is registered globally but `ConfigService` is never
 * injected anywhere: all ~138 env reads are bare `process.env`. Two per-feature
 * config classes already exist (`academy-site.config.ts`, `xpay.config.ts`) and
 * they are the better pattern — typed, discoverable, and defaulted once. This
 * extends it to the cluster where being wrong matters most.
 *
 * `JWT_ACCESS_SECRET` alone was read in eight files. A typo in any of them does
 * not fail at boot; it yields `undefined`, and what happens next is a library's
 * decision rather than ours. `config.validation.ts` already refuses to start on
 * a missing or weak secret — this makes the *reading* of it as centralised as
 * the validating of it already was.
 *
 * Read through getters rather than captured at construction so a test can set
 * an env var and see it, which is how the existing specs are written.
 */
@Injectable()
export class AuthConfig {
  /** Signs and verifies access tokens. Boot fails without it — see config.validation.ts. */
  get accessSecret(): string | undefined {
    return process.env.JWT_ACCESS_SECRET;
  }

  /** Deliberately distinct from the access secret; boot fails if they match. */
  get refreshSecret(): string | undefined {
    return process.env.JWT_REFRESH_SECRET;
  }

  /** 15 minutes. Short because revocation is checked per request anyway. */
  get accessTtlSeconds(): number {
    return seconds(process.env.JWT_ACCESS_TTL, 900);
  }

  /** 30 days. */
  get refreshTtlSeconds(): number {
    return seconds(process.env.JWT_REFRESH_TTL, 2_592_000);
  }

  /**
   * The Android SMS listener's own TTLs, falling back to the web ones.
   *
   * A device is unattended hardware on somebody's windowsill, so it is allowed
   * a different lifetime from a person's browser — but it has always fallen
   * back rather than requiring separate configuration.
   */
  get deviceAccessTtlSeconds(): number {
    return seconds(process.env.DEVICE_JWT_ACCESS_TTL, this.accessTtlSeconds);
  }

  get deviceRefreshTtlSeconds(): number {
    return seconds(process.env.DEVICE_JWT_REFRESH_TTL, this.refreshTtlSeconds);
  }

  /** How many devices one account may be signed in on at once. */
  get maxConcurrentSessions(): number {
    return seconds(process.env.MAX_CONCURRENT_SESSIONS_DEFAULT, 2);
  }

  get otpTtlSeconds(): number {
    return seconds(process.env.OTP_TTL_SECONDS, 300);
  }

  get otpMaxAttempts(): number {
    return seconds(process.env.OTP_MAX_ATTEMPTS, 5);
  }

  /**
   * The universal `0000` code and console-logged OTPs.
   *
   * Two conditions, and the second is not redundant: a production deploy that
   * inherits `OTP_DEV_MODE=true` from a copied env file must still refuse.
   * Kept exactly as it was written at the original call site.
   */
  get otpDevMode(): boolean {
    return process.env.OTP_DEV_MODE === 'true' && process.env.NODE_ENV !== 'production';
  }

  get isProduction(): boolean {
    return process.env.NODE_ENV === 'production';
  }
}
