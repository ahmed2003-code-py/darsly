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
    ledgerEntry: { aggregate: jest.fn() },
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
});
