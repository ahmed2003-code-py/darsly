import { UnauthorizedException, ServiceUnavailableException } from '@nestjs/common';
import { PaymentEventsController } from './payment-events.controller';

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
 */
describe('the transfer-ingestion listener key', () => {
  const KEY = 'a-listener-key-of-known-length!!';
  const matching: any = { ingest: jest.fn().mockResolvedValue({ status: 'UNMATCHED' }) };
  const body: any = { provider: 'VODAFONE_CASH', amountCents: 1000 };
  let controller: PaymentEventsController;

  beforeEach(() => {
    matching.ingest.mockClear();
    process.env.PAYMENT_LISTENER_KEY = KEY;
    controller = new PaymentEventsController(matching);
  });
  afterAll(() => { delete process.env.PAYMENT_LISTENER_KEY; });

  it('accepts the right key', async () => {
    await controller.ingest(KEY, body);
    expect(matching.ingest).toHaveBeenCalledWith(body);
  });

  it('refuses a wrong key of the same length', () => {
    expect(() => controller.ingest('b-listener-key-of-known-length!!', body)).toThrow(UnauthorizedException);
    expect(matching.ingest).not.toHaveBeenCalled();
  });

  it('refuses a missing key', () => {
    expect(() => controller.ingest(undefined, body)).toThrow(UnauthorizedException);
  });

  it('refuses a key of a different length', () => {
    expect(() => controller.ingest('short', body)).toThrow(UnauthorizedException);
  });

  /**
   * The regression. 31 characters plus one two-byte character is 32 characters
   * and 33 bytes: the old string-length guard let it through to a comparison
   * that cannot accept it.
   */
  it('refuses a key whose bytes differ from its characters, without crashing', () => {
    const sameCharsMoreBytes = 'a-listener-key-of-known-length!' + 'é';
    expect(sameCharsMoreBytes.length).toBe(KEY.length);      // same characters
    expect(Buffer.byteLength(sameCharsMoreBytes)).not.toBe(Buffer.byteLength(KEY)); // different bytes
    expect(() => controller.ingest(sameCharsMoreBytes, body)).toThrow(UnauthorizedException);
    expect(matching.ingest).not.toHaveBeenCalled();
  });

  it('refuses everything when no key is configured, rather than letting it through', () => {
    delete process.env.PAYMENT_LISTENER_KEY;
    expect(() => controller.ingest('anything', body)).toThrow(ServiceUnavailableException);
    expect(matching.ingest).not.toHaveBeenCalled();
  });
});
