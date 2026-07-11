import { CertificatesService } from './certificates.service';

/**
 * Verifies a certificate is issued only when every lesson is completed, that
 * the serial is well-formed, and that re-checking never mints a duplicate.
 */
function makeCtx(totalLessons: number, completedLessons: number, existing: any = null) {
  const prisma: any = {
    lesson: { count: jest.fn().mockResolvedValue(totalLessons) },
    lessonProgress: { count: jest.fn().mockResolvedValue(completedLessons) },
    certificate: {
      findUnique: jest.fn().mockResolvedValue(existing),
      count: jest.fn().mockResolvedValue(41),
      create: jest.fn((args: any) => Promise.resolve({ id: 'c1', ...args.data, course: { title: 'Algebra' } })),
    },
    studentProfile: { findUnique: jest.fn().mockResolvedValue({ userId: 'u1' }) },
  };
  const notifications: any = { create: jest.fn().mockResolvedValue({}) };
  return { svc: new CertificatesService(prisma, notifications), prisma, notifications };
}

describe('CertificatesService', () => {
  it('does not issue while lessons remain incomplete', async () => {
    const { svc, prisma } = makeCtx(5, 3);
    const res = await svc.checkCourseCompletion('s1', 'course1');
    expect(res).toBeNull();
    expect(prisma.certificate.create).not.toHaveBeenCalled();
  });

  it('issues a serial-stamped certificate on full completion and notifies', async () => {
    const { svc, prisma, notifications } = makeCtx(5, 5);
    const res: any = await svc.checkCourseCompletion('s1', 'course1');
    expect(prisma.certificate.create).toHaveBeenCalled();
    expect(res.serial).toMatch(/^DRS-CERT-\d{4}-000042$/); // count 41 → #42
    expect(notifications.create).toHaveBeenCalled();
  });

  it('is idempotent — never mints a second certificate', async () => {
    const { svc, prisma } = makeCtx(5, 5, { id: 'existing', serial: 'DRS-CERT-2026-000001' });
    const res: any = await svc.checkCourseCompletion('s1', 'course1');
    expect(res.id).toBe('existing');
    expect(prisma.certificate.create).not.toHaveBeenCalled();
  });

  it('ignores courses with no lessons', async () => {
    const { svc } = makeCtx(0, 0);
    expect(await svc.checkCourseCompletion('s1', 'course1')).toBeNull();
  });
});
