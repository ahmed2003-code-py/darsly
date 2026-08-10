import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Once a student is studying a subject with a teacher, stop showing them that
 * teacher's competitors.
 *
 * A student arrives through their own teacher's link, enrols, and then finds the
 * catalogue full of other people teaching the same thing. That is confusing at
 * best — the platform looks like it is touting rival tutors at the teacher who
 * brought the student in — and it is the teacher's own audience being marketed
 * to. So the rule is drawn by subject and it is absolute: enrol in Arabic with
 * one teacher and every *other* Arabic teacher disappears from browsing, while
 * every other subject stays exactly as open as before. The student can still
 * take physics, chemistry, anything — from anyone.
 *
 * Three things this deliberately does not do:
 *
 *   - it hides the teacher, not the course. A teacher's subject is what makes
 *     them a competitor, so a rival's whole catalogue goes, not only the courses
 *     that happen to be tagged with the same subject.
 *   - it applies to browsing, not to addressing. A direct link to a teacher's
 *     page still works; hiding someone from search is not the same as pretending
 *     they do not exist, and a student who was sent a link should not hit a 404.
 *   - it applies to students only. Teachers and admins see the whole platform,
 *     and anonymous visitors have no enrolments to reason from.
 */

/** Enrolments that count as "I study with this teacher". */
const COMMITTED = ['ACTIVE', 'PENDING_APPROVAL'] as const;

@Injectable()
export class SubjectExclusivityService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The teachers this viewer must not be shown in a listing.
   *
   * Empty for anyone with nothing to protect — anonymous visitors, staff, and
   * students who have not enrolled anywhere yet — so the common case costs one
   * indexed lookup and no filtering at all.
   */
  async hiddenTeacherIds(userId?: string | null): Promise<string[]> {
    if (!userId) return [];

    const student = await this.prisma.studentProfile.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!student) return [];

    // Expired and revoked enrolments are left out on purpose: the relationship
    // is over, and a student who has finished with a teacher should be able to
    // find another one.
    const mine = await this.prisma.enrollment.findMany({
      where: { studentId: student.id, status: { in: [...COMMITTED] } },
      select: { tenantId: true },
      distinct: ['tenantId'],
    });
    const myTeacherIds = mine.map((e) => e.tenantId);
    if (!myTeacherIds.length) return [];

    const myTeachers = await this.prisma.teacherProfile.findMany({
      where: { id: { in: myTeacherIds } },
      select: { subjectId: true },
    });
    const subjectIds = [...new Set(myTeachers.map((t) => t.subjectId).filter((s): s is string => !!s))];
    if (!subjectIds.length) return [];

    const rivals = await this.prisma.teacherProfile.findMany({
      where: { subjectId: { in: subjectIds }, id: { notIn: myTeacherIds } },
      select: { id: true },
    });
    return rivals.map((t) => t.id);
  }
}
