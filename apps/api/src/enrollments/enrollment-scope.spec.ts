import { EnrollmentsService } from './enrollments.service';

const STUDENT = { id: 's1', userId: 'u1', gradeId: null, track: null, user: { fullName: 'S' } };
const centerCourse = {
  id: 'c1', tenantId: 'teacherT', academyId: 'centerA', status: 'PUBLISHED', priceCents: 0, currency: 'EGP',
  pricingModel: 'ONE_TIME', teacher: { user: { id: 'tu', fullName: 'T' } },
};

function makeDeps(course = centerCourse, academy: Record<string, unknown> = { kind: 'CENTER', enrollmentMode: 'AUTOMATIC', feeType: 'PERCENT', feeValue: 20 }) {
  const prisma: any = {
    studentProfile: { findUnique: jest.fn().mockResolvedValue(STUDENT), findFirst: jest.fn().mockResolvedValue(STUDENT) },
    course: { findFirst: jest.fn().mockResolvedValue(course), findUnique: jest.fn().mockResolvedValue(course) },
    courseGrade: { findMany: jest.fn().mockResolvedValue([]) },
    academy: { findUnique: jest.fn().mockResolvedValue(academy) },
    coupon: { findFirst: jest.fn().mockResolvedValue(null) },
    payment: { findFirst: jest.fn().mockResolvedValue(null) },
    enrollment: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(async ({ data }: any) => ({ id: 'e1', ...data })),
      update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
    },
    bundleItem: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findUnique: jest.fn(), findFirst: jest.fn() },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  const svc = new EnrollmentsService(prisma, { create: jest.fn().mockResolvedValue(undefined) } as any, { recordPayment: jest.fn() } as any, { isEnabled: jest.fn().mockResolvedValue(true) } as any);
  return { prisma, svc };
}

describe('EnrollmentsService — organisation scope is copied from the Course', () => {
  it('a free Center enrolment carries academyId = course.academyId and tenantId = the author', async () => {
    const { prisma, svc } = makeDeps();
    await svc.enroll('u1', 'c1');
    const data = prisma.enrollment.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ academyId: 'centerA', tenantId: 'teacherT' });
    expect(data.academyId).not.toBe(data.tenantId);
  });

  it('the enrollment mode / approval flag are resolved for the organisation, not the author', async () => {
    const { prisma, svc } = makeDeps(centerCourse, { kind: 'CENTER', enrollmentMode: 'MANUAL', feeType: 'PERCENT', feeValue: 20 });
    await svc.enroll('u1', 'c1');
    const academyLookups = prisma.academy.findUnique.mock.calls.map((c: any) => c[0].where.id);
    expect(academyLookups).toContain('centerA');
    expect(academyLookups).not.toContain('teacherT');
  });

  it('a Center course that somehow carries a price cannot be quoted / bought', async () => {
    const { svc } = makeDeps({ ...centerCourse, priceCents: 500 });
    await expect(svc.quote('c1')).rejects.toMatchObject({ response: { code: 'CENTER_COURSE_MUST_BE_FREE' } });
  });

  it('a PERSONAL paid course still quotes with the fee (unchanged behaviour)', async () => {
    const personal = { ...centerCourse, tenantId: 'teacherT', academyId: 'teacherT', priceCents: 1000 };
    const { svc } = makeDeps(personal, { kind: 'PERSONAL', enrollmentMode: 'AUTOMATIC', feeType: 'PERCENT', feeValue: 20 });
    await expect(svc.quote('c1')).resolves.toMatchObject({ totalCents: 1200 });
  });

  it('teacher-side reads are scoped by academyId, never tenantId', async () => {
    const { prisma, svc } = makeDeps();
    await svc.teacherList('centerA');
    expect(prisma.enrollment.findMany.mock.calls[0][0].where).toMatchObject({ academyId: 'centerA' });
    expect(prisma.enrollment.findMany.mock.calls[0][0].where.tenantId).toBeUndefined();
  });

  it('a Center A staff member cannot approve/revoke a Center B enrolment (scoped 404)', async () => {
    const { prisma, svc } = makeDeps();
    prisma.enrollment.findFirst.mockResolvedValue(null);
    await expect(svc.revoke('centerA', 'enrInB')).rejects.toBeDefined();
    expect(prisma.enrollment.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'enrInB', academyId: 'centerA' });
  });

  it('demoEnroll writes the organisation scope and only finds courses offered in it', async () => {
    const { prisma, svc } = makeDeps(centerCourse, { kind: 'CENTER', enrollmentMode: 'DEMO' });
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', studentProfile: STUDENT });
    prisma.studentProfile.findFirst.mockResolvedValue({ ...STUDENT, user: { id: 'u1', fullName: 'S' } });
    await svc.demoEnroll('centerA', { studentUserId: 'u1' }, 'c1');
    expect(prisma.course.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'c1', academyId: 'centerA' });
    expect(prisma.enrollment.create.mock.calls[0][0].data).toMatchObject({ academyId: 'centerA', tenantId: 'teacherT' });
  });
});
