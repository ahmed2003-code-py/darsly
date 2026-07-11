import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Aggregated teaching KPIs for the teacher analytics dashboard. */
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async teacherOverview(tenantId: string) {
    const [payments, enrollments, activeEnrollments, reviews, quizAgg] = await Promise.all([
      this.prisma.payment.findMany({
        where: { tenantId, status: 'PAID' },
        select: { amountCents: true, paidAt: true, createdAt: true },
      }),
      this.prisma.enrollment.findMany({
        where: { tenantId },
        select: { createdAt: true, status: true },
      }),
      this.prisma.enrollment.findMany({
        where: { tenantId, status: 'ACTIVE' },
        select: { studentId: true, courseId: true },
      }),
      this.prisma.review.aggregate({ where: { tenantId }, _avg: { rating: true }, _count: true }),
      this.prisma.quizAttempt.findMany({
        where: { quiz: { lesson: { unit: { course: { tenantId } } } }, passed: { not: null } },
        select: { passed: true },
      }),
    ]);

    const months = lastMonths(6);
    const grossCents = payments.reduce((s, p) => s + p.amountCents, 0);
    const revenueByMonth = bucketByMonth(months, payments.map((p) => ({ at: p.paidAt ?? p.createdAt, v: p.amountCents })));
    const enrollmentsByMonth = bucketByMonth(months, enrollments.map((e) => ({ at: e.createdAt, v: 1 })));

    const activeStudents = new Set(activeEnrollments.map((e) => e.studentId)).size;

    // Completion rate: completed lessons ÷ lessons in the courses students are
    // actively enrolled in.
    const courseIds = [...new Set(activeEnrollments.map((e) => e.courseId))];
    const [lessonCounts, completedByStudent] = await Promise.all([
      courseIds.length
        ? this.prisma.lesson.groupBy({
            by: ['unitId'],
            where: { unit: { courseId: { in: courseIds } } },
            _count: true,
          })
        : Promise.resolve([]),
      this.prisma.lessonProgress.count({
        where: {
          completedAt: { not: null },
          lesson: { unit: { course: { tenantId } } },
          student: { enrollments: { some: { tenantId, status: 'ACTIVE' } } },
        },
      }),
    ]);
    // Total lessons per course (via units), then × active enrollments per course.
    const lessonsPerCourse = await this.lessonsPerCourse(courseIds);
    const totalRequired = activeEnrollments.reduce((s, e) => s + (lessonsPerCourse[e.courseId] ?? 0), 0);
    const completionRatePct = totalRequired ? Math.round((completedByStudent / totalRequired) * 100) : 0;

    const passed = quizAgg.filter((a) => a.passed).length;
    const quizPassRatePct = quizAgg.length ? Math.round((passed / quizAgg.length) * 100) : 0;

    const topLessons = await this.topLessons(tenantId);

    return {
      grossCents,
      activeStudents,
      totalEnrollments: enrollments.length,
      pendingEnrollments: enrollments.filter((e) => e.status === 'PENDING_APPROVAL').length,
      completionRatePct,
      quizPassRatePct,
      avgRating: reviews._avg.rating ? Math.round(reviews._avg.rating * 10) / 10 : null,
      reviewsCount: reviews._count,
      revenueByMonth,
      enrollmentsByMonth,
      topLessons,
    };
  }

  private async lessonsPerCourse(courseIds: string[]): Promise<Record<string, number>> {
    if (!courseIds.length) return {};
    const units = await this.prisma.courseUnit.findMany({
      where: { courseId: { in: courseIds } },
      select: { courseId: true, _count: { select: { lessons: true } } },
    });
    const map: Record<string, number> = {};
    for (const u of units) map[u.courseId] = (map[u.courseId] ?? 0) + u._count.lessons;
    return map;
  }

  private async topLessons(tenantId: string) {
    const rows = await this.prisma.lessonProgress.groupBy({
      by: ['lessonId'],
      where: { lesson: { unit: { course: { tenantId } } } },
      _sum: { viewCount: true },
      orderBy: { _sum: { viewCount: 'desc' } },
      take: 5,
    });
    const lessons = await this.prisma.lesson.findMany({
      where: { id: { in: rows.map((r) => r.lessonId) } },
      select: { id: true, title: true },
    });
    const titles = Object.fromEntries(lessons.map((l) => [l.id, l.title]));
    return rows
      .filter((r) => titles[r.lessonId])
      .map((r) => ({ lessonId: r.lessonId, title: titles[r.lessonId], views: r._sum.viewCount ?? 0 }));
  }
}

function lastMonths(n: number): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  const d = new Date();
  d.setDate(1);
  for (let i = n - 1; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push({
      key: `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`,
      label: m.toLocaleDateString('ar-EG', { month: 'short' }),
    });
  }
  return out;
}

function bucketByMonth(months: { key: string; label: string }[], items: { at: Date; v: number }[]) {
  const sums: Record<string, number> = Object.fromEntries(months.map((m) => [m.key, 0]));
  for (const it of items) {
    const d = new Date(it.at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (key in sums) sums[key] += it.v;
  }
  return months.map((m) => ({ label: m.label, value: sums[m.key] }));
}
