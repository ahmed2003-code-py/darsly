import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { LiveScope, LiveService } from './live.service';
import { AcademyService } from '../academy/academy.service';
import { dailyProviders } from './providers/testing';

function makePrisma() {
  return {
    liveSession: {
      create: jest.fn(async ({ data }: any) => ({ id: 'ls', ...data })),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(async ({ data }: any) => ({ id: 'ls', ...data })),
    },
    groupSession: { findFirst: jest.fn().mockResolvedValue(null) },
    group: { findFirst: jest.fn().mockResolvedValue({ id: 'g1' }) },
    groupAssignment: { findFirst: jest.fn().mockResolvedValue({ id: 'ga' }) },
    groupMembership: { findMany: jest.fn().mockResolvedValue([]) },
    enrollment: { findMany: jest.fn().mockResolvedValue([]) },
  } as any;
}
const academyMock = () =>
  ({
    assertAssignableTeacher: jest.fn(async (_a: string, userId: string) => ({
      userId,
      teacherProfileId: `tp_${userId}`,
    })),
  }) as any;
const svc = (prisma: any, academy = academyMock()) =>
  new LiveService(
    prisma,
    { create: jest.fn() } as any,
    {} as any,
    dailyProviders({}),
    {} as any,
    {} as any,
    academy,
  );
const ownerCtx: LiveScope = {
  academyId: 'centerA',
  userId: 'ownerU',
  manageAll: true,
  role: 'OWNER',
};
const teacherCtx: LiveScope = {
  academyId: 'centerA',
  userId: 'tA',
  manageAll: false,
  role: 'TEACHER',
};
const staffCtx: LiveScope = {
  academyId: 'centerA',
  userId: 'staffU',
  manageAll: true,
  role: 'OWNER',
};
const dto = { title: 'Algebra', startsAt: '2026-11-01T10:00:00Z', durationMin: 60 };

