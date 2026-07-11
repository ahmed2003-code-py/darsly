import { Injectable } from '@nestjs/common';
import { ContinueWatchingItem, StudentProgressSummary } from '@darsly/shared-types';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProgressService {
  constructor(private readonly prisma: PrismaService) {}

  private async studentId(userId: string): Promise<string | null> {
    const s = await this.prisma.studentProfile.findUnique({ where: { userId } });
    return s?.id ?? null;
  }

  /** In-progress lessons (started, not finished), newest activity first. */
  async continueWatching(userId: string): Promise<ContinueWatchingItem[]> {
    const sid = await this.studentId(userId);
    if (!sid) return [];
    const rows = await this.prisma.lessonProgress.findMany({
      where: { studentId: sid, watchedPct: { gt: 0, lt: 95 }, completedAt: null },
      orderBy: { updatedAt: 'desc' },
      take: 8,
      include: {
        lesson: {
          include: {
            unit: {
              include: {
                course: {
                  include: { teacher: { include: { user: { select: { fullName: true } } } } },
                },
              },
            },
          },
        },
      },
    });
    return rows.map((r) => {
      const course = r.lesson.unit.course;
      return {
        lessonId: r.lessonId,
        lessonTitle: r.lesson.title,
        courseId: course.id,
        courseTitle: course.title,
        thumbnailUrl: course.thumbnailUrl,
        teacherName: course.teacher.user.fullName,
        watchedPct: r.watchedPct,
        lastPositionSec: r.lastPositionSec,
        durationSec: r.lesson.durationSec,
      };
    });
  }

  async summary(userId: string): Promise<StudentProgressSummary> {
    const student = await this.prisma.studentProfile.findUnique({ where: { userId } });
    if (!student) {
      return {
        currentStreak: 0, longestStreak: 0, weeklyGoalLessons: 5,
        lessonsCompletedThisWeek: 0, weeklyGoalPct: 0, totalLessonsCompleted: 0, activeCourses: 0,
      };
    }
    const weekStart = startOfWeek();
    const [thisWeek, total, activeCourses] = await Promise.all([
      this.prisma.lessonProgress.count({
        where: { studentId: student.id, completedAt: { gte: weekStart } },
      }),
      this.prisma.lessonProgress.count({
        where: { studentId: student.id, completedAt: { not: null } },
      }),
      this.prisma.enrollment.count({ where: { studentId: student.id, status: 'ACTIVE' } }),
    ]);
    const goal = student.weeklyGoalLessons || 5;
    return {
      currentStreak: student.currentStreak,
      longestStreak: student.longestStreak,
      weeklyGoalLessons: goal,
      lessonsCompletedThisWeek: thisWeek,
      weeklyGoalPct: Math.min(100, Math.round((thisWeek / goal) * 100)),
      totalLessonsCompleted: total,
      activeCourses,
    };
  }

  /**
   * Record learning activity and roll the daily streak. Called from playback
   * heartbeats. Same-day = no-op; consecutive day = +1; a gap resets to 1.
   */
  async touchActivity(studentId: string) {
    const student = await this.prisma.studentProfile.findUnique({ where: { id: studentId } });
    if (!student) return;
    const today = startOfDay(new Date());
    const last = student.lastActivityDate ? startOfDay(student.lastActivityDate) : null;
    if (last && last.getTime() === today.getTime()) return; // already counted today

    const yesterday = new Date(today.getTime() - 86_400_000);
    const nextStreak =
      last && last.getTime() === yesterday.getTime() ? student.currentStreak + 1 : 1;
    await this.prisma.studentProfile.update({
      where: { id: studentId },
      data: {
        currentStreak: nextStreak,
        longestStreak: Math.max(student.longestStreak, nextStreak),
        lastActivityDate: new Date(),
      },
    });
  }

  async setWeeklyGoal(userId: string, goal: number) {
    const sid = await this.studentId(userId);
    if (!sid) return;
    await this.prisma.studentProfile.update({
      where: { id: sid },
      data: { weeklyGoalLessons: Math.max(1, Math.min(50, goal)) },
    });
    return this.summary(userId);
  }
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function startOfWeek(): Date {
  const x = startOfDay(new Date());
  // Week starts Saturday (common in Egypt); getDay(): Sat=6.
  const diff = (x.getDay() + 1) % 7; // days since Saturday
  x.setDate(x.getDate() - diff);
  return x;
}
