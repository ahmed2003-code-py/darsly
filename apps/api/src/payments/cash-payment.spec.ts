import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ManualPaymentsService } from './manual-payments.service';

/**
 * Architecture Reset Phase 7 — the cash lifecycle. A cash claim is never PAID
 * on the student's word alone; confirmation is settlement (one flip, one
 * ledger transaction), and only the party who actually holds the money may
 * confirm or reject it. See ManualPaymentsService.cashAuthority/confirmCash.
 */

const STUDENT = { id: 's1', userId: 'u1', gradeId: null, track: null };
const personalCourse = {
  id: 'c1', tenantId: 'teacherT', academyId: 'teacherT', status: 'PUBLISHED', priceCents: 1000, pricingModel: 'ONE_TIME',
  teacher: { user: { id: 'tu' }, userId: 'tu' },
};
const centerCourse = { ...personalCourse, academyId: 'centerA' };

function makePrisma(course: any = personalCourse) {
  const payments = new Map<string, any>();
  const prisma: any = {
    studentProfile: {
      findUnique: jest.fn().mockResolvedValue({ id: 's1', gradeId: null, track: null, user: { fullName: 'S', userId: 'u1' } }),
    },
    course: { findFirst: jest.fn().mockResolvedValue(course), findUnique: jest.fn(async () => course) },
    academy: { findUnique: jest.fn().mockResolvedValue({ id: 'centerA', kind: course.academyId === 'centerA' ? 'CENTER' : 'PERSONAL', teacherSharePercent: 50 }) },
    teacherProfile: { findUnique: jest.fn().mockResolvedValue({ userId: 'tu' }) },
    academyMembership: { findFirst: jest.fn().mockResolvedValue(null) },
    courseGrade: { findMany: jest.fn().mockResolvedValue([]) },
    coupon: { findFirst: jest.fn().mockResolvedValue(null) },
    platformPaymentAccount: { findMany: jest.fn().mockResolvedValue([]) },
    enrollment: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => ({ id: 'e1', ...data })),
      update: jest.fn(async ({ data }: any) => ({ id: 'e1', ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    payment: {
      findFirst: jest.fn((args: any) => Promise.resolve([...payments.values()].find((p) => Object.entries(args.where).every(([k, v]) => k === 'deletedAt' || p[k] === v)) ?? null)),
      findUnique: jest.fn(({ where }: any) => Promise.resolve(payments.get(where.id) ?? null)),
      findUniqueOrThrow: jest.fn(({ where }: any) => Promise.resolve(payments.get(where.id))),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `p${payments.size + 1}`, status: 'PENDING', settledAt: null, ledgerTransaction: null, walletCents: 0, ...data };
        payments.set(row.id, row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => { const row = { ...payments.get(where.id), ...data }; payments.set(where.id, row); return row; }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = payments.get(where.id);
        if (!row || (where.status && row.status !== where.status)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    _payments: payments,
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  const ledger: any = {
    recordPayment: jest.fn().mockResolvedValue(undefined),
    ensureInvoice: jest.fn().mockResolvedValue(undefined),
    walletBalance: jest.fn().mockResolvedValue(0),
  };
  const svc = new ManualPaymentsService(prisma, ledger, { create: jest.fn().mockResolvedValue({}) } as any, { put: jest.fn(), store: jest.fn(), remove: jest.fn() } as any, { read: jest.fn() } as any);
  return { prisma, ledger, svc };
}

const submitDto = (over: Record<string, unknown> = {}) => ({ courseId: 'c1', method: 'CASH', ...over } as any);

describe('Cash payments — student claim → PENDING, never auto-PAID', () => {
  it('a student "I paid cash" claim is created PENDING with cashOrigin STUDENT_REPORTED', async () => {
    const { prisma, svc } = makePrisma();
    const payment = await svc.submit('u1', submitDto());
    expect(payment.status).toBe('PENDING');
    const row = prisma._payments.get(payment.id);
    expect(row.method).toBe('CASH');
    expect(row.cashOrigin).toBe('STUDENT_REPORTED');
    expect(row.cashReceiver).toBe('TEACHER');
  });

  it('a cash claim carries no wallet portion and needs no proof image', async () => {
    const { prisma, svc } = makePrisma();
    const payment = await svc.submit('u1', submitDto({ useWallet: true }));
    const row = prisma._payments.get(payment.id);
    expect(row.walletCents).toBe(0);
    expect(row.proofImageUrl).toBe('');
  });

  it('claiming cash at a Center desk requires the organisation to actually be a Center', async () => {
    const { svc } = makePrisma(); // PERSONAL course
    await expect(svc.submit('u1', submitDto({ cashReceiver: 'CENTER' }))).rejects.toMatchObject({ response: { code: 'CASH_RECEIVER_INVALID' } });
  });
});

describe('Cash payments — confirmation is scoped, immutable, and idempotent', () => {
  const teacherCtx = { academyId: 'teacherT', role: 'OWNER', can: () => true } as any;
  const otherTeacherCtx = { academyId: 'teacherT', role: 'OWNER', can: () => true } as any;
  const teacherActor = { sub: 'tu', role: 'TEACHER', tenantId: 'teacherT' };
  const otherTeacherActor = { sub: 'someone-else', role: 'TEACHER', tenantId: 'teacherX' };
  const studentActor = { sub: 'u1', role: 'STUDENT' };

  async function claim() {
    const deps = makePrisma();
    const payment = await deps.svc.submit('u1', submitDto());
    return { ...deps, paymentId: payment.id };
  }

  it('the receiving teacher confirms → PAID + settled + ledger booked once', async () => {
    const { svc, ledger, prisma, paymentId } = await claim();
    const result = await svc.confirmCash(teacherActor, teacherCtx, paymentId);
    expect(result.ok).toBe(true);
    const row = prisma._payments.get(paymentId);
    expect(row.status).toBe('PAID');
    expect(row.settledAt).toBeTruthy();
    expect(ledger.recordPayment).toHaveBeenCalledTimes(1);
  });

  it('the student cannot confirm their own cash claim', async () => {
    const { svc, paymentId } = await claim();
    await expect(svc.confirmCash(studentActor as any, teacherCtx, paymentId)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a different teacher (not the receiver) cannot confirm', async () => {
    const { svc, paymentId } = await claim();
    await expect(svc.confirmCash(otherTeacherActor, otherTeacherCtx, paymentId)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a caller in a different workspace 404s — existence hidden, same as every other cross-academy read', async () => {
    const { svc, paymentId } = await claim();
    const foreignCtx = { academyId: 'someone-elses-workspace', role: 'OWNER', can: () => true } as any;
    await expect(svc.confirmCash(teacherActor, foreignCtx, paymentId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('double confirmation: the second call loses (NOT_PENDING), only one ledger transaction is ever booked', async () => {
    const { svc, ledger, prisma, paymentId } = await claim();
    await svc.confirmCash(teacherActor, teacherCtx, paymentId);
    // The row now has a ledgerTransaction attached (recordPayment is mocked, so
    // simulate what a real settlement leaves behind before the second call).
    prisma._payments.get(paymentId).ledgerTransaction = { id: 'tx1' };
    await expect(svc.confirmCash(teacherActor, teacherCtx, paymentId)).rejects.toMatchObject({ response: { code: 'NOT_PENDING' } });
    expect(ledger.recordPayment).toHaveBeenCalledTimes(1);
  });

  it('concurrent confirmation: only one caller wins the status flip (updateMany guard)', async () => {
    const { svc, prisma, paymentId } = await claim();
    const [a, b] = await Promise.allSettled([
      svc.confirmCash(teacherActor, teacherCtx, paymentId),
      svc.confirmCash(teacherActor, teacherCtx, paymentId),
    ]);
    const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect(prisma.payment.updateMany).toHaveBeenCalled();
  });

  it('rejecting a cash claim needs the same receiver authority', async () => {
    const { svc, prisma, paymentId } = await claim();
    await expect(svc.rejectCash(otherTeacherActor, otherTeacherCtx, paymentId)).rejects.toBeInstanceOf(ForbiddenException);
    const rejected = await svc.rejectCash(teacherActor, teacherCtx, paymentId);
    expect(rejected.ok).toBe(true);
    expect(prisma._payments.get(paymentId).status).toBe('REJECTED');
  });

  it('a non-cash payment cannot be confirmed through the cash path', async () => {
    const { prisma, svc, paymentId } = await claim();
    prisma._payments.get(paymentId).method = 'INSTAPAY';
    await expect(svc.confirmCash(teacherActor, teacherCtx, paymentId)).rejects.toMatchObject({ response: { code: 'NOT_CASH' } });
  });
});

describe('Cash payments — Center desk collection scoped by payment.collect', () => {
  const collectorCtx = { academyId: 'centerA', role: 'TEACHER', can: (c: string) => c === 'payment.collect' } as any;
  const nonCollectorCtx = { academyId: 'centerA', role: 'TEACHER', can: () => false } as any;
  const collectorActor = { sub: 'cashier1', role: 'TEACHER', tenantId: 'tpCashier' };
  const nonCollectorActor = { sub: 'nobody', role: 'TEACHER', tenantId: 'tpNobody' };

  async function centerClaim() {
    const deps = makePrisma(centerCourse);
    const payment = await deps.svc.submit('u1', submitDto({ cashReceiver: 'CENTER' }));
    return { ...deps, paymentId: payment.id };
  }

  it('a member holding payment.collect can confirm a Center cash claim', async () => {
    const { svc, prisma, paymentId } = await centerClaim();
    await svc.confirmCash(collectorActor, collectorCtx, paymentId);
    expect(prisma._payments.get(paymentId).status).toBe('PAID');
  });

  it('a member without payment.collect cannot confirm the Center\'s cash, even inside the same Center', async () => {
    const { svc, paymentId } = await centerClaim();
    await expect(svc.confirmCash(nonCollectorActor, nonCollectorCtx, paymentId)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('recordCash by the Center collector settles immediately (staff-recorded cash, no separate confirmation step)', async () => {
    const { svc, prisma } = makePrisma(centerCourse);
    const result = await svc.recordCash(collectorActor, collectorCtx, { studentId: 's1', courseId: 'c1', receiver: 'CENTER' });
    expect(result.status).toBe('PAID');
    expect(prisma._payments.get(result.id).cashOrigin).toBe('CENTER_RECORDED');
  });

  it('recordCash by a non-collector, non-author member is refused', async () => {
    const { svc } = makePrisma(centerCourse);
    await expect(svc.recordCash(nonCollectorActor, nonCollectorCtx, { studentId: 's1', courseId: 'c1', receiver: 'CENTER' }))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('recordCash for TEACHER receiver requires being the course\'s author', async () => {
    const { svc } = makePrisma(centerCourse);
    const strangerCtx = { academyId: 'centerA', role: 'TEACHER', can: () => false } as any;
    await expect(svc.recordCash({ sub: 'not-the-author', role: 'TEACHER' }, strangerCtx, { studentId: 's1', courseId: 'c1', receiver: 'TEACHER' }))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('the course author can record their own TEACHER-received cash', async () => {
    const { svc, prisma } = makePrisma(centerCourse);
    const authorCtx = { academyId: 'centerA', role: 'TEACHER', can: () => false } as any;
    const result = await svc.recordCash({ sub: 'tu', role: 'TEACHER' }, authorCtx, { studentId: 's1', courseId: 'c1', receiver: 'TEACHER' });
    expect(prisma._payments.get(result.id).cashOrigin).toBe('TEACHER_RECORDED');
    expect(prisma._payments.get(result.id).cashReceiver).toBe('TEACHER');
  });

  it('recordCash on a Center course with no agreed revenue split is refused', async () => {
    const { svc, prisma } = makePrisma(centerCourse);
    prisma.academy.findUnique.mockResolvedValue({ id: 'centerA', kind: 'CENTER', teacherSharePercent: null });
    await expect(svc.recordCash(collectorActor, collectorCtx, { studentId: 's1', courseId: 'c1', receiver: 'CENTER' }))
      .rejects.toMatchObject({ response: { code: 'CENTER_REVENUE_SPLIT_NOT_CONFIGURED' } });
  });
});

describe('Cash payments — no direct ledger mutation, everything through LedgerService.recordPayment', () => {
  it('confirmCash never calls anything on prisma.ledgerEntry directly', async () => {
    const { svc, prisma } = makePrisma();
    const payment = await svc.submit('u1', submitDto());
    prisma.ledgerEntry = { create: jest.fn() }; // would fail the test below if ever touched
    await svc.confirmCash({ sub: 'tu', role: 'TEACHER', tenantId: 'teacherT' }, { academyId: 'teacherT', role: 'OWNER', can: () => true } as any, payment.id);
    expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
  });
});
