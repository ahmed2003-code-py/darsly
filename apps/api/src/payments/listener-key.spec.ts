import { ExecutionContext, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ListenerKeyGuard } from './listener-key.guard';

/**
 * The listener key on the transfer-ingestion endpoint.
 *
 * This is the one unauthenticated route that can cause money to be credited, so
 * what it does with a wrong key matters: it must refuse, in constant time, and
 * it must refuse with an answer rather than a crash.
 *
 * The comparison used to check string lengths before handing both values to
 * timingSafeEqual, which measures bytes. A header with the same number of
 * characters but a different UTF-8 byte length slipped past the guard and made
 * timingSafeEqual throw RangeError — HTTP 500 where the answer is 401. It
 * failed closed, so nothing was credited, but any anonymous caller could fill
 * the error monitoring of a payments endpoint on demand.
 *
 * The check now lives in a guard rather than in the handler. That is the
 * behaviour these tests moved to assert: guards run before the global
 * ValidationPipe, so an unauthenticated caller is refused *before* the server
 * parses their body and describes its own schema back to them.
 */
describe('the transfer-ingestion listener key', () => {
  const KEY = 'a-listener-key-of-known-length!!';
  let guard: ListenerKeyGuard;

  /** Just enough ExecutionContext for a guard that only reads one header. */
  const ctx = (key?: string) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ headers: key === undefined ? {} : { 'x-listener-key': key } }) }),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    process.env.PAYMENT_LISTENER_KEY = KEY;
    guard = new ListenerKeyGuard();
    jest.spyOn(guard['logger'], 'warn').mockImplementation(() => undefined);
  });
  afterAll(() => {
    delete process.env.PAYMENT_LISTENER_KEY;
  });

  it('accepts the right key', () => {
    expect(guard.canActivate(ctx(KEY))).toBe(true);
  });

  it('refuses a wrong key of the same length', () => {
    expect(() => guard.canActivate(ctx('b-listener-key-of-known-length!!'))).toThrow(UnauthorizedException);
  });

  it('refuses a missing key', () => {
    expect(() => guard.canActivate(ctx())).toThrow(UnauthorizedException);
  });

  it('refuses a key of a different length', () => {
    expect(() => guard.canActivate(ctx('short'))).toThrow(UnauthorizedException);
  });

  /**
   * The regression. 31 characters plus one two-byte character is 32 characters
   * and 33 bytes: the old string-length guard let it through to a comparison
   * that cannot accept it.
   */
  it('refuses a key whose bytes differ from its characters, without crashing', () => {
    const sameCharsMoreBytes = 'a-listener-key-of-known-length!' + 'é';
    expect(sameCharsMoreBytes.length).toBe(KEY.length); // same characters
    expect(Buffer.byteLength(sameCharsMoreBytes)).not.toBe(Buffer.byteLength(KEY)); // different bytes
    expect(() => guard.canActivate(ctx(sameCharsMoreBytes))).toThrow(UnauthorizedException);
  });

  /**
   * Production does not set this variable, so the legacy route answers 503 to
   * everyone. Unset must mean "closed", never "open".
   */
  it('refuses everything when no key is configured, rather than letting it through', () => {
    delete process.env.PAYMENT_LISTENER_KEY;
    expect(() => guard.canActivate(ctx('anything'))).toThrow(ServiceUnavailableException);
  });

  it('refuses a repeated header rather than trusting the array form', () => {
    const arrayHeader = {
      switchToHttp: () => ({ getRequest: () => ({ headers: { 'x-listener-key': [KEY, 'other'] } }) }),
    } as unknown as ExecutionContext;

    expect(() => guard.canActivate(arrayHeader)).toThrow(UnauthorizedException);
  });

  /**
   * The route is meant to be retired. Knowing it is safe to delete means
   * seeing nothing arrive on it, which means every acceptance has to be
   * recorded.
   */
  it('logs every acceptance, so the legacy path can be evidenced as unused', () => {
    const warn = jest.spyOn(guard['logger'], 'warn');

    guard.canActivate(ctx(KEY));

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('/device/sms-events'));
  });
});
