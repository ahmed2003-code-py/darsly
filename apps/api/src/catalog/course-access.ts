import { ForbiddenException } from '@nestjs/common';
import { EnrollmentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Who may reach a course's content, decided in one place.
 *
 * Five routes used to answer this each in their own way — the video, the
 * class notes, a student's timestamped notes, attachments, and a lesson's
 * quizzes and assignments — and the course page drew its padlocks from a
 * sixth copy. They had drifted: the attachment download skipped the drip
 * date the course page respected, and none of them asked the year at all, so
 * a third-secondary student could open a first-baccalaureate course and play
 * its free preview while the enrolment gate (and discovery) refused them.
 *
 * The rules, in the order they are asked:
 *
 *  1. The year. A course that names no year was never narrowed and admits
 *     everyone. Otherwise the student's year must be one it names — and a
 *     student with no year on record is asked for it (YEAR_REQUIRED) rather
 *     than let through: an unknown year is not a matching one. A student who
 *     has already held the course (ACTIVE or EXPIRED) keeps it regardless —
 *     moving up a year does not take away a course they paid for.
 *  2. A free-preview lesson is open to any student the year admits.
 *  3. Anything else needs an active enrolment, past its drip date.
 *
 * The owner teacher and the super admin are not students and are decided by
 * each caller before it gets here, exactly as before. The course's entry exam
 * stays where it was (EntryExamService, asked by the routes that consume a
 * lesson); it is a different question with its own carve-outs.
 */

/** How a course's years stand for one student. */
export type YearState = 'OK' | 'OTHER_YEAR' | 'YEAR_REQUIRED';

/**
 * Statuses that mean this student has already had this course.
 *
 * Renewing or coming back is not the same as getting in: a student who enrolled
 * while the course was theirs, then moved up a year, would otherwise be refused
 * the renewal of a monthly course they have been paying for all along.
 */
const HELD_BEFORE: EnrollmentStatus[] = ['ACTIVE', 'EXPIRED'];

export function heldBefore(previous?: { status: EnrollmentStatus } | null): boolean {
  return !!previous && HELD_BEFORE.includes(previous.status);
}

export function yearState(
  courseGradeIds: string[],
  studentGradeId: string | null | undefined,
  previous?: { status: EnrollmentStatus } | null,
): YearState {
  if (heldBefore(previous)) return 'OK';
  if (!courseGradeIds.length) return 'OK';
  if (!studentGradeId) return 'YEAR_REQUIRED';
  return courseGradeIds.includes(studentGradeId) ? 'OK' : 'OTHER_YEAR';
}

/** The refusal for a year state that is not OK, naming the course's years. */
export function yearRefusal(state: Exclude<YearState, 'OK'>, years: string[]): ForbiddenException {
  return state === 'YEAR_REQUIRED'
    ? new ForbiddenException({
        message: 'Set your school year to open this course',
        code: 'YEAR_REQUIRED',
        years,
      })
    : new ForbiddenException({
        message: 'This course is for another year',
        code: 'COURSE_OTHER_YEAR',
        years,
      });
}

/**
 * The listing half of the same rule: a course for this year, or one that
 * names no year. Null — no filter — when there is no year to narrow to (a
 * visitor, staff, or a student browsing every year on purpose). A listing is
 * a shop window, not a door: whatever it shows, the routes above decide.
 */
export function courseYearWhere(
  gradeId: string | null | undefined,
): Prisma.CourseWhereInput | null {
  if (!gradeId) return null;
  return { OR: [{ grades: { some: { gradeId } } }, { grades: { none: {} } }] };
}

/** The signed-in student's own year, for a listing that is not a search. */
export async function studentGradeOf(
  prisma: PrismaService,
  viewerUserId?: string | null,
): Promise<string | null> {
  if (!viewerUserId) return null;
  const s = await prisma.studentProfile.findFirst({
    where: { userId: viewerUserId },
    select: { gradeId: true },
  });
  return s?.gradeId ?? null;
}

export interface LessonGate {
  isFreePreview: boolean;
  dripUnlockAt: Date | null;
  dripAfterEnrollDays: number | null;
}

export interface EnrollmentGate {
  status: EnrollmentStatus;
  expiresAt: Date | null;
  approvedAt: Date | null;
}

export function enrollmentActive(e: EnrollmentGate | null | undefined, now = Date.now()): boolean {
  return e?.status === 'ACTIVE' && (!e.expiresAt || e.expiresAt.getTime() > now);
}

/** Past the lesson's drip date (fixed, or N days after the enrolment was approved). */
export function unlockedByDrip(
  lesson: Pick<LessonGate, 'dripUnlockAt' | 'dripAfterEnrollDays'>,
  e: Pick<EnrollmentGate, 'approvedAt'> | null | undefined,
  now = Date.now(),
): boolean {
  if (lesson.dripUnlockAt && lesson.dripUnlockAt.getTime() > now) return false;
  if (
    lesson.dripAfterEnrollDays != null &&
    e?.approvedAt &&
    e.approvedAt.getTime() + lesson.dripAfterEnrollDays * 86_400_000 > now
  ) {
    return false;
  }
  return true;
}

export type LessonRefusal =
  'COURSE_OTHER_YEAR' | 'YEAR_REQUIRED' | 'NOT_ENROLLED' | 'LESSON_LOCKED';

export type LessonVerdict =
  { ok: true; via: 'PREVIEW' | 'ENROLLMENT' } | { ok: false; code: LessonRefusal };

/** One student and one lesson — the whole rule, without a database. */
export function studentLessonVerdict(x: {
  lesson: LessonGate;
  enrollment: EnrollmentGate | null | undefined;
  year: YearState;
  now?: number;
}): LessonVerdict {
  const now = x.now ?? Date.now();
  if (x.year === 'OTHER_YEAR') return { ok: false, code: 'COURSE_OTHER_YEAR' };
  if (x.year === 'YEAR_REQUIRED') return { ok: false, code: 'YEAR_REQUIRED' };
  if (x.lesson.isFreePreview) return { ok: true, via: 'PREVIEW' };
  if (!enrollmentActive(x.enrollment, now)) return { ok: false, code: 'NOT_ENROLLED' };
  if (!unlockedByDrip(x.lesson, x.enrollment, now)) return { ok: false, code: 'LESSON_LOCKED' };
  return { ok: true, via: 'ENROLLMENT' };
}

const REFUSAL_MESSAGE: Record<LessonRefusal, string> = {
  COURSE_OTHER_YEAR: 'This course is for another year',
  YEAR_REQUIRED: 'Set your school year to open this course',
  NOT_ENROLLED: 'Not enrolled in this course',
  LESSON_LOCKED: 'Lesson is not unlocked yet',
};

export function lessonRefusal(code: LessonRefusal, years: string[] = []): ForbiddenException {
  return new ForbiddenException({
    message: REFUSAL_MESSAGE[code],
    code,
    ...(code === 'COURSE_OTHER_YEAR' || code === 'YEAR_REQUIRED' ? { years } : {}),
  });
}

/** A course's declared years: ids for the rule, Arabic names for the refusal. */
export async function courseYears(
  prisma: PrismaService,
  courseId: string,
): Promise<{ ids: string[]; names: string[] }> {
  const rows = await prisma.courseGrade.findMany({
    where: { courseId },
    select: { gradeId: true, grade: { select: { nameAr: true } } },
  });
  return { ids: rows.map((r) => r.gradeId), names: rows.map((r) => r.grade.nameAr) };
}

/**
 * The verdict for a student on one lesson, read from the database. Every
 * route that serves a lesson's content to a student asks this.
 */
export async function studentLessonAccess(
  prisma: PrismaService,
  x: { studentId: string; gradeId: string | null; courseId: string; lesson: LessonGate },
): Promise<{
  verdict: LessonVerdict;
  enrollment: (EnrollmentGate & { id: string }) | null;
  years: string[];
}> {
  const [enrollment, years] = await Promise.all([
    prisma.enrollment.findUnique({
      where: { studentId_courseId: { studentId: x.studentId, courseId: x.courseId } },
    }),
    courseYears(prisma, x.courseId),
  ]);
  const verdict = studentLessonVerdict({
    lesson: x.lesson,
    enrollment,
    year: yearState(years.ids, x.gradeId, enrollment),
  });
  return { verdict, enrollment, years: years.names };
}

/** Same, throwing the coded refusal. Returns the enrolment for callers that need it. */
export async function assertStudentLessonAccess(
  prisma: PrismaService,
  x: { studentId: string; gradeId: string | null; courseId: string; lesson: LessonGate },
) {
  const r = await studentLessonAccess(prisma, x);
  if (!r.verdict.ok) throw lessonRefusal(r.verdict.code, r.years);
  return { enrollment: r.enrollment, via: r.verdict.via };
}
