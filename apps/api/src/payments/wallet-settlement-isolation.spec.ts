import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ManualPaymentsService } from './manual-payments.service';

/**
 * Spending the same wallet balance twice.
 *
 * Settling a wallet-funded payment reads the student's balance and then writes
 * a debit against it. Those are two statements, and under Postgres's default
 * READ COMMITTED they are not one unit across transactions: two concurrent
 * purchases both read the same balance, both pass the check, and both write
 * their debit. The student gets two courses for the price of one and the wallet
 * goes negative.
 *
 * Nothing else in the path catches it. The compare-and-swap on the payment row
 * ("update where status = PENDING") makes settling *one* payment twice safe,
 * but two purchases are two different payment rows, so those guards never
 * collide with each other.
 *
 * The remedy is the one this codebase already applies to a teacher withdrawing
 * twice at once (PayoutsService.request): SERIALIZABLE, so Postgres
 * predicate-locks the range the balance aggregate scanned, notices the
 * concurrent insert into it, and aborts one of the pair.
 *
 * These tests pin the decision — which transactions are opened serializable,
 * and what the loser of a race is told. They do not prove Postgres's behaviour;
 * that is the database's contract, and verifying it end to end needs a real
 * database (see the audit's "not tested" section).
 */
function ctx(
  over: { method?: string; walletCents?: number; status?: string; settledAt?: Date | null } = {},
) {
  const opened: { options: unknown }[] = [];
  const payment = {
    id: 'pay1',
    status: over.status ?? 'PENDING',
    courseId: 'c1',
    enrollmentId: 'enr1',
    studentId: 's1',
    couponId: null,
    tenantId: 't1',
    method: over.method ?? 'INSTAPAY',
    walletCents: over.walletCents ?? 0,
    amountCents: 10000,
    settledAt: over.settledAt ?? null,
  };
  const tx: any = {
    payment: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue(payment),
    },
    enrollment: { update: jest.fn().mockResolvedValue({}) },
  };
  const prisma: any = {
    payment: {
      findUnique: jest.fn().mockResolvedValue(payment),
      update: jest.fn().mockResolvedValue(payment),
    },
    course: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'c1', tenantId: 't1', pricingModel: 'ONE_TIME', title: 'X' }),
    },
    studentProfile: { findUnique: jest.fn().mockResolvedValue({ userId: 'u1' }) },
    $transaction: jest.fn(async (work: any, options: unknown) => {
      opened.push({ options });
      return work(tx);
    }),
  };
  const ledger: any = {
    recordPayment: jest.fn().mockResolvedValue(undefined),
    ensureInvoice: jest.fn().mockResolvedValue(undefined),
  };
  const notifications: any = { create: jest.fn().mockResolvedValue({}) };
  // Proof storage and the proof reader are not reached on any path these cases
  // exercise — the subject here is which transaction gets opened, not receipts.
  const proofs: any = { put: jest.fn(), remove: jest.fn() };
  const proofReader: any = { read: jest.fn() };
  const svc = new ManualPaymentsService(prisma, ledger, notifications, proofs, proofReader);
  return { svc, prisma, ledger, opened, payment };
}

const SERIALIZABLE = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable };

describe('a settlement that reads a wallet balance', () => {
  it('is opened serializable when the whole price came from the wallet', async () => {
    const { svc, opened } = ctx({ method: 'WALLET' });
    await svc.systemVerify('pay1');
    expect(opened[0].options).toEqual(SERIALIZABLE);
  });

  it('is opened serializable when only part of it did', async () => {
    // A mixed payment releases a reservation rather than re-reading the live
    // balance, but it still touches wallet-derived money — the ledger reads a
    // balance on this path too, so it gets the same protection.
    const { svc, opened } = ctx({ method: 'INSTAPAY', walletCents: 2500 });
    await svc.systemVerify('pay1');
    expect(opened[0].options).toEqual(SERIALIZABLE);
  });
});