describe('LiveService.create — organisation, teacher and group scope', () => {
  it('a teacher creating in a Center: tenantId = own profile (authorship), academyId = Center, teacherUserId = self', async () => {
    const prisma = makePrisma();
    const s = await svc(prisma).create(teacherCtx, dto);
    expect(s).toMatchObject({
      tenantId: 'tp_tA',
      academyId: 'centerA',
      teacherUserId: 'tA',
      groupId: null,
    });
    expect(s.tenantId).not.toBe(s.academyId);
  });
  it('STAFF must name a teacher — the named teacher becomes author, STAFF never does', async () => {
    const prisma = makePrisma();
    const academy = academyMock();
    const s = await svc(prisma, academy).create(staffCtx, { ...dto, teacherUserId: 'tB' });
    expect(academy.assertAssignableTeacher).toHaveBeenCalledWith('centerA', 'tB');
    expect(s).toMatchObject({ tenantId: 'tp_tB', teacherUserId: 'tB' });
  });
  it('STAFF without a named teacher is refused by the identity check (self is not a teacher)', async () => {
    const prisma = makePrisma();
    const academy = academyMock();
    academy.assertAssignableTeacher.mockRejectedValue(
      new BadRequestException({ code: 'TEACHER_NOT_ASSIGNABLE' }),
    );
    await expect(svc(prisma, academy).create(staffCtx, dto)).rejects.toMatchObject({
      response: { code: 'TEACHER_NOT_ASSIGNABLE' },
    });
    expect(prisma.liveSession.create).not.toHaveBeenCalled();
  });
  it('a forged teacherUserId from another Center is refused', async () => {
    const prisma = makePrisma();
    const academy = academyMock();
    academy.assertAssignableTeacher.mockRejectedValue(
      new BadRequestException({ code: 'TEACHER_NOT_MEMBER' }),
    );
    await expect(
      svc(prisma, academy).create(ownerCtx, { ...dto, teacherUserId: 'teacherOfB' }),
    ).rejects.toMatchObject({ response: { code: 'TEACHER_NOT_MEMBER' } });
  });
  it('a group must belong to this Center and the teacher must be assigned to it', async () => {
    const prisma = makePrisma();
    prisma.group.findFirst.mockResolvedValue(null);
    await expect(
      svc(prisma).create(teacherCtx, { ...dto, groupId: 'groupOfB' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.group.findFirst.mock.calls[0][0].where).toEqual({
      id: 'groupOfB',
      academyId: 'centerA',
    });
    prisma.group.findFirst.mockResolvedValue({ id: 'g1' });
    prisma.groupAssignment.findFirst.mockResolvedValue(null);
    await expect(svc(prisma).create(teacherCtx, { ...dto, groupId: 'g1' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
  it('a physical slot of the same teacher in the window blocks the stream (cross-table)', async () => {
    const prisma = makePrisma();
    prisma.groupSession.findFirst.mockResolvedValue({ id: 'gs', academyId: 'centerA' });
    const err = await svc(prisma)
      .create(teacherCtx, dto)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.response).toMatchObject({ code: 'TEACHER_CONFLICT', conflictingSessionId: 'gs' });
  });
  it('a collision in another academy hides its id', async () => {
    const prisma = makePrisma();
    prisma.groupSession.findFirst.mockResolvedValue({ id: 'secret', academyId: 'centerB' });
    const err = await svc(prisma)
      .create(teacherCtx, dto)
      .catch((e) => e);
    expect(err.response.conflictingSessionId).toBeUndefined();
  });
});

describe('LiveService scope — who reaches which streams', () => {
  it('OWNER lists every stream of the academy; a TEACHER only their own', async () => {
    const prisma = makePrisma();
    await svc(prisma).listForTeacher(ownerCtx);
    expect(prisma.liveSession.findMany.mock.calls[0][0].where).toEqual({ academyId: 'centerA' });
    await svc(prisma).listForTeacher(teacherCtx);
    expect(prisma.liveSession.findMany.mock.calls[1][0].where).toEqual({
      academyId: 'centerA',
      teacherUserId: 'tA',
    });
  });
  it('a stream of another Center (or a colleague, for a teacher) 404s on update/remove', async () => {
    const prisma = makePrisma();
    await expect(
      svc(prisma).update({ ...ownerCtx, academyId: 'centerB' }, 'ls', { title: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.liveSession.findFirst.mock.calls[0][0].where).toMatchObject({
      id: 'ls',
      academyId: 'centerB',
    });
    await expect(svc(prisma).remove(teacherCtx, 'ls')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.liveSession.findFirst.mock.calls[1][0].where).toMatchObject({
      id: 'ls',
      academyId: 'centerA',
      teacherUserId: 'tA',
    });
  });
  it('never scopes by tenantId = ctx.academyId', async () => {
    const prisma = makePrisma();
    await svc(prisma).listForTeacher(ownerCtx);
    expect(prisma.liveSession.findMany.mock.calls[0][0].where.tenantId).toBeUndefined();
  });
});

describe('AcademyService.assertAssignableTeacher — the one identity check', () => {
  const make = (user: any, membership: any) =>
    new AcademyService({
      user: { findFirst: jest.fn().mockResolvedValue(user) },
      academyMembership: { findFirst: jest.fn().mockResolvedValue(membership) },
    } as any);
  const approved = { id: 'u', role: 'TEACHER', teacherProfile: { id: 'tp', status: 'APPROVED' } };
  it('approved TEACHER with ACTIVE TEACHER/OWNER membership passes and yields the profile', async () => {
    await expect(make(approved, { id: 'm' }).assertAssignableTeacher('c', 'u')).resolves.toEqual({
      userId: 'u',
      teacherProfileId: 'tp',
    });
  });
  it.each([
    ['STAFF (no profile)', { id: 'u', role: 'STAFF', teacherProfile: null }],
    ['STUDENT', { id: 'u', role: 'STUDENT', teacherProfile: null }],
    [
      'PENDING teacher',
      { id: 'u', role: 'TEACHER', teacherProfile: { id: 'tp', status: 'PENDING' } },
    ],
    [
      'SUSPENDED teacher',
      { id: 'u', role: 'TEACHER', teacherProfile: { id: 'tp', status: 'SUSPENDED' } },
    ],
    [
      'REJECTED teacher',
      { id: 'u', role: 'TEACHER', teacherProfile: { id: 'tp', status: 'REJECTED' } },
    ],
    ['inactive / missing user', null],
  ])('%s → TEACHER_NOT_ASSIGNABLE', async (_l, user) => {
    await expect(make(user, { id: 'm' }).assertAssignableTeacher('c', 'u')).rejects.toMatchObject({
      response: { code: 'TEACHER_NOT_ASSIGNABLE' },
    });
  });
  it('an approved teacher of ANOTHER Center (no ACTIVE membership here) → TEACHER_NOT_MEMBER', async () => {
    const s = make(approved, null);
    await expect(s.assertAssignableTeacher('centerA', 'u')).rejects.toMatchObject({
      response: { code: 'TEACHER_NOT_MEMBER' },
    });
    expect((s as any).prisma.academyMembership.findFirst.mock.calls[0][0].where).toMatchObject({
      userId: 'u',
      academyId: 'centerA',
      status: 'ACTIVE',
      role: { in: ['TEACHER', 'OWNER'] },
    });
  });
});

describe('membership removal — future live streams lose the teacher, history stays', () => {
  it('revokeStaffResources clears future SCHEDULED LiveSession.teacherUserId in that academy only, never tenantId', async () => {
    const prisma: any = {
      academyMembership: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'm',
          userId: 'tA',
          academyId: 'centerA',
          role: 'TEACHER',
          status: 'ACTIVE',
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      academy: { findUnique: jest.fn().mockResolvedValue({ ownerUserId: 'owner' }) },
      groupAssignment: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      groupSession: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      liveSession: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    await new AcademyService(prisma).removeMember('centerA', 'm');
    const call = prisma.liveSession.updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({
      academyId: 'centerA',
      teacherUserId: 'tA',
      status: 'SCHEDULED',
    });
    expect(call.where.startsAt.gt).toBeInstanceOf(Date);
    expect(call.data).toEqual({ teacherUserId: null });
    expect(JSON.stringify(call.data)).not.toContain('tenantId');
  });
});
