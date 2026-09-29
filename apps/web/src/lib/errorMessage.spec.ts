/**
 * The web half of the error contract (docs/ERRORS.md): what a reader is told
 * for each kind of failure, in real Arabic copy, and that nothing is said
 * twice or in the API's own English.
 */
jest.mock('../i18n', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const i18next = require('i18next');
  const inst = i18next.createInstance();
  inst.init({
    lng: 'ar',
    initImmediate: false,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    resources: { ar: { translation: require('../i18n/ar.json') } },
    interpolation: { escapeValue: false },
  });
  return { __esModule: true, default: inst };
});

import ar from '../i18n/ar.json';
import { fieldErrors, referenceOf, resolveError, splitFormError } from './errorMessage';
import { claimError } from './errorPresentation';
import { authErrorText } from './authError';

/** What axios hands a caller for an HTTP answer. */
const http = (status: number, data: Record<string, unknown> = {}, headers = {}) => ({
  isAxiosError: true,
  message: `Request failed with status code ${status}`,
  response: { status, data, headers },
});

describe('resolveError', () => {
  it('turns the guardian conflict into its real cause, not the generic 409 sentence', () => {
    const r = resolveError(
      http(409, {
        code: 'PHONE_IN_USE',
        message: 'This phone number already belongs to another Darsly account',
        field: 'phone',
        retryable: false,
      }),
    );
    expect(r.message).toBe(ar.err.ePhoneInUse);
    expect(r.message).not.toBe(ar.err.status.conflict);
    expect(r).toMatchObject({ kind: 'refused', retryable: false, field: 'phone', generic: false });
  });

  it('never shows the English message, even for an unknown code', () => {
    const r = resolveError(http(409, { code: 'SOMETHING_NEW', message: 'Some English sentence' }));
    expect(r.message).toBe(ar.err.status.conflict);
    expect(r.message).not.toContain('English');
  });

  it('answers a generic code with the per-status sentence', () => {
    expect(resolveError(http(403, { code: 'FORBIDDEN', message: 'Forbidden' })).message).toBe(
      ar.err.status.forbidden,
    );
    expect(resolveError(http(404, { code: 'NOT_FOUND', message: 'Not found' })).kind).toBe(
      'notFound',
    );
  });

  it('puts the given numbers into the sentence', () => {
    const r = resolveError(
      http(400, { code: 'ATTACHMENT_TOO_LARGE', message: 'x', params: { max: 10, mb: 14 } }),
    );
    expect(r.message).toContain('14');
    expect(r.message).toContain('10');
  });

  it('gives an unexpected failure a short reference, and nothing else does', () => {
    const crash = resolveError(
      http(500, {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        requestId: 'ab12cd34-ef56-7890',
      }),
    );
    expect(crash).toMatchObject({ kind: 'server', retryable: true });
    expect(crash.message).toContain('AB12CD34');
    const refusal = resolveError(http(409, { code: 'PHONE_IN_USE', requestId: 'ab12cd34-ef56' }));
    expect(refusal.message).not.toContain('AB12CD34');
  });

  it('reads the request id from the header when the body lacks it', () => {
    const r = resolveError(http(502, {}, { 'x-request-id': 'zz99yy88xx' }));
    expect(r.message).toContain('ZZ99YY88');
    expect(referenceOf('abc-def')).toBe('ABCDEF');
  });

  it('says how long to wait on a 429', () => {
    const s = resolveError(http(429, { code: 'RATE_LIMITED', retryAfterSeconds: 42 }));
    expect(s).toMatchObject({ kind: 'rateLimited', retryable: true, retryAfterSeconds: 42 });
    expect(s.message).toContain('42');
    const m = resolveError(http(429, { code: 'RATE_LIMITED' }, { 'retry-after': '300' }));
    expect(m.message).toContain('5');
    expect(m.message).not.toBe(ar.err.status.server);
  });

  it('tells a lost connection, a timeout and a cancellation apart', () => {
    const network = resolveError({
      isAxiosError: true,
      code: 'ERR_NETWORK',
      message: 'Network Error',
    });
    expect(network).toMatchObject({ kind: 'network', retryable: true, message: ar.err.network });
    const timeout = resolveError({ isAxiosError: true, code: 'ECONNABORTED', message: 'timeout' });
    expect(timeout).toMatchObject({ kind: 'timeout', message: ar.err.timeout });
    const canceled = resolveError({
      isAxiosError: true,
      code: 'ERR_CANCELED',
      name: 'CanceledError',
    });
    expect(canceled).toMatchObject({ kind: 'canceled', message: '' });
  });

  it('does not blame the network for a bug in our own code', () => {
    const r = resolveError(new TypeError("Cannot read properties of undefined (reading 'id')"));
    expect(r.kind).toBe('client');
    expect(r.message).toBe(ar.err.unknown);
    expect(r.message).not.toContain('Cannot read');
  });

  it('keeps Arabic copy the API wrote for a person', () => {
    expect(resolveError(http(400, { message: 'الرابط مستخدم بالفعل' })).message).toBe(
      'الرابط مستخدم بالفعل',
    );
  });
});

