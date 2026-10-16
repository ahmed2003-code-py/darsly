import {
  classifyHttpFailure,
  classifyProviderError,
  providerCodeFromBody,
  providerFailureCode,
  RETRYABLE_PROVIDER_FAILURES,
} from './provider-failure';

/**
 * Every way a provider says no, and what the callers do with it: an account
 * problem is never retried, a busy or failing provider is.
 */
describe('classifying a provider failure', () => {
  const sdk = (status: number, code?: string, headers?: Record<string, string>) =>
    Object.assign(new Error('provider said no'), {
      status,
      error: code ? { code } : undefined,
      headers,
    });

  it.each([
    ['invalid key', sdk(401, 'invalid_api_key'), 'ACCOUNT'],
    ['revoked key, no code', sdk(401), 'ACCOUNT'],
    ['forbidden', sdk(403), 'ACCOUNT'],
    ['no credits (429 insufficient_quota)', sdk(429, 'insufficient_quota'), 'ACCOUNT'],
    ['billing hard limit', sdk(400, 'billing_hard_limit_reached'), 'ACCOUNT'],
    ['billing not active', sdk(429, 'billing_not_active'), 'ACCOUNT'],
    ['payment required', sdk(402), 'ACCOUNT'],
    ['rate limit', sdk(429, 'rate_limit_exceeded'), 'RATE_LIMIT'],
    ['request timeout', sdk(408), 'TIMEOUT'],
    ['server error', sdk(500), 'TRANSIENT'],
    ['overloaded', sdk(503), 'TRANSIENT'],
    ['malformed request', sdk(400, 'invalid_request_error'), 'INVALID_REQUEST'],
    ['context too long', sdk(400, 'context_length_exceeded'), 'INVALID_REQUEST'],
    [
      'SDK timeout',
      Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }),
      'TIMEOUT',
    ],
    ['aborted', Object.assign(new Error('aborted'), { name: 'AbortError' }), 'TIMEOUT'],
    [
      'connection refused',
      Object.assign(new Error('connect ECONNREFUSED'), { name: 'APIConnectionError' }),
      'TRANSIENT',
    ],
    ['DNS', Object.assign(new Error('getaddrinfo ENOTFOUND api.openai.com'), {}), 'TRANSIENT'],
    ['something else', new Error('boom'), 'UNKNOWN'],
  ])('%s → %s', (_label, error, kind) => {
    expect(classifyProviderError(error).kind).toBe(kind);
  });

  it('a rate limit carries the wait the provider asked for', () => {
    expect(classifyProviderError(sdk(429, undefined, { 'retry-after': '7' }))).toMatchObject({
      kind: 'RATE_LIMIT',
      retryAfterMs: 7000,
    });
    const viaGet = Object.assign(sdk(429), { headers: { get: () => '3' } });
    expect(classifyProviderError(viaGet).retryAfterMs).toBe(3000);
  });

  it('reads the code out of a raw body, JSON or a proxy page', () => {
    expect(providerCodeFromBody('{"error":{"code":"insufficient_quota"}}')).toBe(
      'insufficient_quota',
    );
    expect(providerCodeFromBody('{"error":{"type":"server_error"}}')).toBe('server_error');
    expect(providerCodeFromBody('<html>insufficient_quota</html>')).toBe('insufficient_quota');
    expect(providerCodeFromBody('<html>bad gateway</html>')).toBeNull();
    expect(classifyHttpFailure(429, providerCodeFromBody('<b>insufficient_quota</b>')).kind).toBe(
      'ACCOUNT',
    );
  });

  it('only a busy or failing provider is tried again', () => {
    expect(RETRYABLE_PROVIDER_FAILURES).toEqual(
      expect.arrayContaining(['RATE_LIMIT', 'TIMEOUT', 'TRANSIENT', 'UNKNOWN']),
    );
    expect(RETRYABLE_PROVIDER_FAILURES).not.toContain('ACCOUNT');
    expect(RETRYABLE_PROVIDER_FAILURES).not.toContain('INVALID_REQUEST');
  });

  it('each kind has a stable code a page can show — never the provider text', () => {
    expect(
      (
        ['ACCOUNT', 'RATE_LIMIT', 'TIMEOUT', 'TRANSIENT', 'INVALID_REQUEST', 'UNKNOWN'] as const
      ).map(providerFailureCode),
    ).toEqual([
      'AI_PROVIDER_UNAVAILABLE',
      'AI_PROVIDER_BUSY',
      'AI_PROVIDER_TIMEOUT',
      'AI_PROVIDER_ERROR',
      'AI_REQUEST_REFUSED',
      'AI_FAILED',
    ]);
  });
});
