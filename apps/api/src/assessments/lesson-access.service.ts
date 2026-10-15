import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EntryExamService } from '../courses/entry-exam.service';
import { assertStudentLessonAccess } from '../catalog/course-access';

/**
 * Access gating shared by quizzes and assignments: the same rule as the
 * lesson's video (catalog/course-access.ts — year, preview or enrolment, drip)
 * plus the course's entry exam, so an assessment is only reachable by the
 * owner teacher or a student with live, unlocked access.
 */
@Injectable()
export class LessonAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entryExam: EntryExamService,
  ) {}

  async studentIdOf(userId: string): Promise<string> {
    return (await this.studentOf(userId)).id;
  }

  private async studentOf(userId: string) {
    const s = await this.prisma.studentProfile.findUnique({ where: { userId } });
    if (!s)
      throw new BadRequestException({
        message: 'No student profile for this account',
        code: 'STUDENT_ACCOUNT_REQUIRED',
      });
    return s;
  }

  /** Student can reach this lesson's assessment (active enrollment + drip). */
  async requireStudentAccess(userId: string, lessonId: string) {
    // findFirst (not findUnique) so the soft-delete middleware filters the
    // lesson; the nested unit/course are checked explicitly (nested includes
    // are not auto-filtered) so a "deleted" lesson/unit/course is unreachable.
    const lesson = await this.prisma.lesson.findFirst({
      where: { id: lessonId, deletedAt: null },
      include: { unit: { include: { course: true } } },
    });
    if (!lesson || lesson.unit.deletedAt || lesson.unit.course.deletedAt) {
      throw new NotFoundException('Lesson not found');
    }
    const course = lesson.unit.course;
    const student = await this.studentOf(userId);
    const studentId = student.id;

    // The course's year, then a free preview or an active enrolment past its
    // drip date — the rule the lesson's video plays by (catalog/course-access.ts).
    await assertStudentLessonAccess(this.prisma, {
      studentId,
      gradeId: student.gradeId,
      courseId: course.id,
      lesson,
    });
    if (!lesson.isFreePreview) {
      // The exam does not lock itself, and it does not lock what it sends a
      // student to watch. Everything else in the course waits for a pass.
      await this.entryExam.requirePassed(course.id, studentId, lessonId, lesson.isFreePreview);
    }
    return { lesson, course, studentId };
  }

  /** Teacher owns the lesson (tenant-scoped; cross-tenant ids 404). */
  async requireTeacherLesson(tenantId: string, lessonId: string) {
    const lesson = await this.prisma.lesson.findFirst({
      where: { id: lessonId, unit: { course: { tenantId } } },
      include: { unit: { include: { course: true } } },
    });
    if (!lesson) throw new NotFoundException('Lesson not found');
    return lesson;
  }
}
