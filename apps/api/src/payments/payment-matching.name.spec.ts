import { matchingFake } from './matching-fake';

/**
 * Deciding that a transfer belongs to a payment — through the real service.
 *
 * The dangerous case is one pending payment of the right size in the window
 * whose declared identity does *not* match the transfer. That used to be
 * credited on the payer's name alone even when the SMS printed a different
 * sending wallet. The SMS naming someone else's wallet is a contradiction now,
 * and a contradiction always goes to a person.
 */
const SMS = (payer: string) =>
  [
    'تم استلام مبلغ 100.00 جنيه من 01284120292؛',
    `المسجل بإسم ${payer} على`,
    'على رقم محفظتك 01002589923 بتاريخ 14-09-26 12:00.',
    'رقم العملية: 023683598446',
  ].join('\n');

function ctx(over: { paymentRef?: string | null; owner?: string } = {}) {
  return matchingFake({
    payments: [
      {
        id: 'pay1',
        reference: over.paymentRef === undefined ? '01099999999' : over.paymentRef,
        amountCents: 10000,
        student: { user: { fullName: over.owner ?? 'أحمد عبد العزيز هريدي' } },
      },
    ],
  });
}

const transfer = (payer: string) => ({
  provider: 'VODAFONE_CASH' as const,
  amountCents: 10000,
  reference: '01284120292',
  identities: ['01284120292'],
  externalId: `sms-hash-${Math.random()}`,
  rawMessage: SMS(payer),
});

describe('one payment of this size, and the declared number is not the sender', () => {
  it('is NOT credited even when the name agrees: the SMS names another wallet', async () => {
    const { svc, manual, events } = ctx();
    const r = await svc.ingest(transfer('احمد عبدالعزيز هريدى'));
    expect(r.status).toBe('AMBIGUOUS');
    expect(manual.systemVerify).not.toHaveBeenCalled();
    expect(events[0].note).toContain('sender number');
  });

  it('goes to a human when the payer is somebody else', async () => {
    const { svc, manual } = ctx();
    const r = await svc.ingest(transfer('محمود ابراهيم سعيد'));
    expect(r.status).toBe('AMBIGUOUS');
    expect(manual.systemVerify).not.toHaveBeenCalled();
  });

  it('goes to a human when the message names nobody', async () => {
    const { svc, manual } = ctx();
    const r = await svc.ingest({
      ...transfer('x'),
      rawMessage: 'تم استلام مبلغ 100.00 جنيه على رقم محفظتك 01002589923',
    });
    expect(r.status).toBe('AMBIGUOUS');
    expect(manual.systemVerify).not.toHaveBeenCalled();
  });
});

describe('the declared number is the sender', () => {
  it('is credited on the sender number alone', async () => {
    const { svc, manual } = ctx({ paymentRef: '01284120292' });
    const r = await svc.ingest(transfer('احمد عبدالعزيز هريدى'));
    expect(r.status).toBe('MATCHED');
    expect(manual.systemVerify).toHaveBeenCalledWith('pay1');
  });

  it('is still credited when the account is in another name, but says so', async () => {
    // Somebody paying for their own child, or from a parent's wallet, is
    // ordinary and must not be blocked. It is written down for an admin.
    const { svc, manual, events } = ctx({ paymentRef: '01284120292' });
    const r = await svc.ingest(transfer('محمود ابراهيم سعيد'));
    expect(r.status).toBe('MATCHED');
    expect(manual.systemVerify).toHaveBeenCalledWith('pay1');
    expect(events[0].note).toContain('worth a look');
  });

  it('(8) the same SMS delivered twice verifies once', async () => {
    const { svc, manual } = ctx({ paymentRef: '01284120292' });
    const t = transfer('احمد عبدالعزيز هريدى');
    expect((await svc.ingest(t)).status).toBe('MATCHED');
    expect((await svc.ingest(t)).status).toBe('DUPLICATE');
    expect(manual.systemVerify).toHaveBeenCalledTimes(1);
  });
});

