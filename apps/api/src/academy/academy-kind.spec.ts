import { ConflictException, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AcademyService } from './academy.service';
import { AuthService } from '../auth/auth.service';
import { RolesGuard } from '../common/guards/roles.guard';
import { ROLES_KEY } from '../common/decorators/roles.decorator';

// ── Center rename never touches the admin's /t/:slug; personal rename still syncs ──

function renamePrisma(kind: 'PERSONAL' | 'CENTER') {
  return {
    academy: {
      findFirst: jest.fn().mockResolvedValue(null), // slug free among academies
      findUnique: jest.fn().mockResolvedValue({ ownerUserId: 'owner', kind }),
      update: jest.fn().mockResolvedValue({ id: 'a1' }),
    },
    teacherProfile: {
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  } as any;
}

describe('AcademyService.updateSettings — slug sync by kind', () => {
  it('a PERSONAL academy rename moves the teacher slug with it (existing behaviour)', async () => {
    const prisma = renamePrisma('PERSONAL');
    await new AcademyService(prisma).updateSettings('a1', { slug: 'new-name' } as any);
    expect(prisma.teacherProfile.updateMany).toHaveBeenCalledWith({
      where: { userId: 'owner' },
      data: { slug: 'new-name' },
    });
  });

  it("a CENTER rename never rewrites its admin's /t/:slug", async () => {
    const prisma = renamePrisma('CENTER');
    await new AcademyService(prisma).updateSettings('c1', { slug: 'new-center' } as any);
    expect(prisma.teacherProfile.updateMany).not.toHaveBeenCalled();
    expect(prisma.academy.update).toHaveBeenCalled();
  });

  it('a CENTER cannot take a slug a teacher already holds', async () => {
    const prisma = renamePrisma('CENTER');
    prisma.teacherProfile.findFirst.mockResolvedValue({ id: 't' });
    await expect(
      new AcademyService(prisma).updateSettings('c1', { slug: 'ahmed' } as any),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

// ── Teacher signup must not collide with a Center's slug either ──

describe('AuthService slug derivation at teacher signup', () => {
  it('skips a candidate held by an Academy (Center) even when no teacher has it', async () => {
    const prisma = {
      teacherProfile: { findUnique: jest.fn().mockResolvedValue(null) },
      academy: {
        findUnique: jest.fn().mockResolvedValueOnce({ id: 'center' }).mockResolvedValue(null),
      },
    } as any;
    const svc: any = new AuthService(prisma, {} as any, {} as any, {} as any);
    const slug = await svc.uniqueSlug('ahmed@x.com', 'Ahmed');
    expect(slug).not.toBe('ahmed');
    expect(slug.startsWith('ahmed-')).toBe(true);
    expect(prisma.academy.findUnique).toHaveBeenCalledWith({
      where: { slug: 'ahmed' },
      select: { id: true },
    });
  });
});

// ── STAFF identity through buildContext and the login gate ──

describe('STAFF identity', () => {
  const row = (over: Record<string, unknown>) => ({
    id: 'm',
    userId: 'u',
    academyId: 'c',
    role: 'OWNER',
    status: 'ACTIVE',
    permissions: [],
    deletedAt: null,
    user: { isActive: true, role: 'STAFF', teacherProfile: null },
    academy: { status: 'ACTIVE', deletedAt: null },
    ...over,
  });

  it('a STAFF OWNER gets a full OWNER context with no TeacherProfile at all', async () => {
    const prisma = {
      academyMembership: { findFirst: jest.fn().mockResolvedValue(row({})) },
    } as any;
    const ctx = await new AcademyService(prisma).buildContext('u', 'c', 'STAFF');
    expect(ctx?.role).toBe('OWNER');
    expect(ctx?.can('member.manage')).toBe(true);
    expect(ctx?.isPlatformAdmin).toBe(false);
  });

  it('a suspended Center refuses its admin on the next request, without touching identities', async () => {
    const prisma = {
      academyMembership: {
        findFirst: jest
          .fn()
          .mockResolvedValue(row({ academy: { status: 'SUSPENDED', deletedAt: null } })),
      },
    } as any;
    expect(await new AcademyService(prisma).buildContext('u', 'c', 'STAFF')).toBeNull();
  });

  it('a STAFF admin has no context in a PERSONAL teacher academy they are not a member of', async () => {
    const prisma = { academyMembership: { findFirst: jest.fn().mockResolvedValue(null) } } as any;
    expect(
      await new AcademyService(prisma).buildContext('u', 'personal-of-teacher', 'STAFF'),
    ).toBeNull();
  });

  it('STAFF login is gated only on isActive — no teacher approval, no student cap', () => {
    const svc: any = new AuthService({} as any, {} as any, {} as any, {} as any);
    expect(() =>
      svc.assertLoginAllowed({ isActive: true, role: 'STAFF', teacherProfile: null }),
    ).not.toThrow();
    expect(() =>
      svc.assertLoginAllowed({ isActive: false, role: 'STAFF', teacherProfile: null }),
    ).toThrow(ForbiddenException);
  });

  it('addMember still refuses STAFF for TEACHER/ASSISTANT roles (authorship needs a teacher)', async () => {
    const prisma = {
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 's', role: 'STAFF', isActive: true, teacherProfile: null }),
      },
      academyMembership: { findUnique: jest.fn(), upsert: jest.fn() },
    } as any;
    await expect(
      new AcademyService(prisma).addMember('c', { email: 's@x', role: 'TEACHER' }),
    ).rejects.toMatchObject({ response: { code: 'TEACHER_NOT_APPROVED' } });
    expect(prisma.academyMembership.upsert).not.toHaveBeenCalled();
  });
});

// ── Only SUPER_ADMIN reaches the Center creation route ──

describe('RolesGuard on @Roles(SUPER_ADMIN) (admin/centers)', () => {
  const guardFor = (role: string) => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(['SUPER_ADMIN']),
    } as unknown as Reflector;
    const ctx = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => ({ user: { sub: 'x', role } }) }),
    } as unknown as ExecutionContext;
    return () => new RolesGuard(reflector).canActivate(ctx);
  };
  it.each(['STAFF', 'TEACHER', 'STUDENT'])('%s is refused', (role) => {
    expect(guardFor(role)).toThrow(ForbiddenException);
  });
  it('SUPER_ADMIN passes', () => {
    expect(guardFor('SUPER_ADMIN')()).toBe(true);
  });
  it('uses the shared metadata key', () => {
    expect(ROLES_KEY).toBeTruthy();
  });
});