describe('a settlement that reads no balance', () => {
  it('is left at the default isolation', async () => {
    // Paying the serialization cost — and its retries — on every bank transfer
    // would buy nothing: there is no balance to race against.
    const { svc, opened } = ctx({ method: 'INSTAPAY', walletCents: 0 });
    await svc.systemVerify('pay1');
    expect(opened[0].options).toBeUndefined();
  });

  it('is left at the default when the ledger is not touched at all', async () => {
    // Separation of duties: a teacher verifying their own academy's payment
    // activates the enrolment but leaves the earning unsettled, so nothing
    // reads a balance here whatever the funding was. An admin's verify does
    // settle, and the case above covers that it is serializable.
    const { svc, opened } = ctx({ method: 'WALLET' });
    await svc.verify({ sub: 'u9', role: 'TEACHER', tenantId: 't1' } as any, 'pay1');
    expect(opened[0].options).toBeUndefined();
  });

  it('is serializable when an admin verify settles a wallet payment', async () => {
    // An admin is an independent party, so their verify settles immediately —
    // which means it reads the balance, which means it needs the isolation.
    const { svc, opened } = ctx({ method: 'WALLET' });
    await svc.verify({ sub: 'u9', role: 'SUPER_ADMIN' } as any, 'pay1');
    expect(opened[0].options).toEqual(SERIALIZABLE);
  });
});

describe('losing the race', () => {
  it('is told to retry rather than shown a server error', async () => {
    const { svc, prisma } = ctx({ method: 'WALLET' });
    // What Postgres does to the loser of two conflicting serializable
    // transactions: abort with 40001, which Prisma reports as P2034.
    prisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('could not serialize access', {
        code: 'P2034',
        clientVersion: 'test',
      }),
    );
    await expect(svc.systemVerify('pay1')).rejects.toBeInstanceOf(ConflictException);
    const err = await svc.systemVerify('pay1').catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'WALLET_CONCURRENT_WRITE' });
  });

  it('does not swallow a real failure as a conflict', async () => {
    const { svc, prisma } = ctx({ method: 'WALLET' });
    prisma.$transaction.mockRejectedValue(new Error('connection reset'));
    await expect(svc.systemVerify('pay1')).rejects.toThrow('connection reset');
  });
});

/**
 * Two submissions for the same course, at the same moment.
 *
 * The "already enrolled" guard is a read, so both callers pass it and both
 * reach the enrolment create. `@@unique([studentId, courseId])` is what stops
 * the second becoming a second enrolment and a second charge — so the money has
 * always been right, and the wallet gate never caught this.
 *
 * What was wrong is the answer. An unhandled P2002 reached Nest's default
 * filter as a 500, on a payment endpoint, for what is usually a double-click.
 * Seen at runtime as `500, 201` from two simultaneous purchases of one course —
 * intermittent, because only the caller that loses the index race sees it.
 */
describe('losing the enrolment race', () => {
  function submitCtx() {
    const prisma: any = {
      studentProfile: {
        findUnique: jest.fn().mockResolvedValue({
          id: 's1',
          userId: 'u1',
          gradeId: null,
          track: null,
          user: { fullName: 'S' },
        }),
      },
      course: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'c1',
          tenantId: 't1',
          title: 'X',
          priceCents: 10000,
          currency: 'EGP',
          status: 'PUBLISHED',
        }),
        findUnique: jest.fn().mockResolvedValue({ id: 'c1', tenantId: 't1', priceCents: 10000 }),
      },
      courseGrade: { findMany: jest.fn().mockResolvedValue([]) },
      enrollment: { findUnique: jest.fn().mockResolvedValue(null) },
      payment: { findFirst: jest.fn().mockResolvedValue(null) },
      academy: { findUnique: jest.fn().mockResolvedValue({ feeType: 'PERCENT', feeValue: 20 }) },
      // The loser of the unique-index race: Prisma reports P2002.
      $transaction: jest.fn(async () => {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['studentId', 'courseId'] },
        });
      }),
    };
    const svc = new ManualPaymentsService(
      prisma,
      { recordPayment: jest.fn(), ensureInvoice: jest.fn() } as any,
      { create: jest.fn() } as any,
      { store: jest.fn() } as any,
      { read: jest.fn() } as any,
    );
    return { svc, prisma };
  }

  it('is told it is already enrolled, not that the server broke', async () => {
    const { svc } = submitCtx();
    const err = await svc.submit('u1', { courseId: 'c1', method: 'WALLET' } as any).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: 'ALREADY_ENROLLED' });
  });

  it('does not swallow an unrelated database failure as a conflict', async () => {
    const { svc, prisma } = submitCtx();
    prisma.$transaction.mockRejectedValue(new Error('connection reset'));
    await expect(svc.submit('u1', { courseId: 'c1', method: 'WALLET' } as any)).rejects.toThrow(
      'connection reset',
    );
  });
});
