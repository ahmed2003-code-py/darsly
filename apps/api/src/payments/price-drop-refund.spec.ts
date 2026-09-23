import { ManualPaymentsService } from './manual-payments.service';

/**
 * The price is checked again when the payment is confirmed, not when it was made.
 *
 * A teacher can drop a price — to zero, even — between a student pressing pay
 * and the bank's message arriving, and the second moment is the one where money
 * actually moves. Confirming against the old figure took the difference for a
 * course that no longer costs it, and the student had transferred real money
 * out of a real bank account for it.
 *
 * Fee model: the platform fee is additive and 20% here, so a 5 EGP course is
 * 500 net + 100 fee = 600 paid.
 */
function ctx(over: {
  paidCents?: number;
  walletCents?: number;
  priceNowCents: number;
  couponId?: string | null;
}) {
  const paid = over.paidCents ?? 600;
  const payment = {
    id: 'pay1',
    status: 'PENDING',
    courseId: 'c1',
    enrollmentId: 'e1',
    studentId: 's1',
    couponId: over.couponId ?? null,
    amountCents: paid,
    walletCents: over.walletCents ?? 0,
    tenantId: 't1',
  };
  const writes: any = { paymentData: null, walletCredits: [], walletTxns: [] };
  const tx = {
    payment: {
      updateMany: jest.fn(async (a: any) => {
        writes.paymentData = a.data;
        return { count: 1 };
      }),
    },
    enrollment: { update: jest.fn() },
    walletTransaction: {
      create: jest.fn(async (a: any) => {
        writes.walletTxns.push(a.data);
        return a.data;
      }),
    },
  };
  const prisma: any = {
    payment: { findUnique: jest.fn().mockResolvedValue(payment) },
    course: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'c1',
        tenantId: 't1',
        pricingModel: 'ONE_TIME',
        title: 'دورة',
        priceCents: over.priceNowCents,
      }),
    },
    coupon: { findUnique: jest.fn().mockResolvedValue(null) },
    academy: { findUnique: jest.fn().mockResolvedValue({ feeType: 'PERCENT', feeValue: 20 }) },
    studentProfile: { findUnique: jest.fn().mockResolvedValue({ userId: 'u1' }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(async (cb: any) => cb(tx)),
  };
  const ledger = {
    creditWallet: jest.fn(async (studentId: string, cents: number) => {
      writes.walletCredits.push({ studentId, cents });
      return 'ltx1';
    }),
    recordPayment: jest.fn(),
    ensureInvoice: jest.fn(),
  };
  const svc = new ManualPaymentsService(
    prisma,
    ledger as any,
    { create: jest.fn() } as any,
    {} as any,
    {} as any,
  );
  return { svc, writes, ledger, prisma };
}

describe('a price that changed before the transfer was confirmed', () => {
  it('leaves an unchanged price completely alone', async () => {
    const { svc, writes } = ctx({ priceNowCents: 500 });
    await svc.systemVerify('pay1');
    expect(writes.walletCredits).toEqual([]);
    expect(writes.paymentData.amountCents).toBeUndefined();
  });

  it('puts the difference in the wallet when the price dropped', async () => {
    // 5 EGP → 3 EGP: 600 paid, 360 owed now, 240 back.
    const { svc, writes } = ctx({ priceNowCents: 300 });
    await svc.systemVerify('pay1');
    expect(writes.walletCredits).toEqual([{ studentId: 's1', cents: 240 }]);
    expect(writes.walletTxns[0]).toMatchObject({ kind: 'REFUND', amountCents: 240 });
  });

  it('reprices the payment so the teacher earns what it costs now, not what it cost', async () => {
    const { svc, writes } = ctx({ priceNowCents: 300 });
    await svc.systemVerify('pay1');
    expect(writes.paymentData).toMatchObject({ amountCents: 360, netCents: 300, feeCents: 60 });
  });

  it('gives back everything when the course became free, and earns the teacher nothing', async () => {
    const { svc, writes, ledger } = ctx({ priceNowCents: 0 });
    await svc.systemVerify('pay1');
    expect(writes.walletCredits).toEqual([{ studentId: 's1', cents: 600 }]);
    expect(writes.paymentData).toMatchObject({ amountCents: 0, netCents: 0, feeCents: 0 });
    // recordPayment is still called, and refuses a zero payment itself.
    expect(ledger.recordPayment).toHaveBeenCalled();
  });

  it('still activates the enrolment when the course became free', async () => {
    const { svc, writes } = ctx({ priceNowCents: 0 });
    await svc.systemVerify('pay1');
    expect(writes.paymentData.status).toBe('PAID');
  });

  it('does not chase a student for a price that went UP', async () => {
    // They paid what was on the screen. 5 EGP → 10 EGP is not their problem.
    const { svc, writes } = ctx({ priceNowCents: 1000 });
    await svc.systemVerify('pay1');
    expect(writes.walletCredits).toEqual([]);
    expect(writes.paymentData.amountCents).toBeUndefined();
  });

  it('leaves a mixed wallet+transfer payment for a human rather than guessing', async () => {
    // Part of this total is reserved in escrow against this exact figure;
    // rewriting it underneath is escrow surgery.
    const { svc, writes } = ctx({ priceNowCents: 0, walletCents: 200 });
    await svc.systemVerify('pay1');
    expect(writes.walletCredits).toEqual([]);
    expect(writes.paymentData.amountCents).toBeUndefined();
  });

  it('records what it did, so the money is traceable afterwards', async () => {
    const { svc, prisma } = ctx({ priceNowCents: 300 });
    await svc.systemVerify('pay1');
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'payment.price.adjusted',
          meta: expect.objectContaining({ paidCents: 600, nowCents: 360, refundedCents: 240 }),
        }),
      }),
    );
  });
});
