import {
  isIncomingTransfer,
  parseAmountCents,
  parseIdentities,
  parsePayerName,
} from '../device/sms-parser';
import { matchingFake } from './matching-fake';

/**
 * An InstaPay top-up, end to end, from the exact message production sent on
 * 16 Sep 2026 — through the real matcher.
 *
 * The bank sends the SMS (provider BANK_TRANSFER) while the student picked
 * INSTAPAY: the two are one rail. The bank's reference and the student's
 * receipt reference are issued by different systems and never agree, so an
 * InstaPay transfer is identified by the payer's name — under the policy's
 * narrow rule — or by a person. A receipt is supporting evidence only.
 */
const INSTAPAY_SMS =
  'يرجى العلم انه تم تنفيذ تحويل لحظي بمبلغ 5.00 جم إلى حسابك المنتهي بـ **7717 ' +
  'من احمد عبدالعزيز هريدى على برقم مرجعي 3979e788 بتاريخ 16-09-2026 16:57 ' +
  'للمزيد، برجاء الاتصال بـ 19666';

describe('the SMS itself', () => {
  it('is read as money arriving, with its amount, reference and payer', () => {
    expect(isIncomingTransfer(INSTAPAY_SMS)).toBe(true);
    expect(parseAmountCents(INSTAPAY_SMS)).toBe(500);
    expect(parseIdentities(INSTAPAY_SMS, ['01002589923'])).toContain('3979e788');
    expect(parsePayerName(INSTAPAY_SMS)).toBe('احمد عبدالعزيز هريدى');
  });
});

const topupOf = (method: string, reference: string, owner = 'أحمد عبد العزيز هريدي', over: any = {}) => ({
  id: 'top1',
  amountCents: 500,
  method,
  reference,
  student: { user: { fullName: owner } },
  ...over,
});

const event = {
  // What the listener reports for a CIB message: the *bank* sent it.
  provider: 'BANK_TRANSFER' as const,
  amountCents: 500,
  reference: '3979e788',
  identities: parseIdentities(INSTAPAY_SMS, ['01002589923']),
  externalId: 'sms-hash-instapay-1',
  rawMessage: INSTAPAY_SMS,
};

describe('a bank SMS against a top-up the student filed as InstaPay', () => {
  it('credits it on an exact provider reference — the two are the same rail', async () => {
    const f = matchingFake({ topups: [topupOf('INSTAPAY', '3979e788')] });
    const r = await f.svc.ingest(event);
    expect(f.prisma.walletTopup.findMany.mock.calls[0][0].where.method).toEqual({ in: ['INSTAPAY', 'BANK_TRANSFER'] });
    expect(r.status).toBe('MATCHED');
    expect(f.wallet.approveTopup).toHaveBeenCalled();
  });

  it('does not reach across to a wallet top-up', async () => {
    const f = matchingFake({ topups: [topupOf('VODAFONE_CASH', '3979e788')] });
    const r = await f.svc.ingest(event);
    expect(r.status).toBe('UNMATCHED');
    expect(f.wallet.approveTopup).not.toHaveBeenCalled();
  });

  it('credits on the full payer name when it is the only candidate and the only such transfer', async () => {
    const f = matchingFake({ topups: [topupOf('INSTAPAY', 'ffffffff')] });
    const r = await f.svc.ingest(event);
    expect(r.status).toBe('MATCHED');
    expect(f.wallet.approveTopup).toHaveBeenCalled();
  });

  it('refuses the name path when another unclaimed transfer of the amount is waiting', async () => {
    const f = matchingFake({
      topups: [topupOf('INSTAPAY', 'ffffffff')],
      events: [
        { id: 'other', provider: 'BANK_TRANSFER', amountCents: 500, status: 'UNMATCHED', occurredAt: new Date(), matchedPaymentId: null, matchedTopupId: null },
      ],
    });
    const r = await f.svc.ingest(event);
    expect(r.status).toBe('AMBIGUOUS');
    expect(f.wallet.approveTopup).not.toHaveBeenCalled();
  });

  it('refuses when the reference differs AND the money is in another name', async () => {
    const f = matchingFake({ topups: [topupOf('INSTAPAY', 'ffffffff', 'محمود إبراهيم سعيد')] });
    const r = await f.svc.ingest(event);
    expect(r.status).toBe('AMBIGUOUS');
    expect(f.wallet.approveTopup).not.toHaveBeenCalled();
  });
});

/**
 * The receipt — corroboration, never authority.
 *
 * The student's InstaPay receipt says «المرجع 770916345902»; the bank's SMS to
 * the platform says «برقم مرجعي 3979e788». A receipt is an image the buyer
 * controls, so "the same amount in the same minute" on it is never enough to
 * take a real transfer.
 */
const RECEIPT = {
  isReceipt: true,
  amountCents: 200000,
  sentAtText: '16 Sep 2026 07:55 AM',
  sentAtLocal: '2026-09-16T07:55',
  recipientHandle: 'ahmedelsayed2003@instapay',
  recipientName: 'AHMED E****** A**** E****** M*',
  senderHandle: 'mohtahati@instapay',
  senderName: 'MOHAMED TAHA ATIEA MASOOD',
  reference: '770916345902',
  issuer: 'InstaPay',
  concerns: [],
};

const bankSms = {
  provider: 'BANK_TRANSFER' as const,
  amountCents: 200000,
  reference: '3979e788',
  identities: ['3979e788'],
  externalId: 'sms-receipt-1',
  occurredAt: '2026-09-16T04:57:00Z',
  rawMessage:
    'تم تنفيذ تحويل لحظي بمبلغ 2000.00 جم إلى حسابك المنتهي بـ **7717 من محمد طه عطية مسعود على برقم مرجعي 3979e788',
};

