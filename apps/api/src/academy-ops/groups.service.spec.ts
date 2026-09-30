import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { GroupsService } from './groups.service';

function ctx(overrides: Partial<{ academyId: string; userId: string; role: string }> = {}) {
  return {
    academyId: 'a1',
    userId: 'u1',
    role: 'TEACHER',
    status: 'ACTIVE',
    isPlatformAdmin: false,
    can: () => true,
    ...overrides,
  } as any;
}

function makeDeps() {
  const prisma: any = {
    group: {
      count: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    groupAssignment: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
      create: jest.fn(),
    },
    groupMembership: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    studentProfile: { findMany: jest.fn() },
    academyStudent: { findMany: jest.fn() },
    enrollment: { findMany: jest.fn().mockResolvedValue([]) },
    academyMembership: { findFirst: jest.fn() },
    $transaction: jest.fn(async (arg: any) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
    ),
  };
  const audit: any = { log: jest.fn() };
  // access service backed by the same prisma mock, matching real DI wiring
  const access: any = {
    assertGroupAccess: jest.fn(async (c: any, groupId: string) => {
      const group = await prisma.group.findFirst({
        where: { id: groupId, academyId: c.academyId },
      });
      if (!group) throw new NotFoundException('Group not found');
      if (c.role !== 'OWNER') {
        const assigned = await prisma.groupAssignment.findFirst({
          where: { groupId, userId: c.userId },
        });
        if (!assigned) throw new ForbiddenException('You are not assigned to this group');
      }
      return group;
    }),
  };
  return { prisma, audit, access };
}

