import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AcademySiteConfig } from '../academy-site.config';

/** Read models for the admin moderation queue + AI usage dashboard. */
@Injectable()
export class AdminAcademyStudioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AcademySiteConfig,
  ) {}

  /** Sites awaiting moderation, oldest first. */
  async moderationQueue() {
    const sites = await this.prisma.academySite.findMany({
      where: { status: 'PENDING_MODERATION' },
      orderBy: { updatedAt: 'asc' },
      select: {
        academyId: true,
        version: true,
        updatedAt: true,
        academy: { select: { name: true, slug: true } },
      },
    });
    return sites.map((s) => ({
      academyId: s.academyId,
      academyName: s.academy?.name ?? '',
      slug: s.academy?.slug ?? '',
      version: s.version,
      submittedAt: s.updatedAt,
    }));
  }

  /** Full site record for one academy (support / review). */
  async getSite(academyId: string) {
    const site = await this.prisma.academySite.findUnique({
      where: { academyId },
      include: { academy: { select: { name: true, slug: true } } },
    });
    if (!site) return null;
    return {
      academyId,
      academyName: site.academy?.name ?? '',
      slug: site.academy?.slug ?? '',
      status: site.status,
      version: site.version,
      moderationApproved: site.moderationApproved,
      moderationReason: site.moderationReason,
      publishedAt: site.publishedAt,
      draftDoc: site.draftDoc,
    };
  }

  /** AI usage / spend dashboard. */
  async usage() {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const dayAgo = new Date(Date.now() - 86_400_000);

    const [spend, grouped, failed24h, recent] = await Promise.all([
      this.prisma.aiJob.aggregate({ _sum: { costCents: true }, where: { createdAt: { gte: monthStart } } }),
      this.prisma.aiJob.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.aiJob.count({ where: { status: 'FAILED', updatedAt: { gte: dayAgo } } }),
      this.prisma.aiJob.findMany({
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true, academyId: true, status: true, stage: true, attempts: true,
          costCents: true, error: true, createdAt: true, updatedAt: true,
        },
      }),
    ]);

    const byStatus: Record<string, number> = {};
    for (const g of grouped) byStatus[g.status] = g._count._all;

    const spentCents = spend._sum.costCents ?? 0;
    const budgetCents = this.config.monthlyBudgetCents;
    return {
      enabled: this.config.enabled,
      month: monthStart.toISOString().slice(0, 7),
      spentCents,
      budgetCents,
      budgetRemainingCents: budgetCents > 0 ? Math.max(0, budgetCents - spentCents) : null,
      byStatus,
      failedLast24h: failed24h,
      recentJobs: recent,
    };
  }
}
