import { AcademyService } from './academy.service';

function makePrisma() {
  return {
    user: { findUnique: jest.fn() },
    academy: { findUnique: jest.fn() },
    academyMembership: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
    },
    groupAssignment: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    groupSession: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    liveSession: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
  } as any;
}

const liveMembership = (over: Record<string, unknown> = {}) => ({
  id: 'm1',
  userId: 'u1',
  academyId: 'a1',
  role: 'TEACHER',
  status: 'ACTIVE',
  permissions: [],
  deletedAt: null,
  user: { isActive: true, role: 'TEACHER', teacherProfile: { status: 'APPROVED' } },
  academy: { status: 'ACTIVE', deletedAt: null },
  ...over,
});

describe('AcademyService.buildContext — membership is necessary, not sufficient', () => {
  it('SUPER_ADMIN gets a platform-admin OWNER context without any membership lookup', async () => {
    const prisma = makePrisma();
    const ctx = await new AcademyService(prisma).buildContext('admin', 'a1', 'SUPER_ADMIN');
    expect(ctx?.isPlatformAdmin).toBe(true);
    expect(ctx?.role).toBe('OWNER');
    expect(prisma.academyMembership.findFirst).not.toHaveBeenCalled();
  });

  it('queries only ACTIVE, non-soft-deleted rows (findFirst, never findUnique)', async () => {
    const prisma = makePrisma();
    prisma.academyMembership.findFirst.mockResolvedValue(liveMembership());
    const ctx = await new AcademyService(prisma).buildContext('u1', 'a1', 'TEACHER');
    expect(ctx?.role).toBe('TEACHER');
    expect(prisma.academyMembership.findUnique).not.toHaveBeenCalled();
    const where = prisma.academyMembership.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({
      userId: 'u1',
      academyId: 'a1',
      status: 'ACTIVE',
      deletedAt: null,
    });
  });

  it.each([
    [
      'inactive user',
      liveMembership({
        user: { isActive: false, role: 'TEACHER', teacherProfile: { status: 'APPROVED' } },
      }),
    ],
    ['suspended academy', liveMembership({ academy: { status: 'SUSPENDED', deletedAt: null } })],
    ['archived academy', liveMembership({ academy: { status: 'ARCHIVED', deletedAt: null } })],
    [
      'soft-deleted academy',
      liveMembership({ academy: { status: 'ACTIVE', deletedAt: new Date() } }),
    ],
    [
      'suspended teacher identity',
      liveMembership({
        user: { isActive: true, role: 'TEACHER', teacherProfile: { status: 'SUSPENDED' } },
      }),
    ],
    [
      'teacher identity with no profile',
      liveMembership({ user: { isActive: true, role: 'TEACHER', teacherProfile: null } }),
    ],
  ])('refuses a context for: %s', async (_label, row) => {
    const prisma = makePrisma();
    prisma.academyMembership.findFirst.mockResolvedValue(row);
    expect(await new AcademyService(prisma).buildContext('u1', 'a1', 'TEACHER')).toBeNull();
  });

  it('a PENDING academy (teacher awaiting approval, mirrored) is not itself a blocker', async () => {
    const prisma = makePrisma();
    prisma.academyMembership.findFirst.mockResolvedValue(
      liveMembership({ academy: { status: 'PENDING', deletedAt: null } }),
    );
    expect(await new AcademyService(prisma).buildContext('u1', 'a1', 'TEACHER')).not.toBeNull();
  });

  it('a STUDENT-role membership yields a context with no capabilities', async () => {
    const prisma = makePrisma();
    prisma.academyMembership.findFirst.mockResolvedValue(
      liveMembership({
        role: 'STUDENT',
        permissions: ['member.manage'],
        user: { isActive: true, role: 'STUDENT', teacherProfile: null },
      }),
    );
    const ctx = await new AcademyService(prisma).buildContext('u1', 'a1', 'STUDENT');
    expect(ctx?.can('member.manage')).toBe(false);
    expect(ctx?.can('course.write')).toBe(false);
  });
});

