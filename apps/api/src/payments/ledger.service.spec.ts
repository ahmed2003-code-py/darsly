import { LedgerService } from './ledger.service';

/**
 * Verifies the double-entry invariant: every transaction we create balances
 * (Σ DEBIT === Σ CREDIT) and the teacher's split is correct.
 */
function makePrisma() {
  const created: any[] = [];
  return {
    _created: created,
    payment: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'pay1',
        status: 'PAID',
        amountCents: 45000,
        tenantId: 't1',
        ledgerTransaction: null,
      }),
    },
    teacherProfile: {
      findUnique: jest.fn().mockResolvedValue({ commissionPercent: 20, userId: 'u1' }),
    },
    // No academyId on the fixture payment/payout ⇒ academyId falls back to
    // tenantId, and that "academy" is PERSONAL — same account as before Phase 7.
    academy: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 't1', kind: 'PERSONAL', teacherSharePercent: null }),
    },
    academyMembership: { findFirst: jest.fn().mockResolvedValue(null) },
    payoutRequest: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'po1',
        tenantId: 't1',
        amountCents: 30000,
        ledgerTransaction: null,
      }),
    },
    invoice: {
      findUnique: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
    },
    ledgerTransaction: {
      create: jest.fn((args: any) => {
        created.push(args.data.entries.create);
        return Promise.resolve({ id: 'tx' });
      }),
    },
    ledgerEntry: { aggregate: jest.fn(), groupBy: jest.fn() },
    $queryRaw: jest.fn(),
  } as any;
}

const sum = (entries: any[], dir: string) =>
  entries.filter((e) => e.direction === dir).reduce((s, e) => s + e.amountCents, 0);