describe('field errors', () => {
  const invalid = http(400, {
    code: 'VALIDATION_FAILED',
    message: 'Invalid input',
    fields: [
      { field: 'phone', code: 'INVALID_PHONE' },
      { field: 'name', code: 'TOO_SHORT', params: { min: 2 } },
    ],
  });

  it('says each field in its own words', () => {
    const f = fieldErrors(invalid);
    expect(f.phone.message).toBe(ar.err.field.INVALID_PHONE);
    expect(f.name.message).toContain('2');
    expect(resolveError(invalid).kind).toBe('validation');
  });

  it('places a single-field business refusal under its field', () => {
    const f = fieldErrors(http(409, { code: 'PHONE_IN_USE', field: 'phone' }));
    expect(f.phone.message).toBe(ar.err.ePhoneInUse);
  });

  it('leaves nothing for the form note when every complaint sits under a field', () => {
    expect(splitFormError(invalid, ['phone', 'name'])).toEqual({
      fields: { phone: ar.err.field.INVALID_PHONE, name: expect.any(String) },
      rest: null,
    });
  });

  it('keeps the form note when a complaint has no field on this form', () => {
    const split = splitFormError(invalid, ['phone']);
    expect(Object.keys(split.fields)).toEqual(['phone']);
    expect(split.rest).toBeTruthy();
  });

  it('has a form note for a refusal that belongs to no field', () => {
    const split = splitFormError(http(409, { code: 'GUARDIAN_ALREADY_LINKED' }), ['phone']);
    expect(split.rest).toBe(ar.err.eGuardianAlreadyLinked);
  });
});

describe('auth screens', () => {
  const t = ((k: string) => {
    const v = k.split('.').reduce((o: any, p) => o?.[p], ar);
    return typeof v === 'string' ? v : k;
  }) as never;

  it('says "wrong details" for bad credentials, never "session expired"', () => {
    const text = authErrorText(
      http(401, { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' }),
      t,
    );
    expect(text).toBe(ar.auth.err.invalidCredentials);
  });

  it('no longer prints the raw server sentence', () => {
    const text = authErrorText(
      http(400, { code: 'BAD_REQUEST', message: 'Some internal English' }),
      t,
    );
    expect(text).not.toContain('English');
  });
});

describe('one error, said once', () => {
  beforeAll(() => {
    (globalThis as any).window = globalThis;
  });

  async function failAndWait(claim: boolean) {
    jest.useFakeTimers();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { queryClient } = require('./queryClient');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useToastStore } = require('./toast');
    useToastStore.setState({ toasts: [] });
    const err = http(409, { code: 'PHONE_IN_USE', field: 'phone' });
    queryClient.getMutationCache().config.onError(err, undefined, undefined, { meta: {} });
    if (claim) claimError(err); // what <ErrorNote> does while rendering
    jest.advanceTimersByTime(1000);
    jest.useRealTimers();
    return useToastStore.getState().toasts as { message: string }[];
  }

  it('toasts a failure nothing on screen reports', async () => {
    const toasts = await failAndWait(false);
    expect(toasts.map((x) => x.message)).toEqual([ar.err.ePhoneInUse]);
  });

  it('stays quiet when the form already shows it inline', async () => {
    expect(await failAndWait(true)).toEqual([]);
  });
});
