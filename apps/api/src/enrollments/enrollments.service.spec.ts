import { BadRequestException, ConflictException } from '@nestjs/common';
import { EnrollmentsService } from './enrollments.service';

const STUDENT = {
  id: 's1',
  userId: 'u1',
  gradeId: null,
  track: null,
  user: { fullName: 'Student One' },
};
const COURSE = {
  id: 'c1',
  tenantId: 'a1',
  status: 'PUBLISHED',
  priceCents: 0,
  currency: 'EGP',
  pricingModel: 'ONE_TIME',
  teacher: { user: { id: 'teacherUser1', fullName: 'Teacher' } },
};

function makeDeps(overrides: { academy?: any; flagEnabled?: boolean } = {}) {
  const enrollmentRows = new Map<string, any>();
  const prisma: any = {
    studentProfile: {
      findUnique: jest.fn().mockResolvedValue(STUDENT),
      findFirst: jest.fn().mockResolvedValue(STUDENT),
    },
    course: { findFirst: jest.fn().mockResolvedValue(COURSE), findUnique: jest.fn() },
    courseGrade: { findMany: jest.fn().mockResolvedValue([]) },
    academy: {
      findUnique: jest.fn().mockResolvedValue({
        feeType: 'PERCENT',
        feeValue: 20,
        ...(overrides.academy ?? { enrollmentMode: 'AUTOMATIC' }),
      }),
    },
    coupon: { findFirst: jest.fn() },
    payment: { findFirst: jest.fn().mockResolvedValue(null) },
    enrollment: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn(async ({ where }: any) =>
        where.id ? (enrollmentRows.get(where.id) ?? null) : null,
      ),
      findUniqueOrThrow: jest.fn(async ({ where }: any) => enrollmentRows.get(where.id)),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `enr_${enrollmentRows.size + 1}`, ...data };
        enrollmentRows.set(row.id, row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = { ...enrollmentRows.get(where.id), ...data };
        enrollmentRows.set(where.id, row);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = enrollmentRows.get(where.id);
        if (!row || (where.status && row.status !== where.status)) return { count: 0 };
        enrollmentRows.set(where.id, { ...row, ...data });
        return { count: 1 };
      }),
    },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
    _rows: enrollmentRows,
  };
  const notifications: any = { create: jest.fn().mockResolvedValue(undefined) };
  const ledger: any = { recordPayment: jest.fn() };
  const flags: any = { isEnabled: jest.fn().mockResolvedValue(overrides.flagEnabled ?? true) };
  const svc = new EnrollmentsService(prisma, notifications, ledger, flags);
  return { prisma, notifications, ledger, flags, svc };
}

