import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertCourseYear } from './course-year';
import { yearState } from './course-access';

/**
 * The year gate on enrolment.
 *
 * A third-secondary student found a first-baccalaureate course on the teacher's
 * public landing page — which lists everything the teacher sells, to visitors
 * with no year at all — opened it, and enrolled. Discovery had hidden that
 * course from them correctly; nothing behind the four ways into a course ever
 * asked the question, so hiding it was the only thing standing there.
 *
 * These are the cases the gate has to keep straight, because refusing the wrong
 * one locks students out of courses that are theirs.
 */
describe('a course names the years it is for', () => {
  it('admits the student whose year is named', () => {
    expect(yearState(['bacc-1', 'bacc-2'], 'bacc-1')).toBe('OK');
  });

  it('refuses the student whose year is not', () => {
    expect(yearState(['bacc-1'], 'secondary-3')).toBe('OTHER_YEAR');
  });

  it('admits everyone when the course named no year', () => {
    // An empty list is a course that was never narrowed, which is not the same
    // as a course for nobody.
    expect(yearState([], 'secondary-3')).toBe('OK');
    expect(yearState([], null)).toBe('OK');
  });

  it('asks a student who never gave their year for it, instead of letting them through', () => {
    // An unknown year is not a matching one: this used to admit them, which
    // made "no year on the profile" a way around every year gate.
    expect(yearState(['bacc-1'], null)).toBe('YEAR_REQUIRED');
    expect(yearState(['bacc-1'], undefined)).toBe('YEAR_REQUIRED');
  });

  it('keeps a course the student already held, whatever their year now', () => {
    expect(yearState(['bacc-1'], 'secondary-3', { status: 'ACTIVE' })).toBe('OK');
    expect(yearState(['bacc-1'], null, { status: 'EXPIRED' })).toBe('OK');
    expect(yearState(['bacc-1'], null, { status: 'PENDING_PAYMENT' })).toBe('YEAR_REQUIRED');
  });
});

describe('starting an enrolment', () => {
  const prismaFor = (gradeIds: string[]) =>
    ({
      courseGrade: {
        findMany: jest
          .fn()
          .mockResolvedValue(
            gradeIds.map((gradeId) => ({ gradeId, grade: { nameAr: `سنة ${gradeId}` } })),
          ),
      },
    }) as unknown as PrismaService;

  it('is refused when the course is for another year', async () => {
    const prisma = prismaFor(['bacc-1']);
    await expect(assertCourseYear(prisma, 'c1', 'secondary-3')).rejects.toThrow(ForbiddenException);
  });

  it('names the years in the refusal, so the client can say which', async () => {
    const prisma = prismaFor(['bacc-1']);
    const error = await assertCourseYear(prisma, 'c1', 'secondary-3').catch((e) => e);
    expect(error.getResponse()).toMatchObject({ code: 'COURSE_OTHER_YEAR', years: ['سنة bacc-1'] });
  });

  it('is refused with YEAR_REQUIRED when the student has no year', async () => {
    const prisma = prismaFor(['bacc-1']);
    const error = await assertCourseYear(prisma, 'c1', null).catch((e) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.getResponse()).toMatchObject({ code: 'YEAR_REQUIRED' });
  });

  it('goes through for the year the course is for', async () => {
    const prisma = prismaFor(['bacc-1']);
    await expect(assertCourseYear(prisma, 'c1', 'bacc-1')).resolves.toBeUndefined();
  });

  it('goes through for a course that names no year, with or without a year', async () => {
    const prisma = prismaFor([]);
    await expect(assertCourseYear(prisma, 'c1', null)).resolves.toBeUndefined();
  });

  /**
   * A monthly course renewed by a student who has since moved up a year. They
   * enrolled while it was theirs and have been paying for it since; refusing
   * the renewal would take away a course they already own, which is not what
   * the gate is for.
   */
  it('lets a student renew a course they already held', async () => {
    const prisma = prismaFor(['secondary-3']);
    await expect(
      assertCourseYear(prisma, 'c1', 'bacc-1', { status: 'EXPIRED' }),
    ).resolves.toBeUndefined();
    await expect(
      assertCourseYear(prisma, 'c1', 'bacc-1', { status: 'ACTIVE' }),
    ).resolves.toBeUndefined();
  });

  it('does not let a rejected payment pass for having been tried before', async () => {
    const prisma = prismaFor(['secondary-3']);
    await expect(assertCourseYear(prisma, 'c1', 'bacc-1', { status: 'REJECTED' })).rejects.toThrow(
      ForbiddenException,
    );
  });
});
