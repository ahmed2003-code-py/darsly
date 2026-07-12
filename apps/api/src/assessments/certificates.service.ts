import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Issues a completion certificate once a student has completed every lesson in
 * a course. Idempotent: a repeat completion signal never mints a second serial.
 */
@Injectable()
export class CertificatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  private serialFor(offset: number): string {
    const year = new Date().getFullYear();
    return `DRS-CERT-${year}-${String(offset).padStart(6, '0')}`;
  }

  /**
   * Create the certificate, retrying on a serial collision — deriving the serial
   * from count() can race two concurrent completions onto the same serial (the
   * serial is @unique, so the loser would otherwise 500).
   */
  private async createWithSerial(studentId: string, courseId: string) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const n = await this.prisma.certificate.count();
      try {
        return await this.prisma.certificate.create({
          data: { studentId, courseId, serial: this.serialFor(n + 1 + attempt) },
          include: { course: { select: { title: true } } },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          // Either the (studentId,courseId) unique (already issued) or the serial.
          const existing = await this.prisma.certificate.findUnique({
            where: { studentId_courseId: { studentId, courseId } },
            include: { course: { select: { title: true } } },
          });
          if (existing) return existing;
          if (attempt < 5) continue; // serial collision — recompute and retry
        }
        throw e;
      }
    }
    throw new Error(`certificate serial retries exhausted for ${studentId}/${courseId}`);
  }

  /** Completion = every lesson in the course has a completed LessonProgress. */
  async checkCourseCompletion(studentId: string, courseId: string) {
    const totalLessons = await this.prisma.lesson.count({
      where: { unit: { courseId } },
    });
    if (totalLessons === 0) return null;

    const completed = await this.prisma.lessonProgress.count({
      where: { studentId, completedAt: { not: null }, lesson: { unit: { courseId } } },
    });
    if (completed < totalLessons) return null;

    // Idempotent issue.
    const existing = await this.prisma.certificate.findUnique({
      where: { studentId_courseId: { studentId, courseId } },
    });
    if (existing) return existing;

    const cert = await this.createWithSerial(studentId, courseId);

    const student = await this.prisma.studentProfile.findUnique({
      where: { id: studentId },
      select: { userId: true },
    });
    if (student) {
      await this.notifications.create({
        userId: student.userId,
        type: 'ANNOUNCEMENT',
        title: 'مبروك! حصلت على شهادة إتمام 🎓',
        body: `أتممت دورة «${cert.course.title}». شهادتك رقم ${cert.serial} جاهزة.`,
        meta: { certificateId: cert.id, serial: cert.serial, courseId },
      });
    }
    return cert;
  }

  /** Convenience: resolve the course from a lesson, then check completion. */
  async checkByLesson(studentId: string, lessonId: string) {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      select: { unit: { select: { courseId: true } } },
    });
    if (!lesson) return null;
    return this.checkCourseCompletion(studentId, lesson.unit.courseId);
  }

  async listMine(userId: string) {
    const studentId = await this.studentId(userId);
    if (!studentId) return [];
    return this.prisma.certificate.findMany({
      where: { studentId },
      orderBy: { issuedAt: 'desc' },
      include: {
        course: {
          select: {
            title: true,
            teacher: { select: { user: { select: { fullName: true } } } },
          },
        },
      },
    });
  }

  /** Public verification by serial — proves a certificate is genuine. */
  async verify(serial: string) {
    const cert = await this.prisma.certificate.findUnique({
      where: { serial },
      include: {
        student: { select: { user: { select: { fullName: true } } } },
        course: {
          select: {
            title: true,
            teacher: { select: { user: { select: { fullName: true } } } },
          },
        },
      },
    });
    if (!cert) throw new NotFoundException('Certificate not found');
    return {
      serial: cert.serial,
      studentName: cert.student.user.fullName,
      courseTitle: cert.course.title,
      teacherName: cert.course.teacher.user.fullName,
      issuedAt: cert.issuedAt,
    };
  }

  /** Owner-scoped fetch for the certificate view page. */
  async getMineBySerial(userId: string, serial: string) {
    const studentId = await this.studentId(userId);
    const cert = await this.prisma.certificate.findUnique({
      where: { serial },
      include: {
        student: { select: { id: true, user: { select: { fullName: true } } } },
        course: {
          select: {
            title: true,
            teacher: { select: { user: { select: { fullName: true } } } },
          },
        },
      },
    });
    if (!cert) throw new NotFoundException('Certificate not found');
    if (cert.student.id !== studentId) throw new ForbiddenException('Not your certificate');
    return {
      serial: cert.serial,
      studentName: cert.student.user.fullName,
      courseTitle: cert.course.title,
      teacherName: cert.course.teacher.user.fullName,
      issuedAt: cert.issuedAt,
    };
  }

  private async studentId(userId: string): Promise<string | null> {
    const s = await this.prisma.studentProfile.findUnique({ where: { userId } });
    return s?.id ?? null;
  }
}
