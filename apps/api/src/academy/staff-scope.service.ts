import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AcademyContext } from './academy-context';
import { AcademyService } from './academy.service';
import { Capability } from './permissions';

/**
 * What one staff member's work reaches inside one academy: a set of courses,
 * and through them a set of students.
 *
 * The one place that answers "may this person see this course / this
 * student". Routes do not compare roles or read membership rows themselves;
 * they ask here, and every answer is a Prisma filter built from the
 * membership as it is NOW — read on every request, never cached, never
 * carried in a token — so taking a course away from an assistant takes it
 * away on their very next request.
 *
 *   - OWNER (and the platform admin): every course of the academy.
 *   - TEACHER: the courses they wrote there.
 *   - ASSISTANT, ALL courses: every course of the academy.
 *   - ASSISTANT, SELECTED: exactly the courses in MembershipCourse.
 *
 * A student is in scope when they have an enrollment (of any status — a
 * revoked student asking why is exactly who support is for) in a course that
 * is in scope. Nothing else makes them visible.
 */
export interface StaffScope {
  ctx: AcademyContext;
  /** Courses this member's work reaches, as a filter on Course. */
  courses: Prisma.CourseWhereInput;
}

@Injectable()
export class StaffScopeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly academy: AcademyService,
  ) {}

  /** The scope of a request that already passed AcademyMembershipGuard. */
  async forContext(ctx: AcademyContext): Promise<StaffScope> {
    return { ctx, courses: await this.courseFilter(ctx) };
  }

  /**
   * The scope for a path that is not behind the academy guard (messaging):
   * the membership is resolved here, with the same checks the guard makes.
   * Null when there is no live staff membership.
   */
  async resolve(userId: string, academyId: string, globalRole?: string) {
    const ctx = await this.academy.buildContext(userId, academyId, globalRole);
    if (!ctx || ctx.role === 'STUDENT') return null;
    return this.forContext(ctx);
  }

  /** Throws 403 unless the member holds the capability. */
  require(scope: StaffScope, cap: Capability) {
    if (!scope.ctx.can(cap)) throw new ForbiddenException(`Requires permission: ${cap}`);
  }

  private async courseFilter(ctx: AcademyContext): Promise<Prisma.CourseWhereInput> {
    const base: Prisma.CourseWhereInput = { academyId: ctx.academyId, deletedAt: null };
    if (ctx.isPlatformAdmin || ctx.role === 'OWNER') return base;
    if (ctx.role === 'ASSISTANT') {
      if (ctx.courseScope === 'SELECTED') {
        return {
          ...base,
          staffScopes: { some: { membershipId: ctx.membershipId ?? '__none__' } },
        };
      }
      return base;
    }
    if (ctx.role === 'TEACHER') {
      const teacher = await this.prisma.teacherProfile.findUnique({
        where: { userId: ctx.userId },
        select: { id: true },
      });
      return { ...base, tenantId: teacher?.id ?? '__none__' };
    }
    return { id: '__none__' };
  }

  /**
   * Students of the courses in scope — and, for a member who sees the whole
   * academy's register (the owner, the platform admin, or a holder of
   * `student.directory`), every learner on that register too, which is how a
   * learner registered at the desk with no course is reachable from Student
   * 360. A course-scoped teacher or assistant is unchanged: their students
   * are still exactly those of their courses.
   */
  studentWhere(scope: StaffScope): Prisma.StudentProfileWhereInput {
    const enrolled: Prisma.StudentProfileWhereInput = {
      enrollments: { some: { course: scope.courses } },
    };
    const { ctx } = scope;
    if (!(ctx.isPlatformAdmin || ctx.role === 'OWNER' || ctx.can('student.directory'))) {
      return enrolled;
    }
    return { OR: [enrolled, { academyRecords: { some: { academyId: ctx.academyId } } }] };
  }

  /** Enrollments in the courses in scope — for listing what connects a student. */
  enrollmentWhere(scope: StaffScope): Prisma.EnrollmentWhereInput {
    return { course: scope.courses };
  }

  /** 404 — not 403 — for a course outside the scope: its existence is not ours to confirm. */
  async assertCourse(scope: StaffScope, courseId: string) {
    const found = await this.prisma.course.findFirst({
      where: { AND: [scope.courses, { id: courseId }] },
      select: { id: true, tenantId: true, title: true },
    });
    if (!found) throw new NotFoundException('Course not found');
    return found;
  }

  async assertStudent(scope: StaffScope, studentId: string) {
    const found = await this.prisma.studentProfile.findFirst({
      where: { AND: [this.studentWhere(scope), { id: studentId }] },
      select: { id: true, userId: true },
    });
    if (!found) throw new NotFoundException('Student not found');
    return found;
  }

  async hasStudent(scope: StaffScope, studentId: string): Promise<boolean> {
    const n = await this.prisma.studentProfile.count({
      where: { AND: [this.studentWhere(scope), { id: studentId }] },
    });
    return n > 0;
  }
}
