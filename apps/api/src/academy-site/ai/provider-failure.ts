/**
 * Why a call to an AI provider failed — the one classification every caller
 * shares, so "trying again" means the same thing everywhere.
 *
 * It grew out of the live transcription's classifier (lesson-transcription.ts,
 * 2026-09-28), which learned the hard way: OpenAI answers an account with no
 * credits with HTTP 429 `insufficient_quota`, and every 429 had been treated
 * as a rate limit — so the queue waited 1, 5 and 15 minutes for a billing
 * problem no wait could fix. The shared AI client treated it the same way for
 * every other feature (site generation, summaries, grading, paper import,
 * receipt reading). Now:
 *
 *  ACCOUNT          the provider refuses this account: no credits, billing
 *                   off, bad or revoked key. Nothing will succeed until a
 *                   person fixes it — terminal, never retried.
 *  RATE_LIMIT       a true 429: too many requests right now — wait, then again.
 *  TIMEOUT          no answer in time — again.
 *  TRANSIENT        the provider failed (5xx) or the network did — again.
 *  INVALID_REQUEST  the request itself is refused (4xx): the same request
 *                   will be refused again — terminal.
 *  UNKNOWN          anything else — retried, as before.
 */
export type ProviderFailureKind =
  'ACCOUNT' | 'RATE_LIMIT' | 'TIMEOUT' | 'TRANSIENT' | 'INVALID_REQUEST' | 'UNKNOWN';

export const RETRYABLE_PROVIDER_FAILURES: readonly ProviderFailureKind[] = [
  'RATE_LIMIT',
  'TIMEOUT',
  'TRANSIENT',
  'UNKNOWN',
];

/** Provider error codes that mean the account itself cannot be served. */
export const ACCOUNT_CODES = new Set([
  'insufficient_quota',
  'billing_hard_limit_reached',
  'billing_not_active',
  'access_terminated',
  'account_deactivated',
  'invalid_api_key',
  'invalid_organization',
]);

export interface ProviderFailure {
  kind: ProviderFailureKind;
  status: number | null;
  /** The provider's own code (`insufficient_quota`), when it gave one. Never a key or a payload. */
  code: string | null;
  /** How long the provider asked us to wait (Retry-After), for a RATE_LIMIT. */
  retryAfterMs?: number;
}

/** From an HTTP answer: its status, the provider's error code, and Retry-After. */
export function classifyHttpFailure(
  status: number,
  code: string | null | undefined,
  retryAfter?: string | number | null,
): ProviderFailure {
  const c = code ? String(code).slice(0, 60) : null;
  if (status === 401 || status === 403 || (c && ACCOUNT_CODES.has(c))) {
    return { kind: 'ACCOUNT', status, code: c };
  }
  if (status === 429) {
    const secs = Number(retryAfter);
    return {
      kind: 'RATE_LIMIT',
      status,
      code: c,
      ...(Number.isFinite(secs) && secs > 0 ? { retryAfterMs: secs * 1000 } : {}),
    };
  }
  if (status === 408) return { kind: 'TIMEOUT', status, code: c };
  if (status >= 500) return { kind: 'TRANSIENT', status, code: c };
  if (status >= 400) return { kind: 'INVALID_REQUEST', status, code: c };
  return { kind: 'UNKNOWN', status, code: c };
}

/** The provider's error code out of a JSON (or not) error body. */
export function providerCodeFromBody(body: string): string | null {
  try {
    const e = (JSON.parse(body) as { error?: { code?: string; type?: string } }).error;
    return e?.code || e?.type ? String(e.code || e.type) : null;
  } catch {
    // Not JSON (a proxy's page): look for the one code that matters most.
    return /insufficient_quota/.test(body) ? 'insufficient_quota' : null;
  }
}

/**
 * Any error an SDK or fetch threw → its kind. Reads the OpenAI SDK's error
 * shape (status, error.code / code / type, headers) and the names of its
 * connection errors; an error without a status is a network failure or a
 * timeout.
 */
export function classifyProviderError(e: unknown): ProviderFailure {
  const err = e as {
    status?: number;
    response?: { status?: number };
    code?: string;
    type?: string;
    error?: { code?: string; type?: string };
    headers?: Record<string, string> | { get?: (k: string) => string | null };
    name?: string;
    message?: string;
  } | null;
  const status = err?.status ?? err?.response?.status;
  const code = err?.error?.code ?? err?.code ?? err?.error?.type ?? err?.type ?? null;
  if (typeof status === 'number') {
    const h = err?.headers as any;
    const retryAfter = typeof h?.get === 'function' ? h.get('retry-after') : h?.['retry-after'];
    return classifyHttpFailure(status, code, retryAfter);
  }
  const name = String(err?.name ?? '');
  if (/timeout|abort/i.test(name) || /timed? ?out/i.test(String(err?.message ?? ''))) {
    return { kind: 'TIMEOUT', status: null, code: null };
  }
  if (
    /connection|network|fetch|socket|ECONN|ENOTFOUND|EAI_AGAIN/i.test(
      `${name} ${err?.message ?? ''} ${code ?? ''}`,
    )
  ) {
    return { kind: 'TRANSIENT', status: null, code: null };
  }
  return { kind: 'UNKNOWN', status: null, code: null };
}

/** The stable, user-safe code a page shows for a provider failure (never the provider's text). */
export function providerFailureCode(kind: ProviderFailureKind): string {
  switch (kind) {
    case 'ACCOUNT':
      return 'AI_PROVIDER_UNAVAILABLE';
    case 'RATE_LIMIT':
      return 'AI_PROVIDER_BUSY';
    case 'TIMEOUT':
      return 'AI_PROVIDER_TIMEOUT';
    case 'TRANSIENT':
      return 'AI_PROVIDER_ERROR';
    case 'INVALID_REQUEST':
      return 'AI_REQUEST_REFUSED';
    default:
      return 'AI_FAILED';
  }
}