describe('every event records who sent the money', () => {
  it('keeps the payer name whether it matched or not', async () => {
    const { svc, events } = ctx();
    await svc.ingest(transfer('احمد عبدالعزيز هريدى'));
    expect(events[0].payerName).toBe('احمد عبدالعزيز هريدى');
  });
});

/**
 * Money leaving the account must never settle a payment.
 *
 * The listener sits on a phone that both receives and sends. A bank's
 * «تم تنفيذ تحويل لحظي بمبلغ 120.00 جم من حسابك» is the platform's own money
 * going out, and booking it as an incoming payment settles an enrolment nobody
 * paid for.
 */
describe('the direction of the transfer', () => {
  const OUTGOING = [
    'يرجى العلم انه تم تنفيذ تحويل لحظي بمبلغ 100.00 جم من حسابك المنتهي بـ 7717********',
    'برقم مرجعي aaaa1111 بتاريخ 2026-09-18 12:00',
  ].join('\n');

  const INCOMING = [
    'تم استلام مبلغ 100.00 جنيه من 01284120292؛',
    'المسجل بإسم أحمد عبد العزيز هريدي على',
    'على رقم محفظتك 01002589923 بتاريخ 18-09-26 12:00.',
    'رقم العملية: 023683598446',
  ].join('\n');

  const event = (rawMessage: string | undefined) => ({
    provider: 'VODAFONE_CASH' as const,
    amountCents: 10000,
    reference: '01284120292',
    identities: ['01284120292'],
    externalId: `direction-${Math.random()}`,
    rawMessage,
  });

  it('refuses to settle anything from an outgoing debit', async () => {
    const { svc, manual } = ctx({ paymentRef: '01284120292' });
    const r = await svc.ingest(event(OUTGOING));
    expect(r.status).toBe('UNMATCHED');
    expect(manual.systemVerify).not.toHaveBeenCalled();
  });

  it('says why, so an admin is not left guessing', async () => {
    const { svc, events } = ctx({ paymentRef: '01284120292' });
    await svc.ingest(event(OUTGOING));
    expect(events[0].note).toContain('leaving the account');
  });

  it('still settles a genuine incoming transfer', async () => {
    const { svc, manual } = ctx({ paymentRef: '01284120292' });
    const r = await svc.ingest(event(INCOMING));
    expect(r.status).toBe('MATCHED');
    expect(manual.systemVerify).toHaveBeenCalledWith('pay1');
  });

  it('does not treat a missing message as outgoing', async () => {
    const { svc, manual } = ctx({ paymentRef: '01284120292' });
    const r = await svc.ingest({ ...event(''), rawMessage: undefined });
    expect(r.status).toBe('MATCHED');
    expect(manual.systemVerify).toHaveBeenCalledWith('pay1');
  });
});

describe('Darsly’s own number is never a payer', () => {
  it('(12) an SMS whose only number is ours has no identity to match', async () => {
    const { svc, manual } = ctx({ paymentRef: '01002589923' });
    const r = await svc.ingest({
      provider: 'VODAFONE_CASH',
      amountCents: 10000,
      reference: '01002589923',
      identities: ['01002589923'],
      externalId: 'ours-1',
      rawMessage: 'تم استلام مبلغ 100.00 جنيه على رقم محفظتك 01002589923',
    });
    expect(r.status).toBe('UNMATCHED');
    expect(manual.systemVerify).not.toHaveBeenCalled();
  });

  it('(12) a legacy payment whose "sender" is our number is never linked by it', async () => {
    const { svc, manual } = ctx({ paymentRef: '01002589923' });
    const r = await svc.ingest(transfer('احمد عبدالعزيز هريدى'));
    expect(r.status).not.toBe('MATCHED');
    expect(manual.systemVerify).not.toHaveBeenCalled();
  });
});
