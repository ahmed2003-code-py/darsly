import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AttendanceService } from './attendance.service';

function ctx(overrides: Partial<{ academyId: string; userId: string; role: string }> = {}) {
  return { academyId: 'a1', userId: 'u1', role: 'TEACHER', status: 'ACTIVE', isPlatformAdmin: false, can: () => true, ...overrides } as any;
}

function makeDeps() {
  const prisma: any = {
    groupMembership: { findMany: jest.fn() },
    attendanceSession: { findUnique: jest.fn(), upsert: jest.fn() },
    attendanceRecord: { upsert: jest.fn(), findMany: jest.fn() },
    groupAssignment: { findMany: jest.fn() },
    $transaction: jest.fn((ops: any[]) => Promise.all(ops)),
  };
  const audit: any = { log: jest.fn() };
  const access: any = { assertGroupAccess: jest.fn().mockResolvedValue({ id: 'g1', academyId: 'a1' }) };
  return { prisma, audit, access };
}

describe('AttendanceService', () => {
  describe('mark', () => {
    it('rejects a record for a student who is not a member of this group', async () => {
      const { prisma, audit, access } = makeDeps();
      prisma.groupMembership.findMany.mockResolvedValue([{ studentId: 's1' }]);
      const svc = new AttendanceService(prisma, access, audit);
      await expect(
        svc.mark(ctx(), 'g1', { date: '2026-09-20', records: [{ studentId: 's2', status: 'PRESENT' }] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.attendanceSession.upsert).not.toHaveBeenCalled();
    });

    it('checks group access before touching any attendance data', async () => {
      const { prisma, audit, access } = makeDeps();
      access.assertGroupAccess.mockRejectedValue(new ForbiddenException());
      const svc = new AttendanceService(prisma, access, audit);
      await expect(
        svc.mark(ctx(), 'g1', { date: '2026-09-20', records: [{ studentId: 's1', status: 'PRESENT' }] }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.groupMembership.findMany).not.toHaveBeenCalled();
    });

    it('upserts one session and one record per student, audits with the count', async () => {
      const { prisma, audit, access } = makeDeps();
      prisma.groupMembership.findMany.mockResolvedValueOnce([{ studentId: 's1' }, { studentId: 's2' }]);
      prisma.attendanceSession.upsert.mockResolvedValue({ id: 'sess1' });
      prisma.groupMembership.findMany.mockResolvedValueOnce([]); // sessionFor's re-fetch after marking
      prisma.attendanceSession.findUnique.mockResolvedValue({ id: 'sess1', records: [] });

      const svc = new AttendanceService(prisma, access, audit);
      await svc.mark(ctx(), 'g1', {
        date: '2026-09-20',
        records: [{ studentId: 's1', status: 'PRESENT' }, { studentId: 's2', status: 'ABSENT' }],
      });

      expect(prisma.attendanceSession.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { groupId_date: { groupId: 'g1', date: new Date('2026-09-20') } } }),
      );
      expect(prisma.attendanceRecord.upsert).toHaveBeenCalledTimes(2);
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'attendance.mark', meta: expect.objectContaining({ count: 2 }) }));
    });
  });

  describe('studentHistory', () => {
    it('OWNER sees history across every group', async () => {
      const { prisma, audit, access } = makeDeps();
      prisma.attendanceRecord.findMany.mockResolvedValue([]);
      const svc = new AttendanceService(prisma, access, audit);
      await svc.studentHistory(ctx({ role: 'OWNER' }), 's1');
      expect(prisma.groupAssignment.findMany).not.toHaveBeenCalled();
      const call = prisma.attendanceRecord.findMany.mock.calls[0][0];
      expect(call.where.session).toBeUndefined();
    });

    it('non-OWNER only sees history from groups they are assigned to', async () => {
      const { prisma, audit, access } = makeDeps();
      prisma.groupAssignment.findMany.mockResolvedValue([{ groupId: 'g1' }, { groupId: 'g2' }]);
      prisma.attendanceRecord.findMany.mockResolvedValue([]);
      const svc = new AttendanceService(prisma, access, audit);
      await svc.studentHistory(ctx({ role: 'TEACHER', userId: 'teacherA' }), 's1');
      const call = prisma.attendanceRecord.findMany.mock.calls[0][0];
      expect(call.where.session).toEqual({ groupId: { in: ['g1', 'g2'] } });
    });
  });
});
