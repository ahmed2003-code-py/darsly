import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CoursesService, CourseScope } from './courses.service';

/**
 * academyId = organisation the caller acts in; tenantId = who authored it.
 * The scope object is built by the controller from AcademyContext + JWT and
 * is the only thing the service trusts.
 */
const none = {} as any;
function makePrisma(kind: 'PERSONAL' | 'CENTER' = 'PERSONAL') {
  return {
    academy: {
      findUnique: jest.fn().mockResolvedValue({ id: 'centerA', kind, teacherSharePercent: null }),
    },
    academySubject: { findUnique: jest.fn().mockResolvedValue(null) },
    academyMembership: { findFirst: jest.fn().mockResolvedValue(null) },
    teacherProfile: {
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ stages: ['SECONDARY'], subjects: [{ subjectId: 'maths' }] }),
      findUnique: jest.fn().mockResolvedValue({ userId: 'tu' }),
    },
    gradeLevel: { findMany: jest.fn().mockResolvedValue([]) },
    course: {
      create: jest.fn(async ({ data }: any) => ({ id: 'new', ...data, grades: [] })),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest
        .fn()
        .mockResolvedValue({ subjectId: 'maths', examLessonId: null, grades: [] }),
      update: jest.fn(async ({ data }: any) => ({ id: 'c1', ...data, grades: [] })),
    },
    lesson: { count: jest.fn().mockResolvedValue(1) },
  } as any;
}
const svc = (prisma: any) =>
  new CoursesService(
    prisma,
    { applyToMany: async (i: unknown[]) => i } as any,
    { hiddenTeacherIds: async () => [] } as any,
    none,
    none,
    none,
    none,
    none,
    none,
  );

const teacherInCenter: CourseScope = {
  academyId: 'centerA',
  authorTenantId: 'teacherT',
  manageAll: false,
};
const ownerOfCenter: CourseScope = {
  academyId: 'centerA',
  authorTenantId: 'teacherX',
  manageAll: true,
};
const staffOwner: CourseScope = {
  academyId: 'centerA',
  authorTenantId: undefined,
  manageAll: true,
};
const personal: CourseScope = {
  academyId: 'teacherT',
  authorTenantId: 'teacherT',
  manageAll: true,
};

