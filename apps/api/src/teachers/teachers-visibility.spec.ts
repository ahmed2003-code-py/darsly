import { NotFoundException } from '@nestjs/common';
import { TeachersService } from './teachers.service';

/**
 * What the public teacher pages are allowed to show.
 *
 * `teachers` was 300 lines of service with no spec, and it is the module whose
 * mistakes are visible to the entire internet: an unapproved teacher, a
 * disabled account or an unpublished course appearing on a page anyone can
 * open. Four filters do that work, every one of them a `where` clause that a
 * refactor can drop without anything failing to compile.
 *
 * So these tests assert the filters themselves rather than the rows that come
 * back. A test that only checked the returned data would pass against a stub
 * that happened to return nothing.
 */
function makePrisma(teacher: unknown = baseTeacher()) {
  return {
    teacherProfile: {
      findFirst: jest.fn().mockResolvedValue(teacher),
      findMany: jest.fn().mockResolvedValue([]),
    },
    review: { aggregate: jest.fn().mockResolvedValue({ _avg: { rating: null }, _count: 0 }), findMany: jest.fn().mockResolvedValue([]) },
    enrollment: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
    // viewerGrade() reads the student with findFirst (catalog/stage.util.ts:63).
    studentProfile: { findFirst: jest.fn().mockResolvedValue(null) },
    course: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    gradeLevel: { findUnique: jest.fn().mockResolvedValue(null) },
  } as any;
}

function baseTeacher() {
  return {
    id: 'teacherA',
    slug: 'ms-amal',
    user: { fullName: 'Amal', avatarUrl: null, ownedAcademies: [] },
    subjects: [],
    grades: [],
    courses: [],
    verifiedAt: null,
  };
}

const svc = (prisma: any) =>
  new TeachersService(prisma, { applyToMany: async (i: unknown[]) => i } as any, {
    hiddenTeacherIds: async () => [],
  } as any);

/** The `where` the service handed Prisma for the profile lookup. */
const profileWhere = (prisma: any) => prisma.teacherProfile.findFirst.mock.calls[0][0].where;
/** The `where` applied to the courses included on that profile. */
const coursesWhere = (prisma: any) => prisma.teacherProfile.findFirst.mock.calls[0][0].include.courses.where;

describe('TeachersService.publicProfile — what a stranger may see', () => {
  it('only ever returns an APPROVED teacher', async () => {
    const prisma = makePrisma();

    await svc(prisma).publicProfile('ms-amal');

    expect(profileWhere(prisma).status).toBe('APPROVED');
  });

  it('only ever returns an active account', async () => {
    const prisma = makePrisma();

    await svc(prisma).publicProfile('ms-amal');

    expect(profileWhere(prisma).user.isActive).toBe(true);
  });

  /**
   * A Center's teachers are reached through the Center, not the marketplace
   * directory — this filter is what keeps the two apart.
   */
  it('only ever returns a teacher with a PERSONAL, undeleted academy', async () => {
    const prisma = makePrisma();

    await svc(prisma).publicProfile('ms-amal');

    expect(profileWhere(prisma).user.ownedAcademies.some).toMatchObject({
      kind: 'PERSONAL',
      deletedAt: null,
    });
  });

  it('only ever lists PUBLISHED, undeleted courses', async () => {
    const prisma = makePrisma();

    await svc(prisma).publicProfile('ms-amal');

    expect(coursesWhere(prisma)).toMatchObject({ status: 'PUBLISHED', deletedAt: null });
  });

  it('404s rather than leaking that the slug exists but is not visible', async () => {
    const prisma = makePrisma(null);

    await expect(svc(prisma).publicProfile('ms-amal')).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('year narrowing', () => {
    it('an anonymous visitor sees the whole catalogue', async () => {
      const prisma = makePrisma();

      await svc(prisma).publicProfile('ms-amal');

      // No viewer, so no year: nothing beyond the published/undeleted filter.
      expect(coursesWhere(prisma).OR).toBeUndefined();
    });

    it('a signed-in student sees their own year, plus courses aimed at nobody in particular', async () => {
      const prisma = makePrisma();
      prisma.studentProfile.findFirst.mockResolvedValue({ gradeId: 'year-9' });

      await svc(prisma).publicProfile('ms-amal', 'user-1');

      const where = coursesWhere(prisma);
      // A course with no years is for everyone — dropping it would hide the
      // teacher's general material from every student who has answered the
      // year question.
      expect(where.OR).toEqual([
        { grades: { some: { gradeId: 'year-9' } } },
        { grades: { none: {} } },
      ]);
      // And the public filters still apply on top of the narrowing.
      expect(where).toMatchObject({ status: 'PUBLISHED', deletedAt: null });
    });

    it('a signed-in student with no year answered still sees everything', async () => {
      const prisma = makePrisma();
      prisma.studentProfile.findFirst.mockResolvedValue({ gradeId: null });

      await svc(prisma).publicProfile('ms-amal', 'user-1');

      expect(coursesWhere(prisma).OR).toBeUndefined();
    });
  });

  it('shows only a live academy link, never an archived or deleted one', async () => {
    const prisma = makePrisma();

    await svc(prisma).publicProfile('ms-amal');

    const academies = prisma.teacherProfile.findFirst.mock.calls[0][0].include.user.select.ownedAcademies;
    expect(academies.where).toMatchObject({ deletedAt: null, status: { not: 'ARCHIVED' } });
    expect(academies.take).toBe(1);
  });
});
