import { Injectable } from '@nestjs/common';
import { AcademySite, AcademySiteSnapshot } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SiteDocument } from '../schema/site-document';

const SNAPSHOT_KEEP = 20;

/**
 * Persistence for the academy site draft + version history. Slice 5 uses this to
 * store generated drafts; the publish/moderation/rollback workflow (Slice 7)
 * extends it. `version` increments on every draft revision.
 */
@Injectable()
export class AcademySiteService {
  constructor(private readonly prisma: PrismaService) {}

  /** Lazily create the site row for an academy (status DRAFT). */
  async getOrCreate(academyId: string): Promise<AcademySite> {
    const existing = await this.prisma.academySite.findUnique({ where: { academyId } });
    if (existing) return existing;
    return this.prisma.academySite.create({ data: { academyId } });
  }

  getByAcademy(academyId: string): Promise<AcademySite | null> {
    return this.prisma.academySite.findUnique({ where: { academyId } });
  }

  /**
   * Replace the working draft with a new document, bump the version and record
   * an immutable snapshot. Old snapshots beyond the retention window are GC'd.
   */
  async saveDraft(
    academyId: string,
    doc: SiteDocument,
    reason: string,
  ): Promise<{ site: AcademySite; snapshot: AcademySiteSnapshot }> {
    const site = await this.getOrCreate(academyId);
    const version = site.version + 1;
    const updated = await this.prisma.academySite.update({
      where: { id: site.id },
      data: { draftDoc: doc as unknown as object, version },
    });
    const snapshot = await this.prisma.academySiteSnapshot.create({
      data: { siteId: site.id, version, doc: doc as unknown as object, reason },
    });
    await this.gcSnapshots(site.id);
    return { site: updated, snapshot };
  }

  private async gcSnapshots(siteId: string): Promise<void> {
    const keep = await this.prisma.academySiteSnapshot.findMany({
      where: { siteId },
      orderBy: { createdAt: 'desc' },
      take: SNAPSHOT_KEEP,
      select: { id: true },
    });
    if (keep.length < SNAPSHOT_KEEP) return;
    await this.prisma.academySiteSnapshot.deleteMany({
      where: { siteId, id: { notIn: keep.map((s) => s.id) } },
    });
  }
}
