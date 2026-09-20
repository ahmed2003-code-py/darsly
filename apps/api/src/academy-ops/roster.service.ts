import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const MAX_PAGE_SIZE = 100;

export interface RosterQuery {
  search?: string;
  page?: number;
  pageSize?: number;
}

/**
 * The academy-wide student roster — distinct from per-course Enrollment.
 * Enrollment is still the source of truth for "who is a student of this
 * academy" (same convention as GamificationAnalyticsService.studentsOf),
 * not AcademyMembership, which today only reliably tracks staff + a
 * student's single home academy.
 */
@Injectable()
export class RosterService {
  constructor(private readonly prisma: PrismaService) {}

  async roster(academyId: string, query: RosterQuery) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? 20));
    const search = query.search?.trim();

    const where: Prisma.StudentProfileWhereInput = {
      enrollments: { some: { tenantId: academyId } },
      ...(search
        ? {
            user: {
              OR: [
                { fullName: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    };

    const [total, students] = await Promise.all([
      this.prisma.studentProfile.count({ where }),
      this.prisma.studentProfile.findMany({
        where,
        orderBy: { user: { fullName: 'asc' } },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          user: { select: { fullName: true, email: true, avatarUrl: true } },
          groupMemberships: {
            where: { academyId, deletedAt: null },
            select: { group: { select: { id: true, name: true } } },
          },
        },
      }),
    ]);

    const ids = students.map((s) => s.id);
    const [enrollmentAgg, activeCounts, lastActivity] = await Promise.all([
      this.prisma.enrollment.groupBy({
        by: ['studentId'],
        where: { tenantId: academyId, studentId: { in: ids } },
        _count: { _all: true },
        _min: { createdAt: true },
      }),
      this.prisma.enrollment.groupBy({
        by: ['studentId'],
        where: { tenantId: academyId, studentId: { in: ids }, status: 'ACTIVE' },
        _count: { _all: true },
      }),
      this.lastActivityBatch(academyId, ids),
    ]);
    const enrollmentByStudent = new Map(enrollmentAgg.map((r) => [r.studentId, r]));
    const activeByStudent = new Map(activeCounts.map((r) => [r.studentId, r._count._all]));

    return {
      total,
      page,
      pageSize,
      students: students.map((s) => {
        const enr = enrollmentByStudent.get(s.id);
        return {
          id: s.id,
          fullName: s.user.fullName,
          email: s.user.email,
          avatarUrl: s.user.avatarUrl,
          groups: s.groupMemberships.map((m) => m.group),
          enrollmentsCount: enr?._count._all ?? 0,
          isActive: (activeByStudent.get(s.id) ?? 0) > 0,
          joinedAt: enr?._min.createdAt ?? null,
          lastActivityAt: lastActivity.get(s.id) ?? null,
        };
      }),
    };
  }

  /** Raw query — bypasses the soft-delete middleware; GamificationEvent has
   *  no deletedAt column, so nothing to filter for it. */
  private async lastActivityBatch(academyId: string, studentIds: string[]): Promise<Map<string, Date | null>> {
    const map = new Map<string, Date | null>(studentIds.map((id) => [id, null]));
    if (studentIds.length === 0) return map;
    const rows = await this.prisma.$queryRaw<{ studentId: string; last: Date }[]>`
      SELECT "studentId", MAX("createdAt") AS last
      FROM "GamificationEvent"
      WHERE "tenantId" = ${academyId} AND "studentId" = ANY(${studentIds}::text[])
      GROUP BY "studentId"
    `;
    for (const r of rows) map.set(r.studentId, r.last);
    return map;
  }
}
