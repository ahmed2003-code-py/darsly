import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface PublishedSite {
  academyId: string;
  version: number;
  html: string;
}

@Injectable()
export class PublicSiteService {
  constructor(private readonly prisma: PrismaService) {}

  private academyBySlug(slug: string) {
    return this.prisma.academy.findFirst({
      where: { slug, deletedAt: null },
      select: { id: true, status: true },
    });
  }

  /** The compiled published HTML for a live academy, or null. */
  async getPublished(slug: string): Promise<PublishedSite | null> {
    const academy = await this.academyBySlug(slug);
    if (!academy) return null;
    const site = await this.prisma.academySite.findUnique({ where: { academyId: academy.id } });
    if (!site || site.status !== 'PUBLISHED' || !site.publishedHtml) return null;
    return { academyId: academy.id, version: site.version, html: site.publishedHtml };
  }

  /** Whether this academy has a live AI-generated site (cheap status check). */
  async isPublished(slug: string): Promise<boolean> {
    const academy = await this.academyBySlug(slug);
    if (!academy) return false;
    const site = await this.prisma.academySite.findUnique({
      where: { academyId: academy.id },
      select: { status: true, publishedHtml: true },
    });
    return site?.status === 'PUBLISHED' && !!site.publishedHtml;
  }

  async courses(slug: string, limit: number) {
    const academy = await this.academyBySlug(slug);
    if (!academy) return [];
    const courses = await this.prisma.course.findMany({
      where: { tenantId: academy.id, status: 'PUBLISHED', deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, title: true, thumbnailUrl: true, priceCents: true },
    });
    return courses.map((c) => ({
      title: c.title,
      thumbnailUrl: c.thumbnailUrl,
      priceCents: c.priceCents,
      url: `/courses/${c.id}`,
    }));
  }

  async reviews(slug: string, limit: number) {
    const academy = await this.academyBySlug(slug);
    if (!academy) return [];
    const reviews = await this.prisma.review.findMany({
      where: { tenantId: academy.id, comment: { not: '' } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        rating: true,
        comment: true,
        student: { select: { user: { select: { fullName: true } } } },
      },
    });
    return reviews.map((r) => ({
      studentName: r.student?.user?.fullName ?? '',
      rating: r.rating,
      comment: r.comment,
    }));
  }

  /** Slugs of academies with a live site, for the sitemap. */
  publishedSlugs(): Promise<{ slug: string; updatedAt: Date }[]> {
    return this.prisma.academy
      .findMany({
        where: { deletedAt: null, site: { status: 'PUBLISHED' } },
        select: { slug: true, site: { select: { publishedAt: true, updatedAt: true } } },
      })
      .then((rows) =>
        rows.map((r) => ({ slug: r.slug, updatedAt: r.site?.publishedAt ?? r.site?.updatedAt ?? new Date() })),
      );
  }
}
