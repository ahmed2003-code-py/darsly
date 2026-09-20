import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ScheduleConflictError, SessionsService } from './sessions.service';

function ctx(overrides: Partial<{ academyId: string; userId: string; role: string }> = {}) {
  return { academyId: 'a1', userId: 'owner1', role: 'OWNER', status: 'ACTIVE', isPlatformAdmin: false, can: () => true, ...overrides } as any;
}

function makeDeps() {
  const prisma: any = {
    groupSession: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn(), update: jest.fn() },
    room: { findFirst: jest.fn() },
    groupAssignment: { findFirst: jest.fn(), findMany: jest.fn() },
    groupMembership: { findMany: jest.fn() },
  };
  const audit: any = { log: jest.fn() };
  const access: any = { assertGroupAccess: jest.fn().mockResolvedValue({ id: 'g1', academyId: 'a1' }) };
  return { prisma, audit, access };
}

describe('SessionsService', () => {
  describe('validation', () => {
    it('rejects endAt <= startAt', async () => {
      const { prisma, audit, access } = makeDeps();
      const svc = new SessionsService(prisma, access, audit);
      await expect(
        svc.create(ctx(), 'g1', { startAt: '2026-11-01T11:00:00Z', endAt: '2026-11-01T10:00:00Z' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects scheduling into an archived room', async () => {
      const { prisma, audit, access } = makeDeps();
      prisma.room.findFirst.mockResolvedValue({ id: 'r1', academyId: 'a1', status: 'ARCHIVED' });
      const svc = new SessionsService(prisma, access, audit);
      await expect(
        svc.create(ctx(), 'g1', { roomId: 'r1', startAt: '2026-11-01T10:00:00Z', endAt: '2026-11-01T11:00:00Z' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404s a room from a different academy (not just archived — genuinely not found)', async () => {
      const { prisma, audit, access } = makeDeps();
      prisma.room.findFirst.mockResolvedValue(null); // tenant-scoped query found nothing
      const svc = new SessionsService(prisma, access, audit);
      await expect(
        svc.create(ctx(), 'g1', { roomId: 'foreign-room', startAt: '2026-11-01T10:00:00Z', endAt: '2026-11-01T11:00:00Z' }),
      ).rejects.toThrow();
    });

    it('rejects a teacherUserId not assigned to this group', async () => {
      const { prisma, audit, access } = makeDeps();
      prisma.groupAssignment.findFirst.mockResolvedValue(null);
      const svc = new SessionsService(prisma, access, audit);
      await expect(
        svc.create(ctx(), 'g1', { teacherUserId: 'stranger', startAt: '2026-11-01T10:00:00Z', endAt: '2026-11-01T11:00:00Z' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('OWNER can assign themself without an explicit GroupAssignment row', async () => {
      const { prisma, audit, access } = makeDeps();
      prisma.groupSession.create.mockResolvedValue({ id: 's1' });
      const svc = new SessionsService(prisma, access, audit);
      await svc.create(ctx({ role: 'OWNER', userId: 'owner1' }), 'g1', { teacherUserId: 'owner1', startAt: '2026-11-01T10:00:00Z', endAt: '2026-11-01T11:00:00Z' });
      expect(prisma.groupAssignment.findFirst).not.toHaveBeenCalled();
    });

    it('checks group resource access before anything else', async () => {
      const { prisma, audit, access } = makeDeps();
      access.assertGroupAccess.mockRejectedValue(new ForbiddenException());
      const svc = new SessionsService(prisma, access, audit);
      await expect(
        svc.create(ctx({ role: 'TEACHER' }), 'g1', { startAt: '2026-11-01T10:00:00Z', endAt: '2026-11-01T11:00:00Z' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.room.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('conflict pre-check', () => {
    it('reports GROUP_CONFLICT when another session overlaps the same group', async () => {
      const { prisma, audit, access } = makeDeps();
      prisma.groupSession.findFirst.mockResolvedValueOnce({ id: 'other-session' }); // group check hits first
      const svc = new SessionsService(prisma, access, audit);
      try {
        await svc.create(ctx(), 'g1', { startAt: '2026-11-01T10:00:00Z', endAt: '2026-11-01T11:00:00Z' });
        fail('expected a conflict');
      } catch (e) {
        expect(e).toBeInstanceOf(ScheduleConflictError);
        expect((e as ScheduleConflictError).code).toBe('GROUP_CONFLICT');
      }
    });

    it('a ScheduleConflictError carries the conflict code and the id of the session it collides with', async () => {
      const { prisma, audit, access } = makeDeps();
      prisma.groupSession.findFirst.mockResolvedValueOnce(null); // group: clear
      prisma.room.findFirst.mockResolvedValue({ id: 'r1', academyId: 'a1', status: 'ACTIVE' });
      prisma.groupSession.findFirst.mockResolvedValueOnce({ id: 'existing-room-session' }); // room: conflict
      const svc = new SessionsService(prisma, access, audit);
      try {
        await svc.create(ctx(), 'g1', { roomId: 'r1', startAt: '2026-11-01T10:00:00Z', endAt: '2026-11-01T11:00:00Z' });
        fail('expected a conflict');
      } catch (e) {
        expect(e).toBeInstanceOf(ScheduleConflictError);
        expect((e as ScheduleConflictError).code).toBe('ROOM_CONFLICT');
        expect((e as ScheduleConflictError).conflictingSessionId).toBe('existing-room-session');
      }
    });

    it('excludes the session itself from the overlap check on update (would otherwise always conflict with its own unchanged row)', async () => {
      const { prisma, audit, access } = makeDeps();
      prisma.groupSession.findFirst
        .mockResolvedValueOnce({ id: 's1', academyId: 'a1', groupId: 'g1', roomId: null, teacherUserId: null, startAt: new Date('2026-11-01T10:00:00Z'), endAt: new Date('2026-11-01T11:00:00Z') }) // existing lookup
        .mockResolvedValueOnce(null); // group overlap check
      prisma.groupSession.update.mockResolvedValue({ id: 's1' });
      const svc = new SessionsService(prisma, access, audit);
      await svc.update(ctx(), 's1', { startAt: '2026-11-01T10:15:00Z', endAt: '2026-11-01T11:15:00Z' });

      const overlapCall = prisma.groupSession.findFirst.mock.calls[1][0];
      expect(overlapCall.where.id).toEqual({ not: 's1' });
    });
  });

  describe('translateExclusionError', () => {
    it('maps a real Postgres EXCLUDE-constraint violation to a structured ScheduleConflictError', async () => {
      const { prisma, audit, access } = makeDeps();
      const pgError = Object.create(Prisma.PrismaClientUnknownRequestError.prototype);
      pgError.message = 'conflicting key value violates exclusion constraint "GroupSession_teacher_no_overlap"';
      prisma.groupSession.create.mockRejectedValue(pgError);
      const svc = new SessionsService(prisma, access, audit);
      try {
        await svc.create(ctx(), 'g1', { teacherUserId: 'owner1', startAt: '2026-11-01T10:00:00Z', endAt: '2026-11-01T11:00:00Z' });
        fail('expected a conflict');
      } catch (e) {
        expect(e).toBeInstanceOf(ScheduleConflictError);
        expect((e as ScheduleConflictError).code).toBe('TEACHER_CONFLICT');
      }
    });

    it('rethrows an unrelated database error untouched', async () => {
      const { prisma, audit, access } = makeDeps();
      prisma.groupSession.create.mockRejectedValue(new Error('connection reset'));
      const svc = new SessionsService(prisma, access, audit);
      await expect(
        svc.create(ctx(), 'g1', { startAt: '2026-11-01T10:00:00Z', endAt: '2026-11-01T11:00:00Z' }),
      ).rejects.toThrow('connection reset');
    });
  });

  describe('schedule', () => {
    it('OWNER sees the whole academy, no group filter applied', async () => {
      const { prisma, audit, access } = makeDeps();
      prisma.groupSession.findFirst.mockResolvedValue(null);
      (prisma as any).groupSession.findMany = jest.fn().mockResolvedValue([]);
      const svc = new SessionsService(prisma, access, audit);
      await svc.schedule(ctx({ role: 'OWNER' }), new Date('2026-11-01'), new Date('2026-11-08'));
      const where = prisma.groupSession.findMany.mock.calls[0][0].where;
      expect(where.groupId).toBeUndefined();
    });

    it('TEACHER only sees sessions for groups they are assigned to', async () => {
      const { prisma, audit, access } = makeDeps();
      prisma.groupAssignment.findMany.mockResolvedValue([{ groupId: 'g1' }, { groupId: 'g2' }]);
      (prisma as any).groupSession.findMany = jest.fn().mockResolvedValue([]);
      const svc = new SessionsService(prisma, access, audit);
      await svc.schedule(ctx({ role: 'TEACHER', userId: 'teacherA' }), new Date('2026-11-01'), new Date('2026-11-08'));
      const where = prisma.groupSession.findMany.mock.calls[0][0].where;
      expect(where.groupId).toEqual({ in: ['g1', 'g2'] });
    });

    it('STUDENT only sees sessions for groups they are a member of', async () => {
      const { prisma, audit, access } = makeDeps();
      prisma.groupMembership.findMany.mockResolvedValue([{ groupId: 'g3' }]);
      (prisma as any).groupSession.findMany = jest.fn().mockResolvedValue([]);
      const svc = new SessionsService(prisma, access, audit);
      await svc.schedule(ctx({ role: 'STUDENT', userId: 'studentA' }), new Date('2026-11-01'), new Date('2026-11-08'));
      const where = prisma.groupSession.findMany.mock.calls[0][0].where;
      expect(where.groupId).toEqual({ in: ['g3'] });
    });
  });
});
