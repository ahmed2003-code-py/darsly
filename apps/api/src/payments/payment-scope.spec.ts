import { ManualPaymentsService } from './manual-payments.service';

const STUDENT = { id: 's1', userId: 'u1', gradeId: null, track: null };
const personalCourse = {
  id: 'c1', tenantId: 'teacherT', academyId: 'teacherT', status: 'PUBLISHED', priceCents: 1000, pricingModel: 'ONE_TIME',
  teacher: { user: { id: 'tu' } },
};
const centerCourse = { ...personalCourse, academyId: 'centerA' };

function makeDeps(course = personalCourse, kind: 'PERSONAL' | 'CENTER' = 'PERSONAL') {
  const prisma: any = {
    studentProfile: { findUnique: jest.fn().mockResolvedValue(STUDENT) },
    course: { findFirst: jest.fn().mockResolvedValue(course), findUnique: jest.fn().mockResolvedValue(course), findUniqueOrThrow: jest.fn().mockResolvedValue(course) },
    academy: { findUnique: jest.fn().mockResolvedValue({ kind, feeType: 'PERCENT', feeValue: 20 }) },
    courseGrade: { findMany: jest.fn().mockResolvedValue([]) },
    coupon: { findFirst: jest.fn().mockResolvedValue(null) },
    platformPaymentAccount: { findMany: jest.fn().mockResolvedValue([]) },
    enrollment: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => ({ id: 'e1', ...data })),
      update: jest.fn(async ({ data }: any) => ({ id: 'e1', ...data })),
    },
    payment: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(async ({ data }: any) => ({ id: 'p1', ...data })),
    },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  const ledger: any = { recordPayment: jest.fn(), ensureInvoice: jest.fn(), walletBalance: jest.fn().mockResolvedValue(0) };
  const svc = new ManualPaymentsService(prisma, ledger, { create: jest.fn().mockResolvedValue({}) } as any, { put: jest.fn(), store: jest.fn(), remove: jest.fn() } as any, { read: jest.fn() } as any);
  return { prisma, ledger, svc };
}
const dto = { courseId: 'c1', method: 'VODAFONE_CASH', reference: '01012345678', proofImageUrl: undefined } as any;

describe('ManualPaymentsService — organisation scope on the one Payment creation path', () => {
  it('a PERSONAL payment carries academyId = course.academyId (== tenantId today)', async () => {
    const { prisma, svc } = makeDeps();
    await svc.submit('u1', dto).catch(() => undefined);
    const created = prisma.payment.create.mock.calls[0]?.[0]?.data;
    expect(created).toBeDefined();
    expect(created).toMatchObject({ academyId: 'teacherT', tenantId: 'teacherT' });
    expect(prisma.enrollment.create.mock.calls[0][0].data).toMatchObject({ academyId: 'teacherT' });
  });

  it('a Center course is refused before any enrollment or payment row exists', async () => {
    const { prisma, svc, ledger } = makeDeps(centerCourse, 'CENTER');
    await expect(svc.submit('u1', dto)).rejects.toMatchObject({ response: { code: 'CENTER_COURSE_MUST_BE_FREE' } });
    expect(prisma.enrollment.create).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(ledger.recordPayment).not.toHaveBeenCalled();
  });

  it('the fee configuration is the organisation\'s, looked up by academyId', async () => {
    const { prisma, svc } = makeDeps();
    await svc.quote({ id: 'c1', priceCents: 1000, tenantId: 'teacherT', academyId: 'orgX' });
    expect(prisma.academy.findUnique.mock.calls[0][0].where).toEqual({ id: 'orgX' });
  });

  it('the teacher queue is scoped by academyId, not tenantId', async () => {
    const { prisma, svc } = makeDeps();
    await svc.teacherQueue('centerA');
    const where = prisma.payment.findMany.mock.calls[0][0].where;
    expect(where.academyId).toBe('centerA');
    expect(where.tenantId).toBeUndefined();
  });

  it('no direct balance mutation — money still only moves through LedgerService', () => {
    // Structural guard: the service exposes no method that writes ledger rows itself.
    const proto = Object.getOwnPropertyNames(ManualPaymentsService.prototype);
    expect(proto.some((m) => /balance|ledgerEntry|credit|debit/i.test(m))).toBe(false);
  });
});