describe('GroupsService', () => {
  describe('list', () => {
    it('OWNER sees every group in the academy — no assignment filter applied', async () => {
      const { prisma, audit, access } = makeDeps();
      prisma.group.count.mockResolvedValue(0);
      prisma.group.findMany.mockResolvedValue([]);
      const svc = new GroupsService(prisma, access, audit, { leaveThread: () => undefined } as any);
      await svc.list(ctx({ role: 'OWNER' }), {});
      expect(prisma.group.count).toHaveBeenCalledWith({
        where: { academyId: 'a1', deletedAt: null },
      });
    });

    it('TEACHER only sees groups they are assigned to', async () => {
      const { prisma, audit, access } = makeDeps();
      prisma.group.count.mockResolvedValue(0);
      prisma.group.findMany.mockResolvedValue([]);
      const svc = new GroupsService(prisma, access, audit, { leaveThread: () => undefined } as any);
      await svc.list(ctx({ role: 'TEACHER', userId: 'teacherA' }), {});
      expect(prisma.group.count).toHaveBeenCalledWith({
        where: {
          academyId: 'a1',
          deletedAt: null,
          assignments: { some: { userId: 'teacherA', deletedAt: null } },
        },
      });
    });
  });

  describe('create', () => {
    it('assigns a TEACHER to the group they just created, in the same transaction', async () => {
      const { prisma, audit, access } = makeDeps();
      prisma.group.findFirst.mockResolvedValue(null);
      prisma.group.create.mockResolvedValue({ id: 'g1', academyId: 'a1', name: 'G1' });
      prisma.groupAssignment.create.mockResolvedValue({ id: 'ga1' });
      const svc = new GroupsService(prisma, access, audit, { leaveThread: () => undefined } as any);
      const group = await svc.create(ctx({ role: 'TEACHER', userId: 'teacherA' }), { name: 'G1' });
      expect(group.id).toBe('g1');
      expect(prisma.groupAssignment.create).toHaveBeenCalledWith({
        data: { groupId: 'g1', userId: 'teacherA', academyId: 'a1', role: 'TEACHER' },
      });
    });

    it('does not assign an OWNER to every group they create', async () => {
      const { prisma, audit, access } = makeDeps();
      prisma.group.findFirst.mockResolvedValue(null);
      prisma.group.create.mockResolvedValue({ id: 'g1', academyId: 'a1', name: 'G1' });
      const svc = new GroupsService(prisma, access, audit, { leaveThread: () => undefined } as any);
      await svc.create(ctx({ role: 'OWNER' }), { name: 'G1' });
      expect(prisma.groupAssignment.create).not.toHaveBeenCalled();
    });

    it('refuses a second live group with the same name — the duplicate that appeared when create was invisible to its author', async () => {
      const { prisma, audit, access } = makeDeps();
      prisma.group.findFirst.mockResolvedValue({ id: 'existing' });
      const svc = new GroupsService(prisma, access, audit, { leaveThread: () => undefined } as any);
      await expect(svc.create(ctx({ role: 'TEACHER' }), { name: 'G1' })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.group.create).not.toHaveBeenCalled();
    });
  });

  describe('addMembers', () => {
    it("rejects a student who is not on this academy's register", async () => {
      const { prisma, audit, access } = makeDeps();
      prisma.group.findFirst.mockResolvedValue({ id: 'g1', academyId: 'a1' });
      // s2 has no register row here and no enrollment = not this academy's student
      prisma.academyStudent.findMany.mockResolvedValue([{ studentId: 's1', status: 'ACTIVE' }]);
      const svc = new GroupsService(prisma, access, audit, { leaveThread: () => undefined } as any);
      await expect(
        svc.addMembers(ctx({ role: 'OWNER' }), 'g1', { studentIds: ['s1', 's2'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a student who withdrew from this academy (reactivate first)', async () => {
      const { prisma, audit, access } = makeDeps();
      prisma.group.findFirst.mockResolvedValue({ id: 'g1', academyId: 'a1' });
      prisma.academyStudent.findMany.mockResolvedValue([{ studentId: 's1', status: 'WITHDRAWN' }]);
      const svc = new GroupsService(prisma, access, audit, { leaveThread: () => undefined } as any);
      await expect(
        svc.addMembers(ctx({ role: 'OWNER' }), 'g1', { studentIds: ['s1'] }),
      ).rejects.toMatchObject({ response: { code: 'STUDENT_WITHDRAWN' } });
    });

    it('refuses a teacher not assigned to the group before even checking students', async () => {
      const { prisma, audit, access } = makeDeps();
      access.assertGroupAccess.mockRejectedValue(new ForbiddenException());
      const svc = new GroupsService(prisma, access, audit, { leaveThread: () => undefined } as any);
      await expect(svc.addMembers(ctx(), 'g1', { studentIds: ['s1'] })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.academyStudent.findMany).not.toHaveBeenCalled();
    });
  });

  describe('assignStaff', () => {
    it('refuses a non-OWNER even with group.manage and even if assigned to the group', async () => {
      const { prisma, audit, access } = makeDeps();
      prisma.group.findFirst.mockResolvedValue({ id: 'g1', academyId: 'a1' });
      const svc = new GroupsService(prisma, access, audit, { leaveThread: () => undefined } as any);
      await expect(
        svc.assignStaff(ctx({ role: 'TEACHER' }), 'g1', { userId: 'u2', role: 'ASSISTANT' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404s a cross-academy group id for assignment too (checked independently of OWNER-only rule)', async () => {
      const { prisma, audit, access } = makeDeps();
      prisma.group.findFirst.mockResolvedValue(null);
      const svc = new GroupsService(prisma, access, audit, { leaveThread: () => undefined } as any);
      await expect(
        svc.assignStaff(ctx({ role: 'OWNER' }), 'g1', { userId: 'u2', role: 'TEACHER' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses assigning a user who is not active staff of this academy', async () => {
      const { prisma, audit, access } = makeDeps();
      prisma.group.findFirst.mockResolvedValue({ id: 'g1', academyId: 'a1' });
      prisma.academyMembership.findFirst.mockResolvedValue(null);
      const svc = new GroupsService(prisma, access, audit, { leaveThread: () => undefined } as any);
      await expect(
        svc.assignStaff(ctx({ role: 'OWNER' }), 'g1', { userId: 'stranger', role: 'TEACHER' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('OWNER assigning legitimate staff succeeds', async () => {
      const { prisma, audit, access } = makeDeps();
      prisma.group.findFirst.mockResolvedValue({ id: 'g1', academyId: 'a1' });
      prisma.academyMembership.findFirst.mockResolvedValue({ id: 'm1' });
      prisma.groupAssignment.upsert.mockResolvedValue({
        id: 'ga1',
        groupId: 'g1',
        userId: 'u2',
        role: 'TEACHER',
      });
      const svc = new GroupsService(prisma, access, audit, { leaveThread: () => undefined } as any);
      const result = await svc.assignStaff(ctx({ role: 'OWNER' }), 'g1', {
        userId: 'u2',
        role: 'TEACHER',
      });
      expect(result.userId).toBe('u2');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'group.assignment.set', academyId: 'a1' }),
      );
    });
  });
});
