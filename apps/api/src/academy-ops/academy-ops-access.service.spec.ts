import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AcademyOpsAccessService } from './academy-ops-access.service';

function makePrisma() {
  return {
    group: { findFirst: jest.fn() },
    groupAssignment: { findFirst: jest.fn() },
  } as any;
}
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

describe('AcademyOpsAccessService.assertGroupAccess', () => {
  it('404s a group from a different academy — never reveals it exists', async () => {
    const prisma = makePrisma();
    prisma.group.findFirst.mockResolvedValue(null); // tenant-scoped query found nothing
    const svc = new AcademyOpsAccessService(prisma);
    await expect(svc.assertGroupAccess(ctx(), 'g1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.group.findFirst).toHaveBeenCalledWith({ where: { id: 'g1', academyId: 'a1' } });
  });

  it('OWNER passes without an assignment row', async () => {
    const prisma = makePrisma();
    prisma.group.findFirst.mockResolvedValue({ id: 'g1', academyId: 'a1' });
    const svc = new AcademyOpsAccessService(prisma);
    await expect(svc.assertGroupAccess(ctx({ role: 'OWNER' }), 'g1')).resolves.toEqual({
      id: 'g1',
      academyId: 'a1',
    });
    expect(prisma.groupAssignment.findFirst).not.toHaveBeenCalled();
  });

  it('TEACHER assigned to the group passes', async () => {
    const prisma = makePrisma();
    prisma.group.findFirst.mockResolvedValue({ id: 'g1', academyId: 'a1' });
    prisma.groupAssignment.findFirst.mockResolvedValue({ id: 'ga1' });
    const svc = new AcademyOpsAccessService(prisma);
    await expect(svc.assertGroupAccess(ctx({ userId: 'teacherA' }), 'g1')).resolves.toBeDefined();
    expect(prisma.groupAssignment.findFirst).toHaveBeenCalledWith({
      where: { groupId: 'g1', userId: 'teacherA' },
      select: { id: true },
    });
  });

  it('TEACHER NOT assigned to the group (even in the same academy) is refused — capability alone is not enough', async () => {
    const prisma = makePrisma();
    prisma.group.findFirst.mockResolvedValue({ id: 'g1', academyId: 'a1' }); // same academy — passes tenant check
    prisma.groupAssignment.findFirst.mockResolvedValue(null); // but not assigned to THIS group
    const svc = new AcademyOpsAccessService(prisma);
    await expect(svc.assertGroupAccess(ctx({ userId: 'teacherB' }), 'g1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('ASSISTANT not assigned is refused the same way', async () => {
    const prisma = makePrisma();
    prisma.group.findFirst.mockResolvedValue({ id: 'g1', academyId: 'a1' });
    prisma.groupAssignment.findFirst.mockResolvedValue(null);
    const svc = new AcademyOpsAccessService(prisma);
    await expect(svc.assertGroupAccess(ctx({ role: 'ASSISTANT' }), 'g1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
