import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  private async studentOf(userId: string) {
    const s = await this.prisma.studentProfile.findUnique({ where: { userId } });
    if (!s) throw new BadRequestException('No student profile for this account');
    return s;
  }

  /**
   * Write (or update) the caller's review of a course. Requires an enrollment
   * in that course — you can only review what you've taken. One review per
   * student per course (upsert).
   */
  async upsert(userId: string, dto: { courseId: string; rating: number; comment?: string }) {
    if (dto.rating < 1 || dto.rating > 5) throw new BadRequestException('Rating must be 1–5');
    const student = await this.studentOf(userId);

    const course = await this.prisma.course.findUnique({
      where: { id: dto.courseId },
      select: { id: true, tenantId: true, title: true },
    });
    if (!course) throw new NotFoundException('Course not found');

    const enrollment = await this.prisma.enrollment.findUnique({
      where: { studentId_courseId: { studentId: student.id, courseId: course.id } },
    });
    if (!enrollment || enrollment.status === 'PENDING_APPROVAL' || enrollment.status === 'REJECTED') {
      throw new ForbiddenException('You can only review a course you are enrolled in');
    }

    const prior = await this.prisma.review.findUnique({
      where: {
        studentId_tenantId_courseId: {
          studentId: student.id,
          tenantId: course.tenantId,
          courseId: course.id,
        },
      },
    });

    const review = await this.prisma.review.upsert({
      where: {
        studentId_tenantId_courseId: {
          studentId: student.id,
          tenantId: course.tenantId,
          courseId: course.id,
        },
      },
      create: {
        studentId: student.id,
        tenantId: course.tenantId,
        courseId: course.id,
        rating: dto.rating,
        comment: dto.comment ?? '',
      },
      update: { rating: dto.rating, comment: dto.comment ?? '' },
    });

    // Notify the teacher of a brand-new review.
    if (!prior) {
      const teacher = await this.prisma.teacherProfile.findUnique({
        where: { id: course.tenantId },
        select: { userId: true },
      });
      if (teacher) {
        await this.notifications.create({
          userId: teacher.userId,
          type: 'ANNOUNCEMENT',
          title: 'تقييم جديد ⭐',
          body: `حصلت دورة «${course.title}» على تقييم ${dto.rating}/5`,
          meta: { courseId: course.id, rating: dto.rating },
        });
      }
    }
    return review;
  }

  /** The caller's own review of a course, if any (for prefilling the form). */
  async mineForCourse(userId: string, courseId: string) {
    const student = await this.prisma.studentProfile.findUnique({ where: { userId } });
    if (!student) return null;
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { tenantId: true },
    });
    if (!course) return null;
    return this.prisma.review.findUnique({
      where: {
        studentId_tenantId_courseId: {
          studentId: student.id,
          tenantId: course.tenantId,
          courseId,
        },
      },
    });
  }
}
