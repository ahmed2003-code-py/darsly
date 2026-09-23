import { ForbiddenException } from '@nestjs/common';
import { EnrollmentStatus, SubjectTrack } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Whether a subject's school system admits a given student.
 *
 * Egypt runs two systems side by side, and a course belongs to one of them: a
 * language school's "Math" is taught in English against a different syllabus
 * than "الرياضيات", and a student in one has no use for the other. Discovery
 * filters on this, but a listing is only a listing — the course's own page, the
 * teacher's landing page and a link someone was sent all reach a course
 * directly. The same hole the year filter had, so it is closed the same way.
 *
 * Three cases open it, and they are all the cases where the answer is unknown
 * rather than no:
 *
 *  - A subject marked BOTH is one every student sits — Arabic, religion, social
 *    studies, second languages — so it admits everyone by definition.
 *  - A course with no subject was never filed under a system at all.
 *  - A student who never said which school they are in is shown everything, so
 *    this is not the thing that starts refusing the students who signed up
 *    before the question existed.
 */
export function trackAdmits(
  subjectTrack: SubjectTrack | null | undefined,
  studentTrack: SubjectTrack | null | undefined,
): boolean {
  if (!subjectTrack || subjectTrack === 'BOTH') return true;
  if (!studentTrack || studentTrack === 'BOTH') return true;
  return subjectTrack === studentTrack;
}

/**
 * The `Subject.track` values a student may be shown, as a Prisma filter.
 *
 * Null for a student who never answered: the caller leaves the filter off
 * entirely rather than narrowing to nothing.
 */
export function trackFilter(studentTrack: SubjectTrack | null | undefined): SubjectTrack[] | null {
  if (!studentTrack || studentTrack === 'BOTH') return null;
  return [studentTrack, 'BOTH'];
}

/** Statuses that mean this student has already had this course. */
const HELD_BEFORE: EnrollmentStatus[] = ['ACTIVE', 'EXPIRED'];

/**
 * Refuse a course that belongs to the other school system.
 *
 * Called by every route that can start an enrolment, for the same reason
 * `assertCourseYear` is: the refusal has to sit on the action, not on the
 * listing that led to it. A student who already held the course keeps it — a
 * renewal is not new access, and a student who switched schools should not lose
 * the course they have been paying for.
 */
export async function assertCourseTrack(
  prisma: PrismaService,
  courseId: string,
  studentTrack: SubjectTrack | null | undefined,
  previous?: { status: EnrollmentStatus } | null,
): Promise<void> {
  if (previous && HELD_BEFORE.includes(previous.status)) return;
  if (!studentTrack || studentTrack === 'BOTH') return;
  const course = await prisma.course.findUnique({
    where: { id: courseId },
    select: { subject: { select: { track: true, nameAr: true } } },
  });
  if (trackAdmits(course?.subject?.track, studentTrack)) return;
  throw new ForbiddenException({
    message: 'This course is for the other school system',
    code: 'COURSE_OTHER_TRACK',
    track: course?.subject?.track,
    subject: course?.subject?.nameAr,
  });
}
