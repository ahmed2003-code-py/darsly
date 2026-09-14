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
