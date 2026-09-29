/**
 * Live commerce vocabulary shared by the API and the web — so a form and the
 * server read "149.50" as the same number of piasters, and a refund summary on
 * a card says the same thing the server will do.
 *
 * Nothing here prices anything: the price a student pays is always computed on
 * the server (apps/api/src/commerce/pricing.ts) from server data.
 */

export type LiveAccessMode = 'FREE' | 'PAID';
export type LiveRefundPolicy = 'FLEXIBLE' | 'STANDARD' | 'STRICT' | 'NO_REFUND';
export type LiveReplayPolicy = 'NONE' | 'INCLUDED_FOREVER' | 'INCLUDED_DAYS';

export const LIVE_REFUND_POLICIES: LiveRefundPolicy[] = [
  'FLEXIBLE',
  'STANDARD',
  'STRICT',
  'NO_REFUND',
];
export const LIVE_REPLAY_POLICIES: LiveReplayPolicy[] = [
  'NONE',
  'INCLUDED_FOREVER',
  'INCLUDED_DAYS',
];

/**
 * How long before the start a student's own cancellation is still refunded in
 * full, per policy. null = never (NO_REFUND). The server decides with its own
 * clock; this is the same table, so the words on a card cannot drift from it.
 */
export const LIVE_REFUND_WINDOW_HOURS: Record<LiveRefundPolicy, number | null> = {
  FLEXIBLE: 1,
  STANDARD: 24,
  STRICT: 7 * 24,
  NO_REFUND: null,
};

/** Bounds on a PAID seat's price, in piasters: 1 EGP to 1,000,000 EGP. */
export const LIVE_PRICE_MIN_CENTS = 100;
export const LIVE_PRICE_MAX_CENTS = 100_000_000;
export const LIVE_REPLAY_DAYS_MAX = 3650;

/**
 * "149.50" → 14950. Strict: digits, an optional point and at most two
 * decimals — no sign, no exponent, no separators, and no float in between.
 * Arabic-Indic digits are read as digits. null for anything else.
 */
export function parseMoneyToCents(input: unknown): number | null {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  const s = String(input)
    .trim()
    .replace(/[٠-٩۰-۹]/g, (c) => String(c.charCodeAt(0) & 0xf))
    // The Arabic decimal separator, typed on an Arabic keyboard.
    .replace(/٫/g, '.');
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** 14950 → "149.50"; 15000 → "150". Integer arithmetic only. */
export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) return '';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return frac ? `${sign}${whole}.${String(frac).padStart(2, '0')}` : `${sign}${whole}`;
}
