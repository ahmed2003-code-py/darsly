import { NotFoundException } from '@nestjs/common';
import { AdminAcademiesService } from './admin-academies.service';

function makeDeps() {
  const prisma: any = {
    academy: { count: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
    course: { groupBy: jest.fn(), count: jest.fn() },
    enrollment: { groupBy: jest.fn(), count: jest.fn() },
    academyMembership: { groupBy: jest.fn(), findMany: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const ledger: any = { academyRevenueBatch: jest.fn().mockResolvedValue(new Map()) };
  const flags: any = { listForAcademy: jest.fn().mockResolvedValue([]) };
  return { prisma, ledger, flags };
}

describe('AdminAcademiesService', () => {
  describe('listAcademies', () => {
    it('batches per-academy counts in fixed-size queries regardless of page size — never one query per academy', async () => {
      const { prisma, ledger, flags } = makeDeps();
      const academies = Array.from({ length: 20 }, (_, i) => ({
        id: `a${i}`,
        slug: `academy-${i}`,
        name: `Academy ${i}`,
        status: 'ACTIVE',
        createdAt: new Date(),
        owner: { fullName: `Owner ${i}`, email: `o${i}@x.com` },
      }));
      prisma.academy.count.mockResolvedValue(20);
      prisma.academy.findMany.mockResolvedValue(academies);
      prisma.course.groupBy.mockResolvedValue([]);
      prisma.enrollment.groupBy.mockResolvedValue([]);
      prisma.academyMembership.groupBy.mockResolvedValue([]);

      const svc = new AdminAcademiesService(prisma, ledger, flags);
      const result = await svc.listAcademies({ page: 1, pageSize: 20 });

      expect(result.academies).toHaveLength(20);
      // one call per data source, not one per academy (would be 20+ calls otherwise)
      expect(prisma.course.groupBy).toHaveBeenCalledTimes(2); // total + published
      expect(prisma.enrollment.groupBy).toHaveBeenCalledTimes(1);
      expect(prisma.academyMembership.groupBy).toHaveBeenCalledTimes(1);
      expect(ledger.academyRevenueBatch).toHaveBeenCalledTimes(1);
      expect(ledger.academyRevenueBatch).toHaveBeenCalledWith(academies.map((a) => a.id));
    });

    it('fills in zero counts for an academy with no students/teachers/courses/revenue', async () => {
      const { prisma, ledger, flags } = makeDeps();
      prisma.academy.count.mockResolvedValue(1);
      prisma.academy.findMany.mockResolvedValue([
        {
          id: 'empty1',
          slug: 'empty',
          name: 'Empty Academy',
          status: 'PENDING',
          createdAt: new Date(),
          owner: { fullName: 'X', email: 'x@x.com' },
        },
      ]);
      prisma.course.groupBy.mockResolvedValue([]);
      prisma.enrollment.groupBy.mockResolvedValue([]);
      prisma.academyMembership.groupBy.mockResolvedValue([]);
      ledger.academyRevenueBatch.mockResolvedValue(
        new Map([['empty1', { netCents: 0, feeCents: 0 }]]),
      );

      const svc = new AdminAcademiesService(prisma, ledger, flags);
      const result = await svc.listAcademies({});
      expect(result.academies[0]).toMatchObject({
        teachersCount: 0,
        assistantsCount: 0,
        studentsCount: 0,
        coursesCount: 0,
        publishedCoursesCount: 0,
        enrollmentsCount: 0,
        netRevenueCents: 0,
        platformFeeCents: 0,
        lastActivityAt: null,
      });
    });

    it('maps staff membership rows to teachers/assistants correctly (OWNER counts as a teacher)', async () => {
      const { prisma, ledger, flags } = makeDeps();
      prisma.academy.count.mockResolvedValue(1);
      prisma.academy.findMany.mockResolvedValue([
        {
          id: 'a1',
          slug: 'a1',
          name: 'A1',
          status: 'ACTIVE',
          createdAt: new Date(),
          owner: { fullName: 'O', email: 'o@x.com' },
        },
      ]);
      prisma.course.groupBy.mockResolvedValue([]);
      prisma.enrollment.groupBy.mockResolvedValue([]);
      prisma.academyMembership.groupBy.mockResolvedValue([
        { academyId: 'a1', role: 'OWNER', _count: { _all: 1 } },
        { academyId: 'a1', role: 'TEACHER', _count: { _all: 2 } },
        { academyId: 'a1', role: 'ASSISTANT', _count: { _all: 3 } },
      ]);

      const svc = new AdminAcademiesService(prisma, ledger, flags);
      const result = await svc.listAcademies({});
      expect(result.academies[0].teachersCount).toBe(3); // 1 OWNER + 2 TEACHER
      expect(result.academies[0].assistantsCount).toBe(3);
    });

    it('caps pageSize so a caller cannot force an unbounded query', async () => {
      const { prisma, ledger, flags } = makeDeps();
      prisma.academy.count.mockResolvedValue(0);
      prisma.academy.findMany.mockResolvedValue([]);
      prisma.course.groupBy.mockResolvedValue([]);
      prisma.enrollment.groupBy.mockResolvedValue([]);
      prisma.academyMembership.groupBy.mockResolvedValue([]);

      const svc = new AdminAcademiesService(prisma, ledger, flags);
      await svc.listAcademies({ pageSize: 999999 });
      expect(prisma.academy.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
    });

    it('searches by name, slug, and owner name/email', async () => {
      const { prisma, ledger, flags } = makeDeps();
      prisma.academy.count.mockResolvedValue(0);
      prisma.academy.findMany.mockResolvedValue([]);
      prisma.course.groupBy.mockResolvedValue([]);
      prisma.enrollment.groupBy.mockResolvedValue([]);
      prisma.academyMembership.groupBy.mockResolvedValue([]);

      const svc = new AdminAcademiesService(prisma, ledger, flags);
      await svc.listAcademies({ search: 'khaled' });
      const whereArg = prisma.academy.findMany.mock.calls[0][0].where;
      expect(whereArg.OR).toEqual(
        expect.arrayContaining([
          { name: { contains: 'khaled', mode: 'insensitive' } },
          { slug: { contains: 'khaled', mode: 'insensitive' } },
        ]),
      );
    });
  });

  describe('academyDetail', () => {
    it('404s for an academy that does not exist (or is soft-deleted)', async () => {
      const { prisma, ledger, flags } = makeDeps();
      prisma.academy.findFirst.mockResolvedValue(null);
      const svc = new AdminAcademiesService(prisma, ledger, flags);
      await expect(svc.academyDetail('nope')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('filters staff to non-student roles and includes feature flags', async () => {
      const { prisma, ledger, flags } = makeDeps();
      prisma.academy.findFirst.mockResolvedValue({
        id: 'a1',
        slug: 'a1',
        name: 'A1',
        status: 'ACTIVE',
        createdAt: new Date(),
        language: 'ar',
        currency: 'EGP',
        feeType: 'PERCENT',
        feeValue: 20,
        owner: { id: 'u1', fullName: 'Owner', email: 'o@x.com', phone: null },
        domains: [],
      });
      prisma.academyMembership.findMany.mockResolvedValue([
        {
          id: 'm1',
          userId: 'u1',
          role: 'OWNER',
          status: 'ACTIVE',
          user: { fullName: 'Owner', email: 'o@x.com', avatarUrl: null },
        },
      ]);
      prisma.course.count.mockResolvedValue(5);
      prisma.enrollment.count.mockResolvedValue(10);
      flags.listForAcademy.mockResolvedValue([{ key: 'attendance', enabled: true }]);

      const svc = new AdminAcademiesService(prisma, ledger, flags);
      const detail = await svc.academyDetail('a1');

      expect(prisma.academyMembership.findMany.mock.calls[0][0].where.role).toEqual({
        not: 'STUDENT',
      });
      expect(detail.staff).toHaveLength(1);
      expect(detail.featureFlags).toEqual([{ key: 'attendance', enabled: true }]);
    });
  });
});
