import { Injectable } from '@nestjs/common';
import { AcademyRole } from '@prisma/client';
import { Role } from '@darsly/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AcademyContext } from './academy-context';
import { Capability, permissionsFor, ROLE_PERMISSIONS } from './permissions';

@Injectable()
export class AcademyService {
  constructor(private readonly prisma: PrismaService) {}

  /** Feature flag — the whole academy-context layer is opt-in until rollout. */
  isEnabled(): boolean {
    return process.env.ACADEMY_CONTEXT_ENABLED !== 'false';
  }

  /** Every academy the user belongs to (for the academy switcher / home). */
  async listMyMemberships(userId: string) {
    const rows = await this.prisma.academyMembership.findMany({
      where: {
        userId,
        status: 'ACTIVE',
        academy: { deletedAt: null, status: { not: 'ARCHIVED' } },
      },
      orderBy: [{ isHome: 'desc' }, { createdAt: 'asc' }],
      include: {
        academy: {
          select: {
            id: true, slug: true, name: true, status: true,
            logoUrl: true, colorPrimary: true, colorAccent: true,
          },
        },
      },
    });
    return rows
      .map((m) => ({
        academyId: m.academyId,
        slug: m.academy.slug,
        name: m.academy.name,
        role: m.role,
        isHome: m.isHome,
        status: m.academy.status,
        branding: { logoUrl: m.academy.logoUrl, colorPrimary: m.academy.colorPrimary, colorAccent: m.academy.colorAccent },
      }));
  }

  /** Public branding for an academy landing page (no membership required). */
  async getPublicBySlug(slug: string) {
    const a = await this.prisma.academy.findFirst({
      where: { slug, deletedAt: null, status: { in: ['ACTIVE', 'PENDING'] } },
      select: {
        id: true, slug: true, name: true, tagline: true, status: true,
        logoUrl: true, coverUrl: true, colorPrimary: true, colorAccent: true, language: true,
      },
    });
    return a;
  }

  /**
   * Resolve the target academyId for a request, in priority order:
   *   1. verified custom/subdomain host  (AcademyDomain.hostname)
   *   2. X-Academy-Id / X-Academy-Slug header, or a :slug route param
   *   3. (future) JWT activeAcademyId claim
   * Returns null if none resolves.
   */
  async resolveAcademyId(req: any): Promise<string | null> {
    // 1) host / subdomain
    const host = (req.headers?.['x-forwarded-host'] || req.headers?.host || '').split(':')[0].toLowerCase();
    if (host) {
      const domain = await this.prisma.academyDomain.findFirst({
        where: { hostname: host, verifiedAt: { not: null } },
        select: { academyId: true },
      });
      if (domain) return domain.academyId;
    }
    // 2) explicit id
    const headerId = req.headers?.['x-academy-id'];
    if (typeof headerId === 'string' && headerId) {
      const exists = await this.prisma.academy.findFirst({ where: { id: headerId, deletedAt: null }, select: { id: true } });
      if (exists) return exists.id;
    }
    // 2) slug (header or route param)
    const slug = (req.headers?.['x-academy-slug'] as string) || req.params?.slug || req.params?.academySlug;
    if (typeof slug === 'string' && slug) {
      const bySlug = await this.prisma.academy.findFirst({ where: { slug, deletedAt: null }, select: { id: true } });
      if (bySlug) return bySlug.id;
    }
    // 3) fallback: the teacher's own academy from the JWT tenantId (== academyId
    //    by construction). Lets console routes with no slug resolve the owner's
    //    academy without any client change. Only used when nothing above matched.
    const jwtTenant = req.user?.tenantId;
    if (typeof jwtTenant === 'string' && jwtTenant) {
      const exists = await this.prisma.academy.findFirst({ where: { id: jwtTenant, deletedAt: null }, select: { id: true } });
      if (exists) return exists.id;
    }
    return null;
  }

  // ── Academy-scoped course catalog (reads only) ────────────────────────────
  // Note: the column is still named `tenantId`; its value already equals the
  // academyId (Phase-1 identity-preserving migration), so we query by it directly.

  private mapCard(c: any) {
    const lessonsCount = (c.units ?? []).reduce((s: number, u: any) => s + u._count.lessons, 0);
    const { units, teacher, ...rest } = c;
    return { ...rest, lessonsCount, teacherName: teacher?.user?.fullName ?? null };
  }

  private courseCardSelect() {
    return {
      id: true, title: true, description: true, thumbnailUrl: true,
      priceCents: true, currency: true, pricingModel: true, status: true, createdAt: true,
      subject: { select: { nameAr: true, nameEn: true } },
      grade: { select: { nameAr: true, nameEn: true } },
      teacher: { select: { user: { select: { fullName: true } } } },
      units: { where: { deletedAt: null }, select: { _count: { select: { lessons: { where: { deletedAt: null } } } } } },
    };
  }

  /** Public storefront: an academy's PUBLISHED courses. */
  async publicCourses(academyId: string) {
    const rows = await this.prisma.course.findMany({
      where: { tenantId: academyId, status: 'PUBLISHED', deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: this.courseCardSelect(),
    });
    return rows.map((c) => this.mapCard(c));
  }

  /** Console: all of the academy's courses (incl. DRAFT/ARCHIVED). Permission-gated. */
  async manageCourses(academyId: string) {
    const rows = await this.prisma.course.findMany({
      where: { tenantId: academyId, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      select: this.courseCardSelect(),
    });
    return rows.map((c) => this.mapCard(c));
  }

  /**
   * Build the AcademyContext for a user in an academy. Returns null when the user
   * has no active membership (the guard turns that into a 404, never revealing
   * existence). SUPER_ADMIN gets a full platform-admin context.
   */
  async buildContext(userId: string, academyId: string, globalRole?: string): Promise<AcademyContext | null> {
    if (globalRole === Role.SUPER_ADMIN) {
      const all = new Set<Capability>(ROLE_PERMISSIONS.OWNER);
      return {
        academyId, userId, role: 'OWNER', status: 'ACTIVE', isPlatformAdmin: true,
        can: (c) => all.has(c),
      };
    }
    const membership = await this.prisma.academyMembership.findUnique({
      where: { userId_academyId: { userId, academyId } },
    });
    if (!membership || membership.status !== 'ACTIVE') return null;
    const perms = permissionsFor(membership.role as AcademyRole, membership.permissions as unknown);
    return {
      academyId, userId, role: membership.role as AcademyRole, status: membership.status,
      isPlatformAdmin: false,
      can: (c) => perms.has(c),
    };
  }
}
