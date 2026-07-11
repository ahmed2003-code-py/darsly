import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Access gating shared by quizzes and assignments. Mirrors the playback
 * service's enrollment/drip rules (minus video readiness) so an assessment is
 * only reachable by the owner teacher or a student with live, unlocked access.
 */
@Injectable()
export class LessonAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async studentIdOf(userId: string): Promise<string> {
    const s = await this.prisma.studentProfile.findUnique({ where: { userId } });
    if (!s) throw new BadRequestException('No student profile for this account');
    return s.id;
  }

  /** Student can reach this lesson's assessment (active enrollment + drip). */
  async requireStudentAccess(userId: string, lessonId: string) {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      include: { unit: { include: { course: true } } },
    });
    if (!lesson) throw new NotFoundException('Lesson not found');
    const course = lesson.unit.course;
    const studentId = await this.studentIdOf(userId);

    if (!lesson.isFreePreview) {
      const enrollment = await this.prisma.enrollment.findUnique({
        where: { studentId_courseId: { studentId, courseId: course.id } },
      });
      const active =
        enrollment?.status === 'ACTIVE' &&
        (!enrollment.expiresAt || enrollment.expiresAt > new Date());
      if (!active) throw new ForbiddenException('Not enrolled in this course');

      const now = Date.now();
      if (lesson.dripUnlockAt && lesson.dripUnlockAt.getTime() > now) {
        throw new ForbiddenException('Lesson is not unlocked yet');
      }
      if (
        lesson.dripAfterEnrollDays != null &&
        enrollment!.approvedAt &&
        enrollment!.approvedAt.getTime() + lesson.dripAfterEnrollDays * 86_400_000 > now
      ) {
        throw new ForbiddenException('Lesson is not unlocked yet');
      }
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
