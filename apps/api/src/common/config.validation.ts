/**
 * Fail-fast configuration validation. Runs once at boot (see main.ts) so a
 * misconfigured production deploy crashes loudly instead of silently running
 * with forgeable secrets or a dev-only account-recovery backdoor.
 *
 * Strict checks only run when NODE_ENV=production (the deploy start script
 * exports it). In development the shipped placeholder secrets are allowed with
 * a warning so `npm run dev` keeps working out of the box.
 */

const MIN_SECRET_BYTES = 32;

// Values shipped in .env.example — must never reach production.
const KNOWN_PLACEHOLDERS = new Set([
  'change-me-access-secret-min-32-chars!!',
  'change-me-refresh-secret-min-32-chars',
  'dev-insecure-video-secret',
  'change-me',
  '',
]);

function isWeak(secret: string | undefined): string | null {
  if (!secret) return 'missing';
  if (KNOWN_PLACEHOLDERS.has(secret)) return 'is a known placeholder value';
  if (Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) {
    return `is too short (< ${MIN_SECRET_BYTES} bytes)`;
  }
  return null;
}

/**
 * @returns nothing; throws with an aggregated message on fatal misconfig in prod.
 */
export function validateConfig(env: NodeJS.ProcessEnv = process.env): void {
  const isProd = env.NODE_ENV === 'production';
  const errors: string[] = [];
  const warnings: string[] = [];

  const record = (name: string, problem: string | null) => {
    if (!problem) return;
    (isProd ? errors : warnings).push(`${name} ${problem}`);
  };

  record('JWT_ACCESS_SECRET', isWeak(env.JWT_ACCESS_SECRET));
  record('JWT_REFRESH_SECRET', isWeak(env.JWT_REFRESH_SECRET));
  // Video signing falls back to JWT_ACCESS_SECRET; only fatal if BOTH are weak.
  if (isWeak(env.VIDEO_SIGNING_SECRET) && isWeak(env.JWT_ACCESS_SECRET)) {
    record('VIDEO_SIGNING_SECRET (and JWT_ACCESS_SECRET fallback)', 'must be a strong secret');
  }

  if (env.JWT_ACCESS_SECRET && env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
    record('JWT_REFRESH_SECRET', 'must differ from JWT_ACCESS_SECRET');
  }

  // The dev-only password-reset backdoor (returns the reset token over HTTP)
  // must never be enabled in production.
  if (isProd && env.OTP_DEV_MODE === 'true') {
    errors.push('OTP_DEV_MODE=true leaks password-reset tokens — must be false/unset in production');
  }

  if (isProd && (!env.ALLOWED_ORIGINS || env.ALLOWED_ORIGINS.includes('localhost'))) {
    warnings.push('ALLOWED_ORIGINS is unset or points at localhost — CORS will reject your real domain');
  }

  if (isProd && !env.PAYMENT_LISTENER_KEY) {
    warnings.push('PAYMENT_LISTENER_KEY unset — automatic payment verification endpoint will reject all events');
  }

  for (const w of warnings) {
    // eslint-disable-next-line no-console
    console.warn(`⚠ config: ${w}`);
  }
  if (errors.length) {
    throw new Error(
      'Fatal configuration errors (refusing to start):\n' + errors.map((e) => `  • ${e}`).join('\n'),
    );
  }
}