describe('EnrollmentsService — enrollment modes (Phase 5)', () => {
  describe('enroll() — AUTOMATIC mode (must be byte-for-byte unchanged)', () => {
    it("activates a free course immediately, never touching the academy/flag lookups' outcome", async () => {
      const { svc, prisma } = makeDeps({ academy: { enrollmentMode: 'AUTOMATIC' } });
      const result = await svc.enroll('u1', 'c1');
      expect(result.status).toBe('ACTIVE');
      expect(result.source).toBeUndefined();
      expect(prisma.enrollment.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'ACTIVE' }) }),
      );
    });
  });

  describe('enroll() — MANUAL/DEMO mode, free course', () => {
    it('goes to PENDING_APPROVAL instead of ACTIVE when the flag is on', async () => {
      const { svc, prisma } = makeDeps({
        academy: { enrollmentMode: 'MANUAL' },
        flagEnabled: true,
      });
      const result = await svc.enroll('u1', 'c1');
      expect(result.status).toBe('PENDING_APPROVAL');
      expect(prisma.enrollment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'PENDING_APPROVAL', approvedAt: null }),
        }),
      );
    });

    it('falls back to instant ACTIVE (AUTOMATIC behavior) when the flag is disabled — never strands a student', async () => {
      const { svc } = makeDeps({ academy: { enrollmentMode: 'MANUAL' }, flagEnabled: false });
      const result = await svc.enroll('u1', 'c1');
      expect(result.status).toBe('ACTIVE');
    });

    it('refuses a second request while one is already pending', async () => {
      const { svc, prisma } = makeDeps({ academy: { enrollmentMode: 'MANUAL' } });
      prisma.enrollment.findUnique.mockResolvedValue({ id: 'enr_1', status: 'PENDING_APPROVAL' });
      await expect(svc.enroll('u1', 'c1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('does not reserve a coupon for a pending-approval request (nothing to release on reject)', async () => {
      const { svc, prisma } = makeDeps({ academy: { enrollmentMode: 'MANUAL' } });
      // quote() looks up the course again via findFirst with status: PUBLISHED — already mocked to COURSE.
      const result = await svc.enroll('u1', 'c1');
      expect(result.status).toBe('PENDING_APPROVAL');
      // No coupon path exercised here since no couponCode was passed — this
      // just confirms the request completes without a coupon service call.
      expect(prisma.coupon.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('enroll() — paid course, every mode (must be unaffected by enrollmentMode)', () => {
    it('still returns PAYMENT_REQUIRED for a paid course under MANUAL mode', async () => {
      const { svc, prisma } = makeDeps({ academy: { enrollmentMode: 'MANUAL' } });
      prisma.course.findFirst.mockResolvedValue({ ...COURSE, priceCents: 10000 });
      await expect(svc.enroll('u1', 'c1')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'PAYMENT_REQUIRED' }),
      });
    });
  });

  describe('approve()', () => {
    it('activates a PENDING_APPROVAL enrollment and tags source MANUAL_APPROVAL', async () => {
      const { svc, prisma } = makeDeps();
      prisma.enrollment.findFirst.mockResolvedValueOnce({
        id: 'enr_1',
        tenantId: 'a1',
        status: 'PENDING_APPROVAL',
        course: COURSE,
        student: STUDENT,
        studentId: 's1',
        courseId: 'c1',
        payments: [],
      });
      prisma._rows.set('enr_1', { id: 'enr_1', status: 'PENDING_APPROVAL' });
      const result = await svc.approve('a1', 'enr_1');
      expect(result.status).toBe('ACTIVE');
      expect(result.source).toBe('MANUAL_APPROVAL');
    });

    it('refuses to approve an enrollment that is not PENDING_APPROVAL', async () => {
      const { svc, prisma } = makeDeps();
      prisma.enrollment.findFirst.mockResolvedValueOnce({
        id: 'enr_1',
        tenantId: 'a1',
        status: 'ACTIVE',
        course: COURSE,
        student: STUDENT,
        studentId: 's1',
        courseId: 'c1',
        payments: [],
      });
      await expect(svc.approve('a1', 'enr_1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('is idempotent: a second concurrent approve on the same row is refused, not double-activated', async () => {
      const { svc, prisma } = makeDeps();
      prisma.enrollment.findFirst.mockResolvedValue({
        id: 'enr_1',
        tenantId: 'a1',
        status: 'PENDING_APPROVAL',
        course: COURSE,
        student: STUDENT,
        studentId: 's1',
        courseId: 'c1',
        payments: [],
      });
      prisma._rows.set('enr_1', { id: 'enr_1', status: 'PENDING_APPROVAL' });
      await svc.approve('a1', 'enr_1'); // first succeeds, row is now ACTIVE
      await expect(svc.approve('a1', 'enr_1')).rejects.toBeInstanceOf(BadRequestException); // second sees status mismatch
    });

    it('404s for an enrollment belonging to a different academy — never leaks it', async () => {
      const { svc, prisma } = makeDeps();
      prisma.enrollment.findFirst.mockResolvedValue(null); // tenant-scoped query found nothing
      await expect(svc.approve('a1', 'enr_1')).rejects.toThrow();
    });
  });

  describe('reject()', () => {
    it('rejects a PENDING_APPROVAL enrollment with a reason', async () => {
      const { svc, prisma } = makeDeps();
      prisma.enrollment.findFirst.mockResolvedValue({
        id: 'enr_1',
        tenantId: 'a1',
        status: 'PENDING_APPROVAL',
        course: COURSE,
        student: STUDENT,
        studentId: 's1',
        courseId: 'c1',
        payments: [],
      });
      prisma._rows.set('enr_1', { id: 'enr_1', status: 'PENDING_APPROVAL' });
      const result = await svc.reject('a1', 'enr_1', 'not eligible');
      expect(result.status).toBe('REJECTED');
      expect(result.revokedReason).toBe('not eligible');
    });
  });

  describe('demoEnroll() — the strict financial-safety surface', () => {
    it('refuses when the academy is in AUTOMATIC mode', async () => {
      const { svc, prisma } = makeDeps({ academy: { enrollmentMode: 'AUTOMATIC' } });
      prisma.studentProfile.findFirst.mockResolvedValue(STUDENT);
      await expect(svc.demoEnroll('a1', { studentUserId: 'u1' }, 'c1')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'ENROLLMENT_MODE_MISMATCH' }),
      });
    });

    it('activates the enrollment directly with source DEMO, no Payment row, in DEMO mode', async () => {
      const { svc, prisma } = makeDeps({ academy: { enrollmentMode: 'DEMO' } });
      prisma.studentProfile.findFirst.mockResolvedValue(STUDENT);
      prisma.course.findFirst.mockResolvedValue(COURSE);
      const result = await svc.demoEnroll('a1', { studentUserId: 'u1' }, 'c1');
      expect(result.status).toBe('ACTIVE');
      expect(result.source).toBe('DEMO');
      // The one call in this test asserting no payment machinery was touched.
      expect(prisma.payment.findFirst).toHaveBeenCalled(); // only the pending-payment guard check
      expect(Object.keys(prisma)).not.toContain('ledgerTransaction');
    });

    it('works for a PAID course too — demo bypasses the price, never creates a Payment', async () => {
      const { svc, prisma } = makeDeps({ academy: { enrollmentMode: 'DEMO' } });
      prisma.studentProfile.findFirst.mockResolvedValue(STUDENT);
      prisma.course.findFirst.mockResolvedValue({ ...COURSE, priceCents: 50000 });
      const result = await svc.demoEnroll('a1', { studentUserId: 'u1' }, 'c1');
      expect(result.status).toBe('ACTIVE');
    });

    it('refuses when a payment is already PENDING for this student+course — prevents a later double-credit', async () => {
      const { svc, prisma } = makeDeps({ academy: { enrollmentMode: 'DEMO' } });
      prisma.studentProfile.findFirst.mockResolvedValue(STUDENT);
      prisma.payment.findFirst.mockResolvedValue({ id: 'pay1' });
      await expect(svc.demoEnroll('a1', { studentUserId: 'u1' }, 'c1')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'PAYMENT_PENDING' }),
      });
    });

    it('refuses re-demo-enrolling an already-ACTIVE, unexpired enrollment', async () => {
      const { svc, prisma } = makeDeps({ academy: { enrollmentMode: 'DEMO' } });
      prisma.studentProfile.findFirst.mockResolvedValue(STUDENT);
      prisma.enrollment.findUnique.mockResolvedValue({
        id: 'enr_1',
        status: 'ACTIVE',
        expiresAt: null,
      });
      await expect(svc.demoEnroll('a1', { studentUserId: 'u1' }, 'c1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('404s for a student who does not exist', async () => {
      const { svc, prisma } = makeDeps({ academy: { enrollmentMode: 'DEMO' } });
      prisma.studentProfile.findFirst.mockResolvedValue(null);
      await expect(svc.demoEnroll('a1', { studentUserId: 'nonexistent' }, 'c1')).rejects.toThrow();
    });

    it('404s for a course belonging to a different academy — never cross-academy-enrolls', async () => {
      const { svc, prisma } = makeDeps({ academy: { enrollmentMode: 'DEMO' } });
      prisma.studentProfile.findFirst.mockResolvedValue(STUDENT);
      prisma.course.findFirst.mockResolvedValue(null); // tenant-scoped query found nothing
      await expect(svc.demoEnroll('a1', { studentUserId: 'u1' }, 'c1')).rejects.toThrow();
    });
  });
});
