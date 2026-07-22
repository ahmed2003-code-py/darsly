import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AcademySite, AcademySiteSnapshot } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AcademySiteConfig } from '../academy-site.config';
import { SiteRenderService } from '../renderer/site-render.service';
import { SiteBlock, SiteDocument, parseSiteDocument } from '../schema/site-document';

const SNAPSHOT_KEEP = 20;

/**
 * Persistence + lifecycle for the academy landing site.
 *
 * State machine (AcademySiteStatus):
 *   DRAFT ──publish──▶ PENDING_MODERATION ──approve──▶ PUBLISHED
 *     ▲                    │ reject                        │
 *     └────────────────────┴──── unpublish / takedown ─────┘
 * Once an academy is approved (moderationApproved=true), subsequent publishes go
 * live immediately (no re-moderation); admins retain a takedown lever.
 * `version` increments on every draft revision and every publish, and doubles as
 * the public ETag.
 */
@Injectable()
export class AcademySiteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly render: SiteRenderService,
    private readonly audit: AuditService,
    private readonly config: AcademySiteConfig,
  ) {}

  async getOrCreate(academyId: string): Promise<AcademySite> {
    const existing = await this.prisma.academySite.findUnique({ where: { academyId } });
    if (existing) return existing;
    return this.prisma.academySite.create({ data: { academyId } });
  }

  getByAcademy(academyId: string): Promise<AcademySite | null> {
    return this.prisma.academySite.findUnique({ where: { academyId } });
  }

  async overview(academyId: string) {
    const site = await this.getByAcademy(academyId);
    const lastJob = await this.prisma.aiJob.findFirst({
      where: { academyId, type: 'SITE_GENERATE' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, stage: true, error: true, createdAt: true },
    });
    return {
      status: site?.status ?? 'DRAFT',
      hasDraft: !!site?.draftDoc,
      publishedAt: site?.publishedAt ?? null,
      version: site?.version ?? 0,
      moderationApproved: site?.moderationApproved ?? false,
      moderationReason: site?.moderationReason ?? null,
      lastJob,
    };
  }

  /** Compile the current draft (or published fallback) to HTML for owner preview. */
  async previewHtml(academyId: string): Promise<string> {
    const site = await this.getByAcademy(academyId);
    const doc = site?.draftDoc ?? site?.publishedDoc;
    if (!doc) throw new BadRequestException('لا توجد صفحة للمعاينة بعد — قم بالتوليد أولاً');
    const parsed = parseSiteDocument(doc);
    if (!parsed.success) throw new BadRequestException({ message: 'Draft is invalid', errors: parsed.errors });
    const academy = await this.prisma.academy.findUnique({ where: { id: academyId } });
    if (!academy) throw new NotFoundException('Academy not found');
    return this.render.compile(academyId, parsed.data!, {
      academyName: academy.name,
      slug: academy.slug,
      defaultLang: academy.language === 'en' ? 'en' : 'ar',
    });
  }

  // ── Draft persistence ───────────────────────────────────────────────────────

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

  /** The current working draft, for the editor to load. */
  async getDraft(academyId: string) {
    const site = await this.getByAcademy(academyId);
    return { doc: site?.draftDoc ?? null, version: site?.version ?? 0, status: site?.status ?? 'DRAFT' };
  }

  /** Save an edited full document from the editor (zod-validated; media must
   *  belong to this academy). */
  async saveEditedDraft(academyId: string, raw: unknown, actorUserId: string) {
    const parsed = parseSiteDocument(raw);
    if (!parsed.success) {
      throw new BadRequestException({ message: 'Invalid document', errors: parsed.errors });
    }
    await this.assertMediaOwnership(academyId, parsed.data!);
    const { site, snapshot } = await this.saveDraft(academyId, parsed.data!, 'manual-save');
    await this.log(actorUserId, 'site.draft.save', site.id, { version: site.version });
    return { version: site.version, snapshotId: snapshot.id, status: site.status };
  }

  private async assertMediaOwnership(academyId: string, doc: SiteDocument): Promise<void> {
    const ids = collectMediaIds(doc);
    if (!ids.length) return;
    const owned = await this.prisma.academyMedia.count({ where: { academyId, id: { in: ids } } });
    if (owned !== ids.length) {
      throw new BadRequestException('Document references media that does not belong to this academy');
    }
  }

  listSnapshots(academyId: string) {
    return this.prisma.academySiteSnapshot.findMany({
      where: { site: { academyId } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, version: true, reason: true, createdAt: true },
    });
  }

  /** Delete a single version from the history. */
  async deleteSnapshot(academyId: string, snapshotId: string, actorUserId: string) {
    const site = await this.getByAcademy(academyId);
    if (!site) throw new NotFoundException('Site not found');
    const snap = await this.prisma.academySiteSnapshot.findFirst({
      where: { id: snapshotId, siteId: site.id },
    });
    if (!snap) throw new NotFoundException('Snapshot not found');
    await this.prisma.academySiteSnapshot.delete({ where: { id: snapshotId } });
    await this.log(actorUserId, 'site.snapshot.delete', site.id, { snapshotId, version: snap.version });
    return { id: snapshotId, deleted: true };
  }

  async rollback(academyId: string, snapshotId: string, actorUserId: string): Promise<AcademySite> {
    const site = await this.getOrCreate(academyId);
    const snap = await this.prisma.academySiteSnapshot.findFirst({
      where: { id: snapshotId, siteId: site.id },
    });
    if (!snap) throw new NotFoundException('Snapshot not found');
    const parsed = parseSiteDocument(snap.doc);
    if (!parsed.success) throw new BadRequestException('Snapshot document is no longer valid');
    const { site: updated } = await this.saveDraft(academyId, parsed.data!, 'rollback');
    await this.log(actorUserId, 'site.rollback', site.id, { snapshotId, toVersion: snap.version });
    return updated;
  }

  // ── Publish / moderation lifecycle ──────────────────────────────────────────

  /** Teacher publish. First time → PENDING_MODERATION; once approved → live. */
  async publish(academyId: string, actorUserId: string): Promise<AcademySite> {
    const site = await this.getOrCreate(academyId);
    if (!site.draftDoc) throw new BadRequestException('There is no draft to publish');
    const parsed = parseSiteDocument(site.draftDoc);
    if (!parsed.success) {
      throw new BadRequestException({ message: 'Draft is invalid', errors: parsed.errors });
    }
    await this.assertPublishable(academyId, parsed.data!);

    if (this.config.moderationEnabled && !site.moderationApproved) {
      const updated = await this.prisma.academySite.update({
        where: { id: site.id },
        data: { status: 'PENDING_MODERATION', moderationReason: null },
      });
      await this.log(actorUserId, 'site.publish.request', site.id, {});
      return updated;
    }
    const published = await this.compileAndPublish(site.id, academyId, parsed.data!);
    await this.log(actorUserId, 'site.publish', site.id, { version: published.version });
    return published;
  }

  async unpublish(academyId: string, actorUserId: string): Promise<AcademySite> {
    const site = await this.getByAcademy(academyId);
    if (!site || site.status !== 'PUBLISHED') {
      throw new ConflictException('Site is not published');
    }
    const updated = await this.prisma.academySite.update({
      where: { id: site.id },
      data: { status: 'DRAFT', publishedAt: null },
    });
    await this.log(actorUserId, 'site.unpublish', site.id, {});
    return updated;
  }

  /** Admin moderation of a PENDING_MODERATION site. */
  async moderate(
    academyId: string,
    decision: 'approve' | 'reject',
    reason: string | undefined,
    adminUserId: string,
  ): Promise<AcademySite> {
    const site = await this.getByAcademy(academyId);
    if (!site || site.status !== 'PENDING_MODERATION') {
      throw new ConflictException('Site is not pending moderation');
    }
    if (decision === 'reject') {
      const updated = await this.prisma.academySite.update({
        where: { id: site.id },
        data: { status: 'REJECTED', moderationReason: reason ?? null, moderatedById: adminUserId },
      });
      await this.log(adminUserId, 'site.moderate.reject', site.id, { reason });
      return updated;
    }
    const parsed = parseSiteDocument(site.draftDoc);
    if (!parsed.success) throw new BadRequestException('Draft is invalid');
    await this.assertPublishable(academyId, parsed.data!);
    const published = await this.compileAndPublish(site.id, academyId, parsed.data!, adminUserId);
    await this.log(adminUserId, 'site.moderate.approve', site.id, { version: published.version });
    return published;
  }

  /** Admin emergency takedown of a live site. */
  async takedown(academyId: string, reason: string | undefined, adminUserId: string): Promise<AcademySite> {
    const site = await this.getByAcademy(academyId);
    if (!site) throw new NotFoundException('Site not found');
    const updated = await this.prisma.academySite.update({
      where: { id: site.id },
      data: {
        status: 'DRAFT',
        moderationApproved: false,
        publishedAt: null,
        moderationReason: reason ?? null,
        moderatedById: adminUserId,
      },
    });
    await this.log(adminUserId, 'site.takedown', site.id, { reason });
    return updated;
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private async compileAndPublish(
    siteId: string,
    academyId: string,
    doc: SiteDocument,
    moderatedById?: string,
  ): Promise<AcademySite> {
    const academy = await this.prisma.academy.findUnique({ where: { id: academyId } });
    if (!academy) throw new NotFoundException('Academy not found');
    const site = await this.prisma.academySite.findUniqueOrThrow({ where: { id: siteId } });
    const html = await this.render.compile(academyId, doc, {
      academyName: academy.name,
      slug: academy.slug,
      defaultLang: academy.language === 'en' ? 'en' : 'ar',
    });
    return this.prisma.academySite.update({
      where: { id: siteId },
      data: {
        status: 'PUBLISHED',
        publishedDoc: doc as unknown as object,
        publishedHtml: html,
        publishedAt: new Date(),
        moderationApproved: true,
        version: site.version + 1,
        ...(moderatedById ? { moderatedById } : {}),
      },
    });
  }

  /** All media referenced by the document must be READY for this academy. */
  private async assertPublishable(academyId: string, doc: SiteDocument): Promise<void> {
    const ids = collectMediaIds(doc);
    if (ids.length) {
      const ready = await this.prisma.academyMedia.count({
        where: { academyId, id: { in: ids }, status: 'READY' },
      });
      if (ready !== ids.length) {
        throw new BadRequestException('Some images are still processing or were removed — fix them before publishing');
      }
    }
    // High-stakes claims must be admin-verified before going public. Phase-1
    // generation never emits unverified claims into the document, so this is a
    // guard for future claim-bearing blocks.
    const unverified = await this.prisma.academyClaim.count({
      where: { academyId, state: 'UNVERIFIED' },
    });
    if (unverified > 0 && documentReferencesClaims(doc)) {
      throw new BadRequestException('Remove or verify unverified claims before publishing');
    }
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

  private log(actorUserId: string, action: string, entityId: string, meta: Record<string, unknown>) {
    return this.audit.log({ actorUserId, action, entity: 'AcademySite', entityId, meta });
  }
}

function collectMediaIds(doc: SiteDocument): string[] {
  const ids = new Set<string>();
  if (doc.theme.logoMediaId) ids.add(doc.theme.logoMediaId);
  for (const b of doc.blocks as SiteBlock[]) {
    if ((b.type === 'hero' || b.type === 'about') && b.mediaId) ids.add(b.mediaId);
    if (b.type === 'gallery') b.mediaIds.forEach((id) => ids.add(id));
  }
  return [...ids];
}

function documentReferencesClaims(doc: SiteDocument): boolean {
  return (doc.blocks as SiteBlock[]).some((b) => b.type === 'stats' && b.items.length > 0);
}
