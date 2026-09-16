import { isIncomingTransfer, parseAmountCents, parseIdentities, parsePayerName } from '../device/sms-parser';
import { PaymentMatchingService } from './payment-matching.service';

/**
 * An InstaPay top-up, end to end, from the exact message production sent on
 * 16 Sep 2026.
 *
 * Every step of this path was broken at once, and each break alone was enough
 * to stop the money being credited:
 *
 *  1. the message never counted as incoming — a bank says "a transfer was
 *     executed to your account", never "received", so it was dropped before it
 *     reached matching at all;
 *  2. the payer's name came out as «احمد عبدالعزيز هريدى على», the preposition
 *     included, so it agreed with nobody;
 *  3. the SMS is sent by the *bank*, so the event's provider is BANK_TRANSFER,
 *     while the student — reading a card labelled «إنستاباي درسلي» — had picked
 *     INSTAPAY, and an exact method equality found no candidates.
 *
 * This asserts the whole chain, so fixing one and regressing another is caught.
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

function ctx(topupMethod: string, topupRef: string) {
  return ctxNamed(topupMethod, topupRef, 'أحمد عبد العزيز هريدي');
}

function ctxNamed(topupMethod: string, topupRef: string, owner: string) {
  const seen: any = {};
  const prisma: any = {
    paymentEvent: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(async (args: any) => ({ id: 'evt1', ...args.data })),
    },
    payment: {
      findMany: jest.fn(async (args: any) => {
        seen.paymentWhere = args.where;
        return [];
      }),
    },
    walletTopup: {
      findMany: jest.fn(async (args: any) => {
        seen.topupWhere = args.where;
        const allowed = args.where.method?.in ?? [args.where.method];
        return allowed.includes(topupMethod)
          ? [{ id: 'top1', reference: topupRef, student: { user: { fullName: owner } } }]
          : [];
      }),
    },
  };
  const manual: any = { systemVerify: jest.fn(), settle: jest.fn() };
  const wallet: any = { approveTopup: jest.fn().mockResolvedValue({}) };
  return { svc: new PaymentMatchingService(prisma, manual, wallet), wallet, seen };
}

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
  it('credits it — the two are the same rail', async () => {
    const { svc, wallet, seen } = ctx('INSTAPAY', '3979e788');
    const r = await svc.ingest(event);
    expect(seen.topupWhere.method).toEqual({ in: ['INSTAPAY', 'BANK_TRANSFER'] });
    expect(r.status).toBe('MATCHED');
    expect(wallet.approveTopup).toHaveBeenCalled();
  });

  it('does not reach across to a wallet top-up', async () => {
    // A Vodafone Cash top-up is a different rail and must stay out of the pool.
    const { svc, wallet } = ctx('VODAFONE_CASH', '3979e788');
    const r = await svc.ingest(event);
    expect(r.status).toBe('UNMATCHED');
    expect(wallet.approveTopup).not.toHaveBeenCalled();
  });

  it('falls back to the payer\'s name when the reference differs', async () => {
    // The student mistyped the reference. One top-up of this size in the window
    // and the transfer is in their own name, so it is credited — the same rule
    // that already applies to a wallet transfer, now reachable for InstaPay.
    const { svc, wallet } = ctx('INSTAPAY', 'ffffffff');
    const r = await svc.ingest(event);
    expect(r.status).toBe('MATCHED');
    expect(wallet.approveTopup).toHaveBeenCalled();
  });

  it('refuses when the reference differs AND the money is in another name', async () => {
    // Pooling the methods must not weaken the evidence. This is the case that
    // would hand one student's money to another, and it goes to a human.
    const { svc, wallet } = ctxNamed('INSTAPAY', 'ffffffff', 'محمود إبراهيم سعيد');
    const r = await svc.ingest(event);
    expect(r.status).toBe('AMBIGUOUS');
    expect(wallet.approveTopup).not.toHaveBeenCalled();
  });
});

/**
 * The receipt as the identity — the case the reference can never cover.
 *
 * The student's InstaPay receipt says «المرجع 770916345902»; the bank's SMS to
 * the platform says «برقم مرجعي 3979e788». Nothing links them but the money
 * itself: 2,000 EGP sent at 07:55 on 16 Sep.
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

function receiptCtx(topups: any[]) {
  const prisma: any = {
    paymentEvent: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(async (a: any) => ({ id: 'evt9', ...a.data })),
    },
    payment: { findMany: jest.fn().mockResolvedValue([]) },
    walletTopup: { findMany: jest.fn().mockResolvedValue(topups) },
  };
  const wallet: any = { approveTopup: jest.fn().mockResolvedValue({}) };
  return {
    svc: new PaymentMatchingService(prisma, { systemVerify: jest.fn(), settle: jest.fn() } as any, wallet),
    wallet,
  };
}

// The bank SMS for that same transfer: same amount, booked two minutes later,
// and carrying a reference the student has never seen.
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

describe('matching on the receipt, where no shared reference exists', () => {
  const topup = (over: any = {}) => ({
    id: 'top1',
    reference: '',
    proofReading: RECEIPT,
    student: { user: { fullName: 'محمد طه عطية مسعود' } },
    ...over,
  });

  it('credits the top-up whose receipt is this transfer', async () => {
    const { svc, wallet } = receiptCtx([topup()]);
    const r = await svc.ingest(bankSms);
    expect(r.status).toBe('MATCHED');
    expect(wallet.approveTopup).toHaveBeenCalled();
  });

  it('refuses when two receipts describe the same amount at the same time', async () => {
    const { svc, wallet } = receiptCtx([topup(), topup({ id: 'top2' })]);
    const r = await svc.ingest(bankSms);
    expect(r.status).toBe('AMBIGUOUS');
    expect(wallet.approveTopup).not.toHaveBeenCalled();
  });

  it('ignores a receipt for a transfer at a different time', async () => {
    const other = topup({ proofReading: { ...RECEIPT, sentAtLocal: '2026-09-16T05:40' } });
    const { svc, wallet } = receiptCtx([other]);
    const r = await svc.ingest(bankSms);
    // One candidate left, no receipt match, no reference match — the name path
    // decides, and here the names do agree.
    expect(r.status).toBe('MATCHED');
    expect(wallet.approveTopup).toHaveBeenCalled();
  });

  it('refuses when the receipt and the typed reference point at different top-ups', async () => {
    const byReceipt = topup();
    const byRef = topup({ id: 'top2', reference: '3979e788', proofReading: null });
    const { svc, wallet } = receiptCtx([byReceipt, byRef]);
    const r = await svc.ingest(bankSms);
    expect(r.status).toBe('AMBIGUOUS');
    expect(wallet.approveTopup).not.toHaveBeenCalled();
  });

  it('still works for a top-up with no receipt reading at all', async () => {
    const { svc, wallet } = receiptCtx([topup({ proofReading: null })]);
    const r = await svc.ingest(bankSms);
    expect(r.status).toBe('MATCHED');
    expect(wallet.approveTopup).toHaveBeenCalled();
  });
});
