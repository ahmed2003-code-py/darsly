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
        id: 'pay1', status: 'PAID', amountCents: 45000, tenantId: 't1', ledgerTransaction: null,
      }),
    },
    teacherProfile: { findUnique: jest.fn().mockResolvedValue({ commissionPercent: 20 }) },
    payoutRequest: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'po1', tenantId: 't1', amountCents: 30000, ledgerTransaction: null,
      }),
    },
    invoice: { findUnique: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(0), create: jest.fn() },
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
      id: 'pay1', status: 'PAID', amountCents: 45000, tenantId: 't1', ledgerTransaction: { id: 'existing' },
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
        .mockResolvedValueOnce([{ tenantId: 't1', _sum: { amountCents: 80000 } }]) // net
        .mockResolvedValueOnce([{ tenantId: 't1', _sum: { amountCents: 20000 } }]); // fee
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

  describe('revenueTrend', () => {
    it('zero-fills days with no ledger activity', async () => {
      const prisma = makePrisma();
      const today = new Date();
      prisma.$queryRaw.mockResolvedValue([
        { day: today, gross: 50000n, fee: 10000n },
      ]);
      const svc = new LedgerService(prisma);
      const trend = await svc.revenueTrend(7);
      expect(trend).toHaveLength(1);
      expect(trend[0]).toEqual({ date: today.toISOString().slice(0, 10), grossCents: 50000, feeCents: 10000 });
    });
  });
});
