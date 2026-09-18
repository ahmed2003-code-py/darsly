import { PaymentMatchingService } from './payment-matching.service';

/**
 * Deciding that a transfer belongs to a payment.
 *
 * The dangerous case is one pending payment of the right size in the window
 * whose reference does *not* match the transfer. That used to be credited on
 * amount and timing alone — the weakest evidence there is, because two students
 * buying the same course in the same three days transfer identical amounts, and
 * whichever one the window happened to hold got the other's money.
 *
 * The payer's name closes it. Both providers print it and the parser used to
 * throw it away; it is the one thing on a transfer a student cannot read off
 * somebody else's receipt.
 */
const SMS = (payer: string) =>
  [
    'تم استلام مبلغ 100.00 جنيه من 01284120292؛',
    `المسجل بإسم ${payer} على`,
    'على رقم محفظتك 01002589923 بتاريخ 14-09-26 12:00.',
    'رقم العملية: 023683598446',
  ].join('\n');

function ctx(over: { paymentRef?: string | null; owner?: string } = {}) {
  const events: any[] = [];
  const prisma: any = {
    paymentEvent: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(async (args: any) => {
        events.push(args.data);
        return { id: 'evt1', ...args.data };
      }),
    },
    payment: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'pay1',
          reference: over.paymentRef === undefined ? '01999999999' : over.paymentRef,
          status: 'PENDING',
          amountCents: 10000,
          walletCents: 0,
          student: { user: { fullName: over.owner ?? 'أحمد عبد العزيز هريدي' } },
        },
      ]),
    },
    walletTopup: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const manual: any = { systemVerify: jest.fn().mockResolvedValue({}), settle: jest.fn() };
  const wallet: any = { approveTopup: jest.fn() };
  const svc = new PaymentMatchingService(prisma, manual, wallet);
  return { svc, manual, events };
}

const transfer = (payer: string) => ({
  provider: 'VODAFONE_CASH' as const,
  amountCents: 10000,
  reference: '01284120292',
  identities: ['01284120292'],
  externalId: 'sms-hash-1',
  rawMessage: SMS(payer),
});

describe('one payment of this size, and the reference does not match', () => {
  it('is credited when the payer is the person who owes it', async () => {
    // Register spelling vs SMS spelling of one person: hamza, final ya, and
    // where the compound name is broken all differ, and none of that means
    // anything.
    const { svc, manual } = ctx();
    const r = await svc.ingest(transfer('احمد عبدالعزيز هريدى'));
    expect(r.status).toBe('MATCHED');
    expect(manual.systemVerify).toHaveBeenCalledWith('pay1');
  });

  it('goes to a human when the payer is somebody else', async () => {
    const { svc, manual } = ctx();
    const r = await svc.ingest(transfer('محمود ابراهيم سعيد'));
    expect(r.status).toBe('AMBIGUOUS');
    // Nothing is credited: this is the case that used to take one student's
    // money and open another student's course with it.
    expect(manual.systemVerify).not.toHaveBeenCalled();
  });

  it('goes to a human when the message names nobody', async () => {
    // No name to weigh, so there is nothing left but amount and timing — which
    // is not enough on its own and never was.
    const { svc, manual } = ctx();
    const r = await svc.ingest({
      ...transfer('x'),
      rawMessage: 'تم استلام مبلغ 100.00 جنيه على رقم محفظتك 01002589923',
    });
    expect(r.status).toBe('AMBIGUOUS');
    expect(manual.systemVerify).not.toHaveBeenCalled();
  });

  it('says in the note whose name it saw, so an admin can act on it', async () => {
    const { svc, events } = ctx();
    await svc.ingest(transfer('محمود ابراهيم سعيد'));
    expect(events[0].note).toContain('محمود ابراهيم سعيد');
    expect(events[0].note).toContain('أحمد عبد العزيز هريدي');
  });
});

describe('the reference does match', () => {
  it('is credited on the reference alone', async () => {
    // The strong evidence, and it stands by itself: the student read a number
    // off their own receipt and it is this transfer's.
    const { svc, manual } = ctx({ paymentRef: '01284120292' });
    const r = await svc.ingest(transfer('احمد عبدالعزيز هريدى'));
    expect(r.status).toBe('MATCHED');
    expect(manual.systemVerify).toHaveBeenCalledWith('pay1');
  });

  it('is still credited when the name disagrees, but says so', async () => {
    // Somebody paying for their own child, or from a parent's wallet, is
    // ordinary and must not be blocked. It is still worth an admin's eye, so
    // the disagreement is written down rather than acted on.
    const { svc, manual, events } = ctx({ paymentRef: '01284120292' });
    const r = await svc.ingest(transfer('محمود ابراهيم سعيد'));
    expect(r.status).toBe('MATCHED');
    expect(manual.systemVerify).toHaveBeenCalledWith('pay1');
    expect(events[0].note).toContain('worth a look');
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
 *
 * `isIncomingTransfer` has always existed and was enforced in the device route
 * only. This is the common engine both routes reach, and the key-authenticated
 * route came in underneath it — so an outgoing debit submitted there was
 * matched and settled. Demonstrated against a running API: an outgoing SMS for
 * the right amount turned a PENDING payment into PAID.
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
    // The reference matches a pending payment exactly. Without the direction
    // check that is enough to settle it, which is the whole defect.
    expect(manual.systemVerify).not.toHaveBeenCalled();
  });

  it('says why, so an admin is not left guessing', async () => {
    const { svc, events } = ctx({ paymentRef: '01284120292' });
    await svc.ingest(event(OUTGOING));
    expect(events[0].note).toContain('leaving the account');
  });

  it('still settles a genuine incoming transfer', async () => {
    // The guard must not swallow the case it exists to let through.
    const { svc, manual } = ctx({ paymentRef: '01284120292' });
    const r = await svc.ingest(event(INCOMING));
    expect(r.status).toBe('MATCHED');
    expect(manual.systemVerify).toHaveBeenCalledWith('pay1');
  });

  it('does not treat a missing message as outgoing', async () => {
    // An event with no raw message cannot be judged either way. Refusing it
    // here would break every caller that sends only structured fields, so it
    // keeps its existing behaviour and is matched on its other evidence.
    const { svc, manual } = ctx({ paymentRef: '01284120292' });
    const r = await svc.ingest({ ...event(''), rawMessage: undefined });
    expect(r.status).toBe('MATCHED');
    expect(manual.systemVerify).toHaveBeenCalledWith('pay1');
  });
});
