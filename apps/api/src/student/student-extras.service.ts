import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class StudentExtrasService {
  constructor(private readonly prisma: PrismaService) {}

  private async studentId(userId: string): Promise<string> {
    const s = await this.prisma.studentProfile.findUnique({ where: { userId }, select: { id: true } });
    if (!s) throw new BadRequestException('No student profile for this account');
    return s.id;
  }

  // ── Saved / wishlist ────────────────────────────────────────────────────────

  async save(userId: string, courseId: string) {
    const studentId = await this.studentId(userId);
    const course = await this.prisma.course.findFirst({ where: { id: courseId }, select: { id: true } });
    if (!course) throw new NotFoundException('Course not found');
    await this.prisma.savedCourse.upsert({
      where: { studentId_courseId: { studentId, courseId } },
      update: {},
      create: { studentId, courseId },
    });
    return { saved: true };
  }

  async unsave(userId: string, courseId: string) {
    const studentId = await this.studentId(userId);
    await this.prisma.savedCourse.deleteMany({ where: { studentId, courseId } });
    return { saved: false };
  }

  async listSaved(userId: string) {
    const studentId = await this.studentId(userId);
    const rows = await this.prisma.savedCourse.findMany({
      where: { studentId, course: { deletedAt: null } },
      orderBy: { createdAt: 'desc' },
      include: {
        course: {
          include: {
            subject: true,
            teacher: { select: { slug: true, user: { select: { fullName: true } } } },
            _count: { select: { enrollments: { where: { status: 'ACTIVE' } } } },
          },
        },
      },
    });
    return rows.map((r) => ({
      id: r.course.id,
      title: r.course.title,
      thumbnailUrl: r.course.thumbnailUrl,
      priceCents: r.course.priceCents,
      pricingModel: r.course.pricingModel,
      subject: r.course.subject?.nameAr ?? r.course.subject?.nameEn,
      teacherName: r.course.teacher.user.fullName,
      teacherSlug: r.course.teacher.slug,
      studentsCount: r.course._count.enrollments,
      savedAt: r.createdAt,
    }));
  }

  /** Course ids the student has saved — for hydrating heart toggles. */
  async savedIds(userId: string): Promise<string[]> {
    const studentId = await this.studentId(userId);
    const rows = await this.prisma.savedCourse.findMany({ where: { studentId }, select: { courseId: true } });
    return rows.map((r) => r.courseId);
  }

  // ── Achievement badges (computed from existing activity) ─────────────────────

  async badges(userId: string) {
    const student = await this.prisma.studentProfile.findUnique({
      where: { userId },
      select: { id: true, longestStreak: true, currentStreak: true },
    });
    if (!student) return [];

    const [enrollments, certificates, completedLessons, bestQuiz] = await Promise.all([
      this.prisma.enrollment.count({ where: { studentId: student.id } }),
      this.prisma.certificate.count({ where: { studentId: student.id } }),
      this.prisma.lessonProgress.count({ where: { studentId: student.id, completedAt: { not: null } } }),
      this.prisma.quizAttempt.findFirst({
        where: { studentId: student.id, scorePct: 100 },
        select: { id: true },
      }),
    ]);
    const streak = Math.max(student.longestStreak, student.currentStreak);

    const defs: {
      key: string; icon: string; title: string; desc: string; earned: boolean; progress: number; goal: number;
    }[] = [
      { key: 'first_enroll', icon: 'rocket_launch', title: 'أول خطوة', desc: 'اشترك في أول دورة', earned: enrollments >= 1, progress: Math.min(enrollments, 1), goal: 1 },
      { key: 'streak_7', icon: 'local_fire_department', title: 'مواظبة أسبوع', desc: 'حافظ على ٧ أيام متتالية', earned: streak >= 7, progress: Math.min(streak, 7), goal: 7 },
      { key: 'dedicated', icon: 'military_tech', title: 'مثابر', desc: 'أكمِل ١٠ دروس', earned: completedLessons >= 10, progress: Math.min(completedLessons, 10), goal: 10 },
      { key: 'quiz_ace', icon: 'stars', title: 'بطل الاختبارات', desc: 'احصل على ١٠٠٪ في اختبار', earned: !!bestQuiz, progress: bestQuiz ? 1 : 0, goal: 1 },
      { key: 'first_certificate', icon: 'workspace_premium', title: 'متخرّج', desc: 'احصل على أول شهادة', earned: certificates >= 1, progress: Math.min(certificates, 1), goal: 1 },
      { key: 'scholar', icon: 'school', title: 'عالِم', desc: 'اجمع ٣ شهادات', earned: certificates >= 3, progress: Math.min(certificates, 3), goal: 3 },
    ];
    return defs;
  }
}