describe('the receipt is supporting evidence only', () => {
  const topup = (over: any = {}) => ({
    id: 'top1',
    amountCents: 200000,
    method: 'INSTAPAY',
    reference: '',
    createdAt: new Date('2026-09-16T04:56:00Z'),
    proofReading: RECEIPT,
    student: { user: { fullName: 'محمد طه عطية مسعود' } },
    ...over,
  });

  it('credits the top-up on the payer’s full name; the receipt agrees but decides nothing', async () => {
    const f = matchingFake({ topups: [topup()] });
    expect((await f.svc.ingest(bankSms)).status).toBe('MATCHED');
    expect(f.wallet.approveTopup).toHaveBeenCalled();
  });

  it('(3) a fitting receipt from a buyer in another name is never enough', async () => {
    const f = matchingFake({ topups: [topup({ student: { user: { fullName: 'سارة علي حسن' } } })] });
    const r = await f.svc.ingest(bankSms);
    expect(r.status).toBe('AMBIGUOUS');
    expect(f.wallet.approveTopup).not.toHaveBeenCalled();
  });

  it('refuses when two receipts describe the same amount at the same time', async () => {
    const f = matchingFake({ topups: [topup(), topup({ id: 'top2' })] });
    expect((await f.svc.ingest(bankSms)).status).toBe('AMBIGUOUS');
    expect(f.wallet.approveTopup).not.toHaveBeenCalled();
  });

  it('refuses when the receipt and an exact reference point at different top-ups', async () => {
    const byReceipt = topup();
    const byRef = topup({ id: 'top2', reference: '3979e788', proofReading: null });
    const f = matchingFake({ topups: [byReceipt, byRef] });
    expect((await f.svc.ingest(bankSms)).status).toBe('AMBIGUOUS');
    expect(f.wallet.approveTopup).not.toHaveBeenCalled();
  });

  it('still works for a top-up with no receipt reading at all', async () => {
    const f = matchingFake({ topups: [topup({ proofReading: null })] });
    expect((await f.svc.ingest(bankSms)).status).toBe('MATCHED');
  });
});

/**
 * (9) The transfer arrives before the form is finished (16 Sep 2026 19:51):
 * the SMS is filed UNMATCHED, and the top-up reconciles against it when it is
 * submitted — by the same policy, claimed by compare-and-swap.
 */
describe('the transfer arrives before the form is finished', () => {
  const topupRow = {
    id: 'top1',
    method: 'INSTAPAY',
    amountCents: 200000,
    reference: '',
    createdAt: new Date('2026-09-16T04:55:42Z'),
    proofReading: RECEIPT,
    student: { user: { fullName: 'محمد طه عطية مسعود' } },
  };
  const eventRow = {
    id: 'evt1',
    provider: 'BANK_TRANSFER',
    amountCents: 200000,
    reference: '3979e788',
    status: 'UNMATCHED',
    matchedPaymentId: null,
    matchedTopupId: null,
    occurredAt: new Date('2026-09-16T04:55:27Z'),
    rawMessage: 'تم تنفيذ تحويل لحظي بمبلغ 2000.00 جم إلى حسابك من محمد طه عطية مسعود على برقم مرجعي 3979e788',
  };

  it('finds the transfer that arrived first and credits it — once', async () => {
    const f = matchingFake({ topups: [topupRow], events: [eventRow] });
    expect((await f.svc.reconcileTopup('top1')).status).toBe('MATCHED');
    expect(f.events[0]).toMatchObject({ status: 'MATCHED', matchedTopupId: 'top1' });
    expect(f.wallet.approveTopup).toHaveBeenCalledWith(null, 'top1');
    // Reconciling again finds nothing left to claim.
    f.topups[0].status = 'PENDING';
    expect((await f.svc.reconcileTopup('top1')).status).not.toBe('MATCHED');
    expect(f.wallet.approveTopup).toHaveBeenCalledTimes(1);
  });

  it('(13) a receipt with no name in the SMS is not enough', async () => {
    const f = matchingFake({
      topups: [topupRow],
      events: [{ ...eventRow, rawMessage: 'تم تنفيذ تحويل لحظي بمبلغ 2000.00 جم إلى حسابك برقم مرجعي 3979e788' }],
    });
    expect((await f.svc.reconcileTopup('top1')).status).not.toBe('MATCHED');
    expect(f.wallet.approveTopup).not.toHaveBeenCalled();
  });

  it('refuses when two unmatched transfers both fit', async () => {
    const f = matchingFake({ topups: [topupRow], events: [eventRow, { ...eventRow, id: 'evt2' }] });
    expect((await f.svc.reconcileTopup('top1')).status).not.toBe('MATCHED');
    expect(f.wallet.approveTopup).not.toHaveBeenCalled();
  });

  it('never uses a transfer that is being returned', async () => {
    const f = matchingFake({ topups: [topupRow], events: [{ ...eventRow, status: 'RETURNED' }] });
    expect((await f.svc.reconcileTopup('top1')).status).toBe('UNMATCHED');
    expect(f.wallet.approveTopup).not.toHaveBeenCalled();
  });

  it('still reconciles a Vodafone top-up by its wallet number', async () => {
    const vf = { ...topupRow, method: 'VODAFONE_CASH', reference: '01284120292', proofReading: null };
    const vfEvent = {
      ...eventRow,
      provider: 'VODAFONE_CASH',
      reference: '01284120292',
      rawMessage: 'تم استلام مبلغ 2000.00 جنيه من 01284120292',
    };
    const f = matchingFake({ topups: [vf], events: [vfEvent] });
    expect((await f.svc.reconcileTopup('top1')).status).toBe('MATCHED');
    expect(f.wallet.approveTopup).toHaveBeenCalled();
  });
});
