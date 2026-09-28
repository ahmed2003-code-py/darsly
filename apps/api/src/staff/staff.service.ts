import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CAPABILITIES } from '../academy/permissions';
import { StaffScope, StaffScopeService } from '../academy/staff-scope.service';
import { avatarUrl } from '../common/signed-link';
import { PrismaService } from '../prisma/prisma.service';

const STUDENT_PAGE = 50;

/**
 * The assistant's own workspace: the courses they work on, the students of
 * those courses, and what each of those students has done. Everything here
 * is read through a StaffScope — there is no query in this file that is not
 * narrowed by the member's courses.
 */
@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: StaffScopeService,
  ) {}

  /** Who I am here and what I may do — drives the workspace's navigation. */
  async me(scope: StaffScope) {
    const { ctx } = scope;
    const [academy, membership] = await Promise.all([
      this.prisma.academy.findUnique({
        where: { id: ctx.academyId },
        select: { id: true, slug: true, name: true, logoUrl: true, kind: true },
      }),
      ctx.membershipId
        ? this.prisma.academyMembership.findUnique({
            where: { id: ctx.membershipId },
            select: { title: true, directContact: true },
          })
        : null,
    ]);
    const courses = await this.prisma.course.findMany({
      where: scope.courses,
      orderBy: { createdAt: 'desc' },
      select: { id: true, title: true },
    });
    return {
      academy,
      role: ctx.role,
      title: membership?.title ?? null,
      directContact: membership?.directContact ?? false,
      courseScope: ctx.courseScope ?? 'ALL',
      permissions: CAPABILITIES.filter((c) => ctx.can(c)),
      courses,
    };
  }

  /** My courses, each with how many students it has. */
  async courses(scope: StaffScope) {
    const rows = await this.prisma.course.findMany({
      where: scope.courses,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        status: true,
        thumbnailUrl: true,
        _count: { select: { enrollments: true } },
      },
    });
    return rows.map((c) => ({
      id: c.id,
      title: c.title,
      status: c.status,
      thumbnailUrl: c.thumbnailUrl,
      students: c._count.enrollments,
    }));
  }

  /**
   * The students of my courses — or of one of them. A course outside my scope
   * is a 404 before anything is listed, so its id tells the caller nothing.
   */
  async students(scope: StaffScope, q: { courseId?: string; search?: string; cursor?: string }) {
    if (q.courseId) await this.scopes.assertCourse(scope, q.courseId);
    const enrollmentIn: Prisma.EnrollmentWhereInput = q.courseId
      ? { course: { AND: [scope.courses, { id: q.courseId }] } }
      : this.scopes.enrollmentWhere(scope);
    const search = q.search?.trim();
    const rows = await this.prisma.studentProfile.findMany({
      where: {
        enrollments: { some: enrollmentIn },
        ...(search ? { user: { fullName: { contains: search, mode: 'insensitive' } } } : {}),
      },
      orderBy: { id: 'asc' },
      take: STUDENT_PAGE + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        user: { select: { id: true, fullName: true, avatarUrl: true, updatedAt: true } },
        // Only the enrollments that are mine to see — never the student's
        // courses with other teachers, or in this academy outside my scope.
        enrollments: {
          where: this.scopes.enrollmentWhere(scope),
          select: { status: true, createdAt: true, course: { select: { id: true, title: true } } },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    const more = rows.length > STUDENT_PAGE;
    const page = more ? rows.slice(0, STUDENT_PAGE) : rows;
    return {
      items: page.map((s) => ({
        id: s.id,
        name: s.user.fullName,
        avatarUrl: avatarUrl(s.user),
        courses: s.enrollments.map((e) => ({
          id: e.course.id,
          title: e.course.title,
          status: e.status,
          since: e.createdAt,
        })),
      })),
      nextCursor: more ? page[page.length - 1].id : null,
    };
  }

  /** One student, as far as my courses go. */
  async student(scope: StaffScope, studentId: string) {
    await this.scopes.assertStudent(scope, studentId);
    const s = await this.prisma.studentProfile.findUniqueOrThrow({
      where: { id: studentId },
      select: {
        id: true,
        user: { select: { id: true, fullName: true, avatarUrl: true, updatedAt: true } },
        enrollments: {
          where: this.scopes.enrollmentWhere(scope),
          select: {
            status: true,
            createdAt: true,
            expiresAt: true,
            course: { select: { id: true, title: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    return {
      id: s.id,
      userId: s.user.id,
      name: s.user.fullName,
      avatarUrl: avatarUrl(s.user),
      courses: s.enrollments.map((e) => ({
        id: e.course.id,
        title: e.course.title,
        status: e.status,
        since: e.createdAt,
        expiresAt: e.expiresAt,
      })),
      can: {
        progress: scope.ctx.can('progress.view'),
        message: scope.ctx.can('message.reply'),
      },
    };
  }

  /**
   * What a student has done in my courses: lessons finished, their latest
   * quiz results, their assignments. Per course, and only my courses.
   */
  async progress(scope: StaffScope, studentId: string) {
    await this.scopes.assertStudent(scope, studentId);
    const courses = await this.prisma.course.findMany({
      where: { AND: [scope.courses, { enrollments: { some: { studentId } } }] },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        units: {
          where: { deletedAt: null },
          orderBy: { sortOrder: 'asc' },
          select: {
            lessons: {
              where: { deletedAt: null },
              orderBy: { sortOrder: 'asc' },
              select: {
                id: true,
                title: true,
                type: true,
                progress: {
                  where: { studentId },
                  select: { watchedPct: true, completedAt: true, updatedAt: true },
                },
                quiz: {
                  select: {
                    attempts: {
                      where: { studentId, voidedAt: null, submittedAt: { not: null } },
                      orderBy: { submittedAt: 'desc' },
                      take: 1,
                      select: {
                        scorePct: true,
                        passed: true,
                        needsManualGrading: true,
                        submittedAt: true,
                      },
                    },
                  },
                },
                assignment: {
                  select: {
                    maxScore: true,
                    submissions: {
                      where: { studentId },
                      select: { score: true, gradedAt: true, createdAt: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    return courses.map((c) => {
      const lessons = c.units.flatMap((u) => u.lessons);
      const completed = lessons.filter((l) => l.progress[0]?.completedAt).length;
      const lastActivity = lessons
        .map((l) => l.progress[0]?.updatedAt)
        .filter((d): d is Date => !!d)
        .sort((a, b) => b.getTime() - a.getTime())[0];
      return {
        course: { id: c.id, title: c.title },
        lessons: { total: lessons.length, completed },
        percent: lessons.length ? Math.round((completed / lessons.length) * 100) : 0,
        lastActivityAt: lastActivity ?? null,
        quizzes: lessons
          .filter((l) => l.quiz?.attempts.length)
          .map((l) => ({
            lessonId: l.id,
            lessonTitle: l.title,
            ...l.quiz!.attempts[0],
          })),
        assignments: lessons
          .filter((l) => l.assignment?.submissions.length)
          .map((l) => ({
            lessonId: l.id,
            lessonTitle: l.title,
            maxScore: l.assignment!.maxScore,
            score: l.assignment!.submissions[0].score,
            gradedAt: l.assignment!.submissions[0].gradedAt,
            submittedAt: l.assignment!.submissions[0].createdAt,
          })),
      };
    });
  }

  /**
   * Payments for my courses — read only. Never the wallet, never a balance,
   * never another course's money; only granted with payment.view.
   */
  async payments(scope: StaffScope, status?: string) {
    const rows = await this.prisma.payment.findMany({
      where: {
        academyId: scope.ctx.academyId,
        course: scope.courses,
        ...(status ? { status: status as any } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        amountCents: true,
        currency: true,
        status: true,
        method: true,
        createdAt: true,
        course: { select: { id: true, title: true } },
        student: { select: { id: true, user: { select: { fullName: true } } } },
      },
    });
    return rows.map((p) => ({
      id: p.id,
      amountCents: p.amountCents,
      currency: p.currency,
      status: p.status,
      method: p.method,
      createdAt: p.createdAt,
      course: p.course,
      student: p.student ? { id: p.student.id, name: p.student.user.fullName } : null,
    }));
  }
}
