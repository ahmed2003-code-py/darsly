import { ForbiddenException } from '@nestjs/common';
import { EnrollmentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Whether a course's declared years admit a given student.
 *
 * Discovery already hides the courses that are not the student's year, but a
 * listing is only a listing: the course's own page, the teacher's public
 * landing page and a link someone was sent all reach a course directly, and
 * none of the four routes that start an enrolment — free, bank transfer,
 * wallet, card — ever asked the question. So a third-secondary student could
 * find a first-baccalaureate course on the teacher's site, open it, and buy
 * it, while the same course was correctly absent from their catalogue.
 *
 * The rule here is the schema's own, kept in one place because four callers
 * have to agree on it:
 *
 *  - A course that names no year was never narrowed, so it admits everyone.
 *  - A student who never gave their year is shown every course, so the gate is
 *    not the thing that starts refusing them.
 *  - Otherwise the student's year must be one the course names.
 *
 * It closes only on the unambiguous case, which is also the only one a student
 * can be shown a contradiction about.
 */
export function yearAdmits(
  courseGradeIds: string[],
  studentGradeId: string | null | undefined,
): boolean {
  if (!courseGradeIds.length || !studentGradeId) return true;
  return courseGradeIds.includes(studentGradeId);
}

/**
 * Statuses that mean this student has already had this course.
 *
 * Renewing or coming back is not the same as getting in: a student who enrolled
 * while the course was theirs, then moved up a year, would otherwise be refused
 * the renewal of a monthly course they have been paying for all along. The gate
 * is about new access, so a course they have already held stays open to them.
 */
const HELD_BEFORE: EnrollmentStatus[] = ['ACTIVE', 'EXPIRED'];

/**
 * Refuse a course whose years are not the student's.
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
  if (previous && HELD_BEFORE.includes(previous.status)) return;
  const rows = await prisma.courseGrade.findMany({
    where: { courseId },
    select: { gradeId: true, grade: { select: { nameAr: true } } },
  });
  if (
    yearAdmits(
      rows.map((r) => r.gradeId),
      studentGradeId,
    )
  )
    return;
  throw new ForbiddenException({
    message: 'This course is for another year',
    code: 'COURSE_OTHER_YEAR',
    years: rows.map((r) => r.grade.nameAr),
  });
}