describe('AcademyService.addMember — identity eligibility', () => {
  const setup = (user: Record<string, unknown>) => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({ id: 'u2', ...user });
    prisma.academyMembership.findUnique.mockResolvedValue(null);
    prisma.academyMembership.upsert.mockResolvedValue({ id: 'm2', status: 'INVITED' });
    return prisma;
  };

  it('refuses a STUDENT identity for any staff role', async () => {
    const prisma = setup({ role: 'STUDENT', isActive: true, teacherProfile: null });
    await expect(
      new AcademyService(prisma).addMember('a1', { email: 'x@y.z', role: 'TEACHER' }),
    ).rejects.toMatchObject({ response: { code: 'STUDENT_NOT_STAFF' } });
    expect(prisma.academyMembership.upsert).not.toHaveBeenCalled();
  });

  it('refuses an unapproved teacher', async () => {
    const prisma = setup({
      role: 'TEACHER',
      isActive: true,
      teacherProfile: { status: 'PENDING' },
    });
    await expect(
      new AcademyService(prisma).addMember('a1', { email: 'x@y.z', role: 'ASSISTANT' }),
    ).rejects.toMatchObject({ response: { code: 'TEACHER_NOT_APPROVED' } });
  });

  it('refuses a disabled account', async () => {
    const prisma = setup({
      role: 'TEACHER',
      isActive: false,
      teacherProfile: { status: 'APPROVED' },
    });
    await expect(
      new AcademyService(prisma).addMember('a1', { email: 'x@y.z', role: 'TEACHER' }),
    ).rejects.toMatchObject({ response: { code: 'USER_INACTIVE' } });
  });

  it('accepts an approved teacher and creates the row INVITED, never ACTIVE', async () => {
    const prisma = setup({
      role: 'TEACHER',
      isActive: true,
      teacherProfile: { status: 'APPROVED' },
    });
    await new AcademyService(prisma).addMember('a1', { email: 'x@y.z', role: 'TEACHER' });
    expect(prisma.academyMembership.upsert.mock.calls[0][0].create).toMatchObject({
      status: 'INVITED',
      role: 'TEACHER',
    });
  });
});

describe('AcademyService — membership lifecycle', () => {
  const manageable = (status: string) => ({
    id: 'm1',
    userId: 'u1',
    academyId: 'a1',
    role: 'TEACHER',
    status,
  });
  const setup = (row: Record<string, unknown>) => {
    const prisma = makePrisma();
    prisma.academyMembership.findFirst.mockResolvedValue(row);
    prisma.academy.findUnique.mockResolvedValue({ ownerUserId: 'owner' });
    prisma.academyMembership.update.mockResolvedValue({
      id: 'm1',
      role: 'TEACHER',
      status: 'ACTIVE',
      userId: 'u1',
    });
    return prisma;
  };

  it.each(['LEFT', 'INVITED'])(
    'updateMember cannot resurrect a %s row to ACTIVE',
    async (status) => {
      const prisma = setup(manageable(status));
      await expect(
        new AcademyService(prisma).updateMember('a1', 'm1', { status: 'ACTIVE' }),
      ).rejects.toMatchObject({ response: { code: 'REINVITE_REQUIRED' } });
      expect(prisma.academyMembership.update).not.toHaveBeenCalled();
    },
  );

  it('updateMember may un-suspend (SUSPENDED → ACTIVE)', async () => {
    const prisma = setup(manageable('SUSPENDED'));
    await expect(
      new AcademyService(prisma).updateMember('a1', 'm1', { status: 'ACTIVE' }),
    ).resolves.toMatchObject({ status: 'ACTIVE' });
  });

  it('suspending a member revokes their group scope', async () => {
    const prisma = setup(manageable('ACTIVE'));
    prisma.academyMembership.update.mockResolvedValue({
      id: 'm1',
      role: 'TEACHER',
      status: 'SUSPENDED',
      userId: 'u1',
    });
    await new AcademyService(prisma).updateMember('a1', 'm1', { status: 'SUSPENDED' });
    expect(prisma.groupAssignment.deleteMany).toHaveBeenCalledWith({
      where: { academyId: 'a1', userId: 'u1' },
    });
    expect(prisma.groupSession.updateMany.mock.calls[0][0]).toMatchObject({
      where: { academyId: 'a1', teacherUserId: 'u1', status: 'SCHEDULED' },
      data: { teacherUserId: null },
    });
  });

  it('removing a member sets LEFT and cleans assignments + future sessions in that academy only', async () => {
    const prisma = setup(manageable('ACTIVE'));
    await new AcademyService(prisma).removeMember('a1', 'm1');
    expect(prisma.academyMembership.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { status: 'LEFT' },
    });
    expect(prisma.groupAssignment.deleteMany).toHaveBeenCalledWith({
      where: { academyId: 'a1', userId: 'u1' },
    });
    const sess = prisma.groupSession.updateMany.mock.calls[0][0];
    expect(sess.where.academyId).toBe('a1');
    expect(sess.where.startAt.gt).toBeInstanceOf(Date);
  });

  it('the owner can never be removed or downgraded', async () => {
    const prisma = setup({ ...manageable('ACTIVE'), role: 'OWNER' });
    await expect(new AcademyService(prisma).removeMember('a1', 'm1')).rejects.toBeDefined();
    await expect(
      new AcademyService(prisma).updateMember('a1', 'm1', { role: 'ASSISTANT' }),
    ).rejects.toBeDefined();
    expect(prisma.groupAssignment.deleteMany).not.toHaveBeenCalled();
  });
});
