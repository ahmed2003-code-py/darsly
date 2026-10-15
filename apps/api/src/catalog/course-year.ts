import { EnrollmentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { courseYears, yearRefusal, yearState } from './course-access';

/**
 * The year gate on enrolment.
 *
 * Discovery already hides the courses that are not the student's year, but a
 * listing is only a listing: the course's own page, the teacher's public
 * landing page and a link someone was sent all reach a course directly, and
 * none of the four routes that start an enrolment — free, bank transfer,
 * wallet, card — ever asked the question. So a third-secondary student could
 * find a first-baccalaureate course on the teacher's site, open it, and buy
 * it, while the same course was correctly absent from their catalogue.
 *
 * The rule itself lives in course-access.ts, shared with every route that
 * serves a lesson: a course that names no year admits everyone; a student who
 * already held the course keeps it; a student with no year is asked for it
 * (YEAR_REQUIRED) instead of being let through; otherwise the years must match.
 *
 * Called by every route that can start an enrolment, because the refusal has to
 * sit on the action and not on the listing that led to it.
 */
export async function assertCourseYear(
  prisma: PrismaService,
  courseId: string,
  studentGradeId: string | null | undefined,
  previous?: { status: EnrollmentStatus } | null,
): Promise<void> {
  const years = await courseYears(prisma, courseId);
  const state = yearState(years.ids, studentGradeId, previous);
  if (state !== 'OK') throw yearRefusal(state, years.names);
}
