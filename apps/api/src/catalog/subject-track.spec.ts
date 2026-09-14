import { ForbiddenException } from '@nestjs/common';
import { SubjectTrack } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCourseTrack, trackAdmits, trackFilter } from './subject-track';

/**
 * The school-system gate on enrolment.
 *
 * Egypt runs two systems side by side: a language school's "Math" is taught in
 * English against a different syllabus than "الرياضيات", so a student in one
 * has no use for a teacher of the other. The same four routes that had to learn
 * to ask about the student's year have to ask about this too — a listing that
 * hides a course is not a rule, as the year gate found out.
 *
 * What matters here is which cases the gate leaves open: refusing the wrong one
 * takes away a course the student is entitled to.
 */
describe('a subject belongs to a school system', () => {
  it('admits the student in that system', () => {
    expect(trackAdmits('LANGUAGES', 'LANGUAGES')).toBe(true);
    expect(trackAdmits('GENERAL', 'GENERAL')).toBe(true);
  });

  it('refuses the student in the other one', () => {
    expect(trackAdmits('GENERAL', 'LANGUAGES')).toBe(false);
    expect(trackAdmits('LANGUAGES', 'GENERAL')).toBe(false);
  });

  it('admits everyone to the subjects every student sits', () => {
    // Arabic, religion, social studies, second languages: one row, not two,
    // because there is only one of them in the world.
    expect(trackAdmits('BOTH', 'GENERAL')).toBe(true);
    expect(trackAdmits('BOTH', 'LANGUAGES')).toBe(true);
  });

  it('admits everyone to a course that was never filed under a system', () => {
    expect(trackAdmits(null, 'LANGUAGES')).toBe(true);
    expect(trackAdmits(undefined, 'GENERAL')).toBe(true);
  });

  it('admits a student who never said which school they are in', () => {
    // Everyone who signed up before the question existed. They are shown the
    // whole catalogue, so the gate must not be what starts refusing them.
    expect(trackAdmits('GENERAL', null)).toBe(true);
    expect(trackAdmits('LANGUAGES', undefined)).toBe(true);
  });
});

describe('the listing filter', () => {
  it('offers a student their own system and the shared subjects', () => {
    expect(trackFilter('LANGUAGES')).toEqual(['LANGUAGES', 'BOTH']);
    expect(trackFilter('GENERAL')).toEqual(['GENERAL', 'BOTH']);
  });

  it('does not narrow at all for a viewer with no answer on file', () => {
    // Null rather than an empty list: the caller leaves the filter off, instead
    // of narrowing the catalogue to nothing.
    expect(trackFilter(null)).toBeNull();
    expect(trackFilter(undefined)).toBeNull();
  });
});

describe('starting an enrolment', () => {
  const prismaFor = (track: SubjectTrack | null) =>
    ({
      course: {
        findUnique: jest.fn().mockResolvedValue({
          subject: track ? { track, nameAr: 'ماث' } : null,
        }),
      },
    }) as unknown as PrismaService;

  it('is refused when the course belongs to the other system', async () => {
    const prisma = prismaFor('LANGUAGES');
    await expect(assertCourseTrack(prisma, 'c1', 'GENERAL')).rejects.toThrow(ForbiddenException);
  });

  it('names the subject in the refusal, so the client can say which', async () => {
    const prisma = prismaFor('LANGUAGES');
    const error = await assertCourseTrack(prisma, 'c1', 'GENERAL').catch((e) => e);
    expect(error.getResponse()).toMatchObject({
      code: 'COURSE_OTHER_TRACK',
      track: 'LANGUAGES',
      subject: 'ماث',
    });
  });

  it('goes through for the system the course belongs to', async () => {
    const prisma = prismaFor('LANGUAGES');
    await expect(assertCourseTrack(prisma, 'c1', 'LANGUAGES')).resolves.toBeUndefined();
  });

  it('goes through for a subject every student sits', async () => {
    const prisma = prismaFor('BOTH');
    await expect(assertCourseTrack(prisma, 'c1', 'GENERAL')).resolves.toBeUndefined();
  });

  it('never asks the database about a student with no system on file', async () => {
    // The unanswered case is answered before the query, so an older account
    // costs nothing and can never be refused by a lookup that went wrong.
    const prisma = prismaFor('LANGUAGES');
    await expect(assertCourseTrack(prisma, 'c1', null)).resolves.toBeUndefined();
    expect(prisma.course.findUnique).not.toHaveBeenCalled();
  });

  /**
   * A student who moved from a national school to a language one mid-year, or
   * is simply renewing. They enrolled while the course was theirs and have been
   * paying for it since; taking it away is not what the gate is for.
   */
  it('lets a student keep a course they already held', async () => {
    const prisma = prismaFor('LANGUAGES');
    await expect(
      assertCourseTrack(prisma, 'c1', 'GENERAL', { status: 'ACTIVE' }),
    ).resolves.toBeUndefined();
    await expect(
      assertCourseTrack(prisma, 'c1', 'GENERAL', { status: 'EXPIRED' }),
    ).resolves.toBeUndefined();
  });

  it('does not let a rejected payment pass for having been tried before', async () => {
    const prisma = prismaFor('LANGUAGES');
    await expect(
      assertCourseTrack(prisma, 'c1', 'GENERAL', { status: 'REJECTED' }),
    ).rejects.toThrow(ForbiddenException);
  });
});