describe('CoursesService.create — authorship vs organisation', () => {
  it('PERSONAL: tenantId == academyId == the teacher', async () => {
    const prisma = makePrisma('PERSONAL');
    const c = await svc(prisma).create(personal, { title: 'x', priceCents: 500 } as any);
    expect(c.tenantId).toBe('teacherT');
    expect(c.academyId).toBe('teacherT');
  });

  it('CENTER: tenantId is the authoring teacher, academyId is the Center', async () => {
    const prisma = makePrisma('CENTER');
    prisma.academySubject.findUnique.mockResolvedValue({ isActive: true });
    const c = await svc(prisma).create(teacherInCenter, { title: 'x', priceCents: 0 } as any);
    expect(c.tenantId).toBe('teacherT');
    expect(c.academyId).toBe('centerA');
    expect(c.tenantId).not.toBe(c.academyId);
  });

  it('forged tenantId / academyId in the body are overridden by the scope', async () => {
    const prisma = makePrisma('CENTER');
    prisma.academySubject.findUnique.mockResolvedValue({ isActive: true });
    const c = await svc(prisma).create(teacherInCenter, {
      title: 'x',
      priceCents: 0,
      tenantId: 'victim',
      academyId: 'centerB',
    } as any);
    expect(c.tenantId).toBe('teacherT');
    expect(c.academyId).toBe('centerA');
  });

  it('a STAFF owner (no TeacherProfile) cannot author — 403, nothing written', async () => {
    const prisma = makePrisma('CENTER');
    await expect(
      svc(prisma).create(staffOwner, { title: 'x', priceCents: 0 } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.course.create).not.toHaveBeenCalled();
  });

  it('a Center course with a price but no agreed revenue split is refused', async () => {
    const prisma = makePrisma('CENTER');
    await expect(
      svc(prisma).create(teacherInCenter, { title: 'x', priceCents: 100 } as any),
    ).rejects.toMatchObject({ response: { code: 'CENTER_REVENUE_SPLIT_NOT_CONFIGURED' } });
    expect(prisma.course.create).not.toHaveBeenCalled();
  });

  it('a Center course needs a subject the Center offers', async () => {
    const prisma = makePrisma('CENTER');
    prisma.academySubject.findUnique.mockResolvedValue({ isActive: false });
    await expect(
      svc(prisma).create(teacherInCenter, { title: 'x', priceCents: 0, subjectId: 'maths' } as any),
    ).rejects.toMatchObject({ response: { code: 'SUBJECT_NOT_OFFERED' } });
  });

  it('PERSONAL is never subject-gated', async () => {
    const prisma = makePrisma('PERSONAL');
    await svc(prisma).create(personal, { title: 'x', priceCents: 0, subjectId: 'maths' } as any);
    expect(prisma.academySubject.findUnique).not.toHaveBeenCalled();
  });
});

describe('CoursesService.update — Center pricing needs an agreed revenue split', () => {
  const existing = { id: 'c1', tenantId: 'teacherT', academyId: 'centerA', priceCents: 0 };
  it('raising the price of a Center course with no agreed split is refused', async () => {
    const prisma = makePrisma('CENTER');
    prisma.course.findFirst.mockResolvedValue(existing);
    await expect(
      svc(prisma).update(teacherInCenter, 'c1', { priceCents: 250 } as any),
    ).rejects.toMatchObject({ response: { code: 'CENTER_REVENUE_SPLIT_NOT_CONFIGURED' } });
    expect(prisma.course.update).not.toHaveBeenCalled();
  });
  it('publishing a Center course that somehow carries a price with no agreed split is refused', async () => {
    const prisma = makePrisma('CENTER');
    prisma.course.findFirst.mockResolvedValue({ ...existing, priceCents: 999 });
    await expect(
      svc(prisma).update(ownerOfCenter, 'c1', { status: 'PUBLISHED' } as any),
    ).rejects.toMatchObject({ response: { code: 'CENTER_REVENUE_SPLIT_NOT_CONFIGURED' } });
  });
  it('a PERSONAL course keeps its pricing behaviour', async () => {
    const prisma = makePrisma('PERSONAL');
    prisma.course.findFirst.mockResolvedValue({ ...existing, academyId: 'teacherT' });
    await expect(
      svc(prisma).update(personal, 'c1', { priceCents: 250 } as any),
    ).resolves.toMatchObject({ priceCents: 250 });
  });
});

describe('CoursesService scope — who sees what', () => {
  it('OWNER: every course offered in the academy (academyId only)', async () => {
    const prisma = makePrisma();
    await svc(prisma).listMine(ownerOfCenter);
    expect(prisma.course.findMany.mock.calls[0][0].where).toEqual({ academyId: 'centerA' });
  });
  it('TEACHER member: only their own courses inside that academy', async () => {
    const prisma = makePrisma();
    await svc(prisma).listMine(teacherInCenter);
    expect(prisma.course.findMany.mock.calls[0][0].where).toEqual({
      academyId: 'centerA',
      tenantId: 'teacherT',
    });
  });
  it('never tenantId = ctx.academyId', async () => {
    const prisma = makePrisma();
    await svc(prisma).listMine(teacherInCenter);
    const where = prisma.course.findMany.mock.calls[0][0].where;
    expect(where.tenantId).not.toBe(where.academyId);
  });
  it('cross-academy: a Center B course id inside a Center A scope 404s (never reveals it)', async () => {
    const prisma = makePrisma();
    prisma.course.findFirst.mockResolvedValue(null); // the academyId filter excluded it
    await expect(
      svc(prisma).update(ownerOfCenter, 'courseInB', { title: 'x' } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc(prisma).remove(ownerOfCenter, 'courseInB')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    for (const call of prisma.course.findFirst.mock.calls)
      expect(call[0].where.academyId).toBe('centerA');
  });
  it("a TEACHER member cannot touch a colleague's course in the same Center", async () => {
    const prisma = makePrisma();
    prisma.course.findFirst.mockResolvedValue(null);
    await expect(svc(prisma).remove(teacherInCenter, 'colleagues')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.course.findFirst.mock.calls[0][0].where).toMatchObject({
      academyId: 'centerA',
      tenantId: 'teacherT',
    });
  });
});
