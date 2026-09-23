import { Injectable, NotFoundException } from '@nestjs/common';
import { AcademyKind, AcademyStatus, Prisma } from '@prisma/client';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { LedgerService } from '../payments/ledger.service';
import { PrismaService } from '../prisma/prisma.service';

export interface ListAcademiesQuery {
  search?: string;
  status?: AcademyStatus;
  kind?: AcademyKind;
  page?: number;
  pageSize?: number;
}

const MAX_PAGE_SIZE = 100;

/**
 * Platform-admin view over academies — list + drill-down. Every per-academy
 * count/revenue figure for a page of academies is fetched in one batched
 * query keyed by academyId, never one query per academy in a loop.
 */
@Injectable()
export class AdminAcademiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly flags: FeatureFlagsService,
  ) {}

  /** Distinct enrolled students per academy — Enrollment is the source of
   *  truth for "students of an academy" (same convention as
   *  GamificationAnalyticsService.studentsOf), not AcademyMembership, which
   *  today only reliably tracks staff + a student's single home academy. */
  private async studentCountsBatch(tenantIds: string[]): Promise<Map<string, number>> {
    const map = new Map(tenantIds.map((id) => [id, 0]));
    if (tenantIds.length === 0) return map;
    // Raw query — bypasses the soft-delete middleware, so deletedAt has to be
    // filtered explicitly here (Enrollment is a soft-delete model).
    const rows = await this.prisma.$queryRaw<{ academyId: string; cnt: bigint }[]>`
      SELECT "academyId", COUNT(DISTINCT "studentId") AS cnt
      FROM "Enrollment"
      WHERE "academyId" = ANY(${tenantIds}::text[]) AND "deletedAt" IS NULL
      GROUP BY "academyId"
    `;
    for (const r of rows) map.set(r.academyId, Number(r.cnt));
    return map;
  }

  /** Most recent recorded learning activity per academy — real, not approximated. */
  private async lastActivityBatch(tenantIds: string[]): Promise<Map<string, Date | null>> {
    const map = new Map<string, Date | null>(tenantIds.map((id) => [id, null]));
    if (tenantIds.length === 0) return map;
    const rows = await this.prisma.$queryRaw<{ tenantId: string; last: Date }[]>`
      SELECT "tenantId", MAX("createdAt") AS last
      FROM "GamificationEvent"
      WHERE "tenantId" = ANY(${tenantIds}::text[])
      GROUP BY "tenantId"
    `;
    for (const r of rows) map.set(r.tenantId, r.last);
    return map;
  }

  async listAcademies(query: ListAcademiesQuery) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? 20));
    const search = query.search?.trim();

    const where: Prisma.AcademyWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { slug: { contains: search, mode: 'insensitive' } },
              { owner: { fullName: { contains: search, mode: 'insensitive' } } },
              { owner: { email: { contains: search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const [total, academies] = await Promise.all([
      this.prisma.academy.count({ where }),
      this.prisma.academy.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          slug: true,
          name: true,
          status: true,
          kind: true,
          createdAt: true,
          owner: { select: { fullName: true, email: true, role: true } },
        },
      }),
    ]);

    const ids = academies.map((a) => a.id);
    const [
      courseCounts,
      publishedCounts,
      enrollmentCounts,
      staffRows,
      studentCounts,
      revenue,
      lastActivity,
    ] = await Promise.all([
      this.prisma.course.groupBy({
        by: ['academyId'],
        where: { academyId: { in: ids } },
        _count: { _all: true },
      }),
      this.prisma.course.groupBy({
        by: ['academyId'],
        where: { academyId: { in: ids }, status: 'PUBLISHED' },
        _count: { _all: true },
      }),
      this.prisma.enrollment.groupBy({
        by: ['academyId'],
        where: { academyId: { in: ids } },
        _count: { _all: true },
      }),
      this.prisma.academyMembership.groupBy({
        by: ['academyId', 'role'],
        where: { academyId: { in: ids }, deletedAt: null },
        _count: { _all: true },
      }),
      this.studentCountsBatch(ids),
      this.ledger.academyRevenueBatch(ids),
      this.lastActivityBatch(ids),
    ]);

    const courseByTenant = new Map(courseCounts.map((r) => [r.academyId, r._count._all]));
    const publishedByTenant = new Map(publishedCounts.map((r) => [r.academyId, r._count._all]));
    const enrollmentByTenant = new Map(enrollmentCounts.map((r) => [r.academyId, r._count._all]));
    const staffByAcademy = new Map<string, { teachers: number; assistants: number }>();
    for (const row of staffRows) {
      const entry = staffByAcademy.get(row.academyId) ?? { teachers: 0, assistants: 0 };
      if (row.role === 'OWNER' || row.role === 'TEACHER') entry.teachers += row._count._all;
      if (row.role === 'ASSISTANT') entry.assistants += row._count._all;
      staffByAcademy.set(row.academyId, entry);
    }

    return {
      total,
      page,
      pageSize,
      academies: academies.map((a) => {
        const rev = revenue.get(a.id) ?? { netCents: 0, feeCents: 0 };
        const staff = staffByAcademy.get(a.id) ?? { teachers: 0, assistants: 0 };
        return {
          id: a.id,
          slug: a.slug,
          name: a.name,
          status: a.status,
          kind: a.kind,
          createdAt: a.createdAt,
          ownerName: a.owner.fullName,
          ownerRole: a.owner.role,
          ownerEmail: a.owner.email,
          teachersCount: staff.teachers,
          assistantsCount: staff.assistants,
          studentsCount: studentCounts.get(a.id) ?? 0,
          coursesCount: courseByTenant.get(a.id) ?? 0,
          publishedCoursesCount: publishedByTenant.get(a.id) ?? 0,
          enrollmentsCount: enrollmentByTenant.get(a.id) ?? 0,
          netRevenueCents: rev.netCents,
          platformFeeCents: rev.feeCents,
          lastActivityAt: lastActivity.get(a.id) ?? null,
        };
      }),
    };
  }

  async academyDetail(academyId: string) {
    const academy = await this.prisma.academy.findFirst({
      where: { id: academyId, deletedAt: null },
      select: {
        id: true,
        slug: true,
        name: true,
        status: true,
        kind: true,
        createdAt: true,
        language: true,
        currency: true,
        feeType: true,
        feeValue: true,
        owner: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            role: true,
            isActive: true,
          },
        },
        domains: { select: { hostname: true, isPrimary: true, verifiedAt: true } },
      },
    });
    if (!academy) throw new NotFoundException('Academy not found');

    const [
      members,
      courseCount,
      publishedCount,
      enrollmentCount,
      studentCounts,
      revenue,
      lastActivity,
      flags,
    ] = await Promise.all([
      this.prisma.academyMembership.findMany({
        where: { academyId, deletedAt: null, role: { not: 'STUDENT' } },
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
        include: { user: { select: { fullName: true, email: true, avatarUrl: true } } },
      }),
      this.prisma.course.count({ where: { academyId } }),
      this.prisma.course.count({ where: { academyId, status: 'PUBLISHED' } }),
      this.prisma.enrollment.count({ where: { academyId } }),
      this.studentCountsBatch([academyId]),
      this.ledger.academyRevenueBatch([academyId]),
      this.lastActivityBatch([academyId]),
      this.flags.listForAcademy(academyId),
    ]);

    const rev = revenue.get(academyId) ?? { netCents: 0, feeCents: 0 };
    return {
      id: academy.id,
      slug: academy.slug,
      name: academy.name,
      status: academy.status,
      kind: academy.kind,
      createdAt: academy.createdAt,
      language: academy.language,
      currency: academy.currency,
      feeType: academy.feeType,
      feeValue: academy.feeValue,
      owner: academy.owner,
      domains: academy.domains,
      staff: members.map((m) => ({
        id: m.id,
        userId: m.userId,
        role: m.role,
        status: m.status,
        fullName: m.user.fullName,
        email: m.user.email,
        avatarUrl: m.user.avatarUrl,
      })),
      coursesCount: courseCount,
      publishedCoursesCount: publishedCount,
      enrollmentsCount: enrollmentCount,
      studentsCount: studentCounts.get(academyId) ?? 0,
      netRevenueCents: rev.netCents,
      platformFeeCents: rev.feeCents,
      lastActivityAt: lastActivity.get(academyId) ?? null,
      featureFlags: flags,
    };
  }
}
