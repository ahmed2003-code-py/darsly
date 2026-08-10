import { createHmac } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { ManualPaymentsService } from '../manual-payments.service';
import { XPayClient } from './xpay.client';
import { XPayConfig } from './xpay.config';
import { XPayService } from './xpay.service';

/**
 * The card-payment route.
 *
 * Two things carry real risk here and everything else is plumbing. The webhook
 * endpoint is public — it has to be, XPay has no session with us — so the
 * signature is the only thing between a stranger and a free course. And
 * settlement moves money, so it must be impossible to do twice.
 */

const SECRET = 'whsec_test_secret';

function build(over: {
  payment?: Record<string, unknown> | null;
  session?: Record<string, unknown>;
  webhookSecret?: string;
  createFails?: boolean;
  createReturnsNoUrl?: boolean;
} = {}) {
  const prisma = {
    payment: {
      findUnique: jest.fn().mockResolvedValue(
        over.payment === undefined
          ? { id: 'pay_1', gateway: 'xpay', status: 'PENDING', gatewayRef: 'cs_1' }
          : over.payment,
      ),
      update: jest.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaService;

  const client = {
    getCheckoutSession: jest.fn().mockResolvedValue(over.session ?? { id: 'cs_1', status: 'paid' }),
    createCheckoutSession: jest.fn(async () => {
      if (over.createFails) throw new Error('provider unreachable');
      return over.createReturnsNoUrl ? { id: 'cs_1' } : { id: 'cs_1', url: 'https://pay.test/cs_1' };
    }),
  } as unknown as XPayClient;

  const config = new XPayConfig();
  Object.defineProperty(config, 'webhookSecret', {
    value: over.webhookSecret === undefined ? SECRET : over.webhookSecret,
  });

  const payments = { systemVerify: jest.fn().mockResolvedValue({}) } as unknown as ManualPaymentsService;
  return { service: new XPayService(prisma, client, config, payments), prisma, client, payments };
}

const sign = (body: string, secret = SECRET) =>
  createHmac('sha256', secret).update(body).digest('hex');

describe('a webhook is believed only when it proves itself', () => {
  const body = JSON.stringify({ type: 'checkout_session.completed' });

  it('accepts a correctly signed body', () => {
    expect(build().service.verifySignature(body, sign(body))).toBe(true);
  });

  it('rejects a body signed with the wrong secret', () => {
    expect(build().service.verifySignature(body, sign(body, 'not-the-secret'))).toBe(false);
  });

  it('rejects a signature for a different body', () => {
    // The whole point: a valid signature for some other event must not admit
    // this one. This is the forgery that grants a free course.
    expect(build().service.verifySignature(body, sign('{"type":"anything.else"}'))).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(build().service.verifySignature(body, undefined)).toBe(false);
    expect(build().service.verifySignature(body, '')).toBe(false);
  });

  it('rejects everything when no signing secret is configured', () => {
    // Fails closed. An unverified webhook is an unauthenticated request that
    // grants access and moves money, so an unconfigured integration accepts
    // nothing rather than accepting anything.
    const { service } = build({ webhookSecret: '' });
    expect(service.verifySignature(body, sign(body))).toBe(false);
    expect(service.verifySignature(body, 'anything')).toBe(false);
  });

  it('accepts the prefixed and multi-part forms providers send', () => {
    const { service } = build();
    expect(service.verifySignature(body, `sha256=${sign(body)}`)).toBe(true);
    expect(service.verifySignature(body, `t=123, v1=${sign(body)}`)).toBe(true);
  });

  it('is not fooled by a truncated signature', () => {
    expect(build().service.verifySignature(body, sign(body).slice(0, 20))).toBe(false);
  });
});

describe('settling a payment', () => {
  const event = (type: string, reference = 'pay_1') => ({ type, data: { object: { reference } } });

  it('settles through the same path a bank transfer uses', async () => {
    const { service, payments } = build();
    await expect(service.handleEvent(event('checkout_session.completed'))).resolves.toMatchObject({ settled: true });
    // Not its own ledger writes — the one method that activates the enrolment
    // and writes both sides of the entry in a single transaction.
    expect(payments.systemVerify).toHaveBeenCalledWith('pay_1');
  });

  it('re-reads the session from XPay before believing the event', async () => {
    const { service, client } = build();
    await service.handleEvent(event('payment.succeeded'));
    expect(client.getCheckoutSession).toHaveBeenCalledWith('cs_1');
  });

  it('refuses to settle when XPay says the session was never paid', async () => {
    const { service, payments } = build({ session: { id: 'cs_1', status: 'unpaid' } });
    await expect(service.handleEvent(event('checkout_session.completed'))).resolves.toMatchObject({
      handled: false,
      reason: 'not-paid-at-provider',
    });
    expect(payments.systemVerify).not.toHaveBeenCalled();
  });

  it('does nothing the second time a provider retries a delivery', async () => {
    const { service, payments } = build({
      payment: { id: 'pay_1', gateway: 'xpay', status: 'PAID', gatewayRef: 'cs_1' },
    });
    await expect(service.handleEvent(event('checkout_session.completed'))).resolves.toMatchObject({
      alreadySettled: true,
    });
    expect(payments.systemVerify).not.toHaveBeenCalled();
  });

  it('ignores an event about a payment we never started', async () => {
    const { service, payments } = build({ payment: null });
    await expect(service.handleEvent(event('checkout_session.completed'))).resolves.toMatchObject({
      reason: 'unknown-payment',
    });
    expect(payments.systemVerify).not.toHaveBeenCalled();
  });

  it('ignores an event about a payment that belongs to another gateway', async () => {
    const { service, payments } = build({
      payment: { id: 'pay_1', gateway: 'manual', status: 'PENDING' },
    });
    await service.handleEvent(event('checkout_session.completed'));
    expect(payments.systemVerify).not.toHaveBeenCalled();
  });

  it('ignores an event with no reference to anything', async () => {
    const { service } = build();
    await expect(service.handleEvent({ type: 'checkout_session.completed', data: {} })).resolves.toMatchObject({
      reason: 'no-reference',
    });
  });

  it('reads the reference out of metadata when it is not top level', async () => {
    const { service, payments } = build();
    await service.handleEvent({
      type: 'checkout_session.completed',
      data: { object: { metadata: { paymentId: 'pay_1' } } },
    });
    expect(payments.systemVerify).toHaveBeenCalledWith('pay_1');
  });

  it('marks a failed payment rejected without touching the ledger', async () => {
    const { service, prisma, payments } = build();
    await expect(service.handleEvent(event('payment.failed'))).resolves.toMatchObject({ failed: true });
    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REJECTED' }) }),
    );
    expect(payments.systemVerify).not.toHaveBeenCalled();
  });

  it('leaves an event type it does not understand alone', async () => {
    const { service, payments } = build();
    await expect(service.handleEvent(event('customer.updated'))).resolves.toMatchObject({ handled: false });
    expect(payments.systemVerify).not.toHaveBeenCalled();
  });
});

describe('configuration', () => {
  it('stays off until a secret key exists, so a missing key is never a live failure', () => {
    const config = new XPayConfig();
    Object.defineProperty(config, 'secretKey', { value: '' });
    process.env.XPAY_ENABLED = 'true';
    expect(config.enabled).toBe(false);
  });

  it('treats anything that is not a live key as test mode', () => {
    const config = new XPayConfig();
    Object.defineProperty(config, 'secretKey', { value: 'sk_test_abc' });
    expect(config.testMode).toBe(true);
    Object.defineProperty(config, 'secretKey', { value: 'sk_live_abc' });
    expect(config.testMode).toBe(false);
  });

  it('builds the auth header from a template, so a different scheme is an env change', () => {
    const config = new XPayConfig();
    Object.defineProperty(config, 'secretKey', { value: 'KEY' });
    Object.defineProperty(config, 'authFormat', { value: 'Token {key}' });
    expect(config.authorizationValue()).toBe('Token KEY');
  });
});


/**
 * A checkout that never reached a payment page.
 *
 * The payment row must exist before the provider is called — its id is the
 * reference XPay sends back — so a failed call would otherwise leave a pending
 * payment and a pending enrolment for a student who was never shown a payment
 * page, and a teacher looking at an approval request for money nobody asked for.
 */
describe('a failed checkout leaves nothing behind', () => {
  function buildStart(over: { createFails?: boolean; createReturnsNoUrl?: boolean; existing?: unknown } = {}) {
    const deleted: string[] = [];
    const tx = {
      payment: {
        create: jest.fn().mockResolvedValue({
          id: 'pay_1', amountCents: 12000, currency: 'EGP', enrollmentId: 'enr_1',
        }),
        delete: jest.fn(async ({ where }: { where: { id: string } }) => {
          deleted.push(`payment:${where.id}`);
          return { id: where.id, enrollmentId: 'enr_1' };
        }),
      },
      enrollment: {
        create: jest.fn().mockResolvedValue({ id: 'enr_1' }),
        update: jest.fn(async () => {
          deleted.push('enrollment:restored');
          return {};
        }),
        delete: jest.fn(async () => {
          deleted.push('enrollment:deleted');
          return {};
        }),
      },
    };
    const prisma = {
      studentProfile: { findFirst: jest.fn().mockResolvedValue({ id: 'st_1', user: { fullName: 'A', email: 'a@b.c' } }) },
      course: { findFirst: jest.fn().mockResolvedValue({ id: 'c_1', tenantId: 't_1', title: 'X', priceCents: 10000, currency: 'EGP' }) },
      enrollment: { findUnique: jest.fn().mockResolvedValue(over.existing ?? null) },
      payment: { update: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    } as unknown as PrismaService;

    const client = {
      createCheckoutSession: jest.fn(async () => {
        if (over.createFails) throw new Error('provider unreachable');
        return over.createReturnsNoUrl ? { id: 'cs_1' } : { id: 'cs_1', url: 'https://pay.test/cs_1' };
      }),
    } as unknown as XPayClient;

    const config = new XPayConfig();
    const payments = { quote: jest.fn().mockResolvedValue({ netCents: 10000, feeCents: 2000, totalCents: 12000 }) } as unknown as ManualPaymentsService;
    return { service: new XPayService(prisma, client, config, payments), deleted, prisma };
  }

  it('returns the checkout link on the happy path', async () => {
    const { service } = buildStart();
    await expect(service.startCheckout('u1', 'c_1')).resolves.toMatchObject({
      paymentId: 'pay_1',
      checkoutUrl: 'https://pay.test/cs_1',
    });
  });

  it('deletes the payment and the enrolment when the provider is unreachable', async () => {
    const { service, deleted } = buildStart({ createFails: true });
    await expect(service.startCheckout('u1', 'c_1')).rejects.toThrow();
    expect(deleted).toEqual(['payment:pay_1', 'enrollment:deleted']);
  });

  it('does the same when the provider returns no checkout link', async () => {
    const { service, deleted } = buildStart({ createReturnsNoUrl: true });
    await expect(service.startCheckout('u1', 'c_1')).rejects.toThrow();
    expect(deleted).toContain('payment:pay_1');
  });

  it('restores an enrolment that existed before the attempt instead of deleting it', async () => {
    // A student retrying a payment already had an enrolment row. Deleting it
    // would take away a record this checkout did not create.
    const { service, deleted } = buildStart({
      createFails: true,
      existing: { id: 'enr_1', status: 'PENDING_APPROVAL', expiresAt: null },
    });
    await expect(service.startCheckout('u1', 'c_1')).rejects.toThrow();
    // The payment goes; the enrolment is put back rather than removed.
    expect(deleted).toContain('payment:pay_1');
    expect(deleted).not.toContain('enrollment:deleted');
    expect(deleted.at(-1)).toBe('enrollment:restored');
  });
});