describe('LedgerService', () => {
  it('books a balanced transaction for a paid enrollment (20% commission)', async () => {
    const prisma = makePrisma();
    const svc = new LedgerService(prisma);
    await svc.recordPayment('pay1');

    const entries = prisma._created[0];
    expect(sum(entries, 'DEBIT')).toBe(sum(entries, 'CREDIT')); // balanced
    expect(sum(entries, 'DEBIT')).toBe(45000);
    const teacher = entries.find((e: any) => e.account === 'teacher:t1:balance');
    const commission = entries.find((e: any) => e.account === 'platform:commission');
    expect(commission.amountCents).toBe(9000); // 20%
    expect(teacher.amountCents).toBe(36000); // 80%
  });

  it('books a balanced reversing transaction for a payout', async () => {
    const prisma = makePrisma();
    const svc = new LedgerService(prisma);
    await svc.recordPayout('po1');

    const entries = prisma._created[0];
    expect(sum(entries, 'DEBIT')).toBe(sum(entries, 'CREDIT'));
    const teacherDebit = entries.find((e: any) => e.account === 'teacher:t1:balance');
    expect(teacherDebit.direction).toBe('DEBIT');
    expect(teacherDebit.amountCents).toBe(30000);
  });

  it('is idempotent — never double-books a payment', async () => {
    const prisma = makePrisma();
    prisma.payment.findUnique.mockResolvedValue({
      id: 'pay1',
      status: 'PAID',
      amountCents: 45000,
      tenantId: 't1',
      ledgerTransaction: { id: 'existing' },
    });
    const svc = new LedgerService(prisma);
    await svc.recordPayment('pay1');
    expect(prisma.ledgerTransaction.create).not.toHaveBeenCalled();
  });

  it('computes withdrawable balance as credits − debits', async () => {
    const prisma = makePrisma();
    prisma.ledgerEntry.aggregate
      .mockResolvedValueOnce({ _sum: { amountCents: 100000 } }) // credits
      .mockResolvedValueOnce({ _sum: { amountCents: 30000 } }); // debits
    const svc = new LedgerService(prisma);
    expect(await svc.teacherBalance('t1')).toBe(70000);
  });

  describe('academyRevenueBatch', () => {
    it('batches net + fee for every requested academy in exactly two queries, never one per academy', async () => {
      const prisma = makePrisma();
      prisma.ledgerEntry.groupBy
        .mockResolvedValueOnce([{ academyId: 't1', _sum: { amountCents: 80000 } }]) // net
        .mockResolvedValueOnce([{ academyId: 't1', _sum: { amountCents: 20000 } }]); // fee
      const svc = new LedgerService(prisma);
      const result = await svc.academyRevenueBatch(['t1', 't2', 't3']);

      expect(prisma.ledgerEntry.groupBy).toHaveBeenCalledTimes(2);
      expect(result.get('t1')).toEqual({ netCents: 80000, feeCents: 20000 });
      // academies with no ledger activity still come back as a zero row, not missing
      expect(result.get('t2')).toEqual({ netCents: 0, feeCents: 0 });
      expect(result.get('t3')).toEqual({ netCents: 0, feeCents: 0 });
    });

    it('returns an empty map without querying for an empty id list', async () => {
      const prisma = makePrisma();
      const svc = new LedgerService(prisma);
      const result = await svc.academyRevenueBatch([]);
      expect(result.size).toBe(0);
      expect(prisma.ledgerEntry.groupBy).not.toHaveBeenCalled();
    });
  });

  describe('CASH accounting — earnings stay separate from the cash-in-hand liability', () => {
    /**
     * The example from the Phase 7 cash-accounting review: a student pays a
     * TEACHER 1000 in cash. Teacher share 900, platform fee 100.
     */
    it('TEACHER-received cash: the liability account is debited ONLY the fee (not the gross); the teacher earnings account is credited their full share', async () => {
      const prisma = makePrisma();
      prisma.payment.findUnique.mockResolvedValue({
        id: 'payCash1',
        status: 'PAID',
        amountCents: 1000,
        netCents: 900,
        feeCents: 100,
        tenantId: 't1',
        academyId: 't1',
        method: 'CASH',
        cashReceiver: 'TEACHER',
        ledgerTransaction: null,
      });
      const svc = new LedgerService(prisma);
      await svc.recordPayment('payCash1');

      const entries = prisma._created[0];
      expect(sum(entries, 'DEBIT')).toBe(sum(entries, 'CREDIT')); // still balanced
      expect(sum(entries, 'DEBIT')).toBe(1000); // == amountCents, in total, across BOTH debit legs

      // Leg 1: the teacher's own 900 is self-settled (a wash against a
      // platform-wide account), paired with the ordinary earnings credit.
      const washDebit = entries.find((e: any) => e.account === 'platform:cash-in-kind');
      expect(washDebit).toMatchObject({ direction: 'DEBIT', amountCents: 900 });

      // Leg 2: ONLY the 100 fee — not the full 1000 — is a real, standing
      // obligation on the teacher's OWN liability account.
      const liabilityDebit = entries.find((e: any) => e.account === 'teacher:t1:cash-liability');
      expect(liabilityDebit).toMatchObject({ direction: 'DEBIT', amountCents: 100 });

      const earningsCredit = entries.find((e: any) => e.account === 'teacher:t1:balance');
      expect(earningsCredit).toMatchObject({ direction: 'CREDIT', amountCents: 900 }); // their full share, untouched

      const commission = entries.find((e: any) => e.account === 'platform:commission');
      expect(commission).toMatchObject({ direction: 'CREDIT', amountCents: 100 });

      // Nothing touches :balance except the CREDIT of the teacher's own share.
      expect(entries.filter((e: any) => e.account === 'teacher:t1:balance')).toHaveLength(1);
    });

    it('teacherBalance (payout-eligible) reflects ONLY the credited share — never the full cash amount, never negative from collecting cash', async () => {
      const prisma = makePrisma();
      // :balance was credited 900 once, never debited by the cash collection.
      prisma.ledgerEntry.aggregate
        .mockResolvedValueOnce({ _sum: { amountCents: 900 } }) // credits on teacher:t1:balance
        .mockResolvedValueOnce({ _sum: { amountCents: 0 } }); // debits on teacher:t1:balance
      const svc = new LedgerService(prisma);
      expect(await svc.teacherBalance('t1')).toBe(900);
    });

    it('teacherCashOwed reads the dedicated liability account and reports the unremitted amount as a positive number — the fee, not the gross', async () => {
      const prisma = makePrisma();
      // teacher:t1:cash-liability: debited 100 (the fee only, per the corrected
      // two-leg entry above), never credited (no remittance flow yet)
      // ⇒ raw balance −100, reported as an owed amount of +100.
      prisma.ledgerEntry.aggregate
        .mockResolvedValueOnce({ _sum: { amountCents: 0 } }) // credits
        .mockResolvedValueOnce({ _sum: { amountCents: 100 } }); // debits
      const svc = new LedgerService(prisma);
      expect(await svc.teacherCashOwed('t1')).toBe(100);
    });

    it('cashOwedCents never reports a negative "owed" figure when an account happens to be net-positive (nothing owed)', async () => {
      const prisma = makePrisma();
      prisma.ledgerEntry.aggregate
        .mockResolvedValueOnce({ _sum: { amountCents: 500 } }) // credits (a future remittance flow)
        .mockResolvedValueOnce({ _sum: { amountCents: 400 } }); // debits
      const svc = new LedgerService(prisma);
      expect(await svc.cashOwedCents('teacher:t1:cash-liability')).toBe(0);
    });

    /**
     * The Center example: a student pays the CENTER 1000 in cash.
     * Teacher share 540, Center share 360 (60/40 of a 900 net), platform fee 100.
     */
    it("CENTER-received cash: the Center liability account is debited ONLY what it still owes (fee plus the teacher's share) — not the gross; both earnings accounts are credited their own share in full", async () => {
      const prisma = makePrisma();
      prisma.academy.findUnique.mockResolvedValue({
        id: 'centerA',
        kind: 'CENTER',
        teacherSharePercent: 60,
      });
      prisma.payment.findUnique.mockResolvedValue({
        id: 'payCash2',
        status: 'PAID',
        amountCents: 1000,
        netCents: 900,
        feeCents: 100,
        tenantId: 't1',
        academyId: 'centerA',
        method: 'CASH',
        cashReceiver: 'CENTER',
        ledgerTransaction: null,
      });
      const svc = new LedgerService(prisma);
      await svc.recordPayment('payCash2');

      const entries = prisma._created[0];
      expect(sum(entries, 'DEBIT')).toBe(sum(entries, 'CREDIT'));
      expect(sum(entries, 'DEBIT')).toBe(1000); // == amountCents, in total, across BOTH debit legs

      // Leg 1: the Center's own 360 is self-settled (a wash), paired with its
      // ordinary earnings credit below.
      const washDebit = entries.find((e: any) => e.account === 'platform:cash-in-kind');
      expect(washDebit).toMatchObject({ direction: 'DEBIT', amountCents: 360 });

      // Leg 2: ONLY the 640 still owed (100 fee + 540 teacher share) — never
      // the full 1000 — lands on the Center's OWN liability account.
      const liabilityDebit = entries.find(
        (e: any) => e.account === 'academy:centerA:cash-liability',
      );
      expect(liabilityDebit).toMatchObject({ direction: 'DEBIT', amountCents: 640 });

      // The Center never held on to the teacher's share as its own earning —
      // that credit lands on the TEACHER's account, not the Center's.
      const centerCredit = entries.find((e: any) => e.account === 'academy:centerA:balance');
      const teacherCredit = entries.find((e: any) => e.account === 'teacher:t1:balance');
      // teacherSharePercent 60 means the TEACHER gets 60% of the net (540); the
      // Center gets the remainder (360).
      expect(teacherCredit).toMatchObject({ direction: 'CREDIT', amountCents: 540 });
      expect(centerCredit).toMatchObject({ direction: 'CREDIT', amountCents: 360 });
      expect(centerCredit.amountCents + teacherCredit.amountCents).toBe(900); // == netCents

      // Neither earnings account was ever debited by this collection.
      expect(
        entries.some(
          (e: any) => e.account === 'academy:centerA:balance' && e.direction === 'DEBIT',
        ),
      ).toBe(false);
      expect(
        entries.some((e: any) => e.account === 'teacher:t1:balance' && e.direction === 'DEBIT'),
      ).toBe(false);
    });

    it('orgBalance for the Center is pure earnings (its own share only) — structurally cannot include what it still owes', async () => {
      const prisma = makePrisma();
      prisma.ledgerEntry.aggregate
        .mockResolvedValueOnce({ _sum: { amountCents: 360 } }) // credits on academy:centerA:balance
        .mockResolvedValueOnce({ _sum: { amountCents: 0 } }); // debits
      const svc = new LedgerService(prisma);
      expect(await svc.orgBalance({ id: 'centerA', kind: 'CENTER' })).toBe(360);
    });

    it("orgCashOwed reads the Center's own dedicated liability account, distinct from academy:centerA:balance", async () => {
      const prisma = makePrisma();
      prisma.ledgerEntry.aggregate
        .mockResolvedValueOnce({ _sum: { amountCents: 0 } })
        .mockResolvedValueOnce({ _sum: { amountCents: 640 } }); // 100 platform fee + 540 teacher share, still owed
      const svc = new LedgerService(prisma);
      expect(await svc.orgCashOwed('centerA')).toBe(640);
    });
  });

  describe('revenueTrend', () => {
    it('zero-fills days with no ledger activity', async () => {
      const prisma = makePrisma();
      const today = new Date();
      prisma.$queryRaw.mockResolvedValue([{ day: today, gross: 50000n, fee: 10000n }]);
      const svc = new LedgerService(prisma);
      const trend = await svc.revenueTrend(7);
      expect(trend).toHaveLength(1);
      expect(trend[0]).toEqual({
        date: today.toISOString().slice(0, 10),
        grossCents: 50000,
        feeCents: 10000,
      });
    });
  });
});
