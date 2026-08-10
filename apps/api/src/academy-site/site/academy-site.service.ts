import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AcademySite, AcademySiteSnapshot } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { brandTokensFromTheme } from '../../branding/app-theme';
import { PrismaService } from '../../prisma/prisma.service';
import { AcademySiteConfig } from '../academy-site.config';
import { ContentProfile } from '../pipeline/content-profile';
import { QualityGateService } from '../pipeline/quality-gate.service';
import { needsUpgrade, upgradeToComposition } from '../pipeline/upgrade';
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
    private readonly quality: QualityGateService,
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

    // What the quality gate thinks of the current draft, and why the design
    // looks the way it does. Both were computed and thrown away before: the
    // verdicts went to a debug log and the rationale was never stored, so a
    // teacher had no way to know their page had a problem short of finding it.
    let quality: { errors: string[]; warnings: string[] } | null = null;
    let rationale: string | null = null;
    if (site?.draftDoc) {
      const parsed = parseSiteDocument(site.draftDoc);
      if (parsed.success) {
        const { errors, warnings } = this.quality.evaluate(parsed.data!);
        quality = { errors: errors.map((e) => e.message), warnings: warnings.map((w) => w.message) };
        rationale = parsed.data!.rationale ?? null;
      } else {
        quality = { errors: parsed.errors ?? ['the draft is no longer valid'], warnings: [] };
      }
    }

    return {
      status: site?.status ?? 'DRAFT',
      hasDraft: !!site?.draftDoc,
      publishedAt: site?.publishedAt ?? null,
      version: site?.version ?? 0,
      moderationApproved: site?.moderationApproved ?? false,
      moderationReason: site?.moderationReason ?? null,
      lastJob,
      quality,
      rationale,
    };
  }

  /** Compile the current draft (or published fallback) to HTML for owner preview. */
  async previewHtml(academyId: string): Promise<string> {
    const site = await this.getByAcademy(academyId);
    const doc = site?.draftDoc ?? site?.publishedDoc;
    if (!doc) throw new BadRequestException('لا توجد صفحة للمعاينة بعد — قم بالتوليد أولاً');
    const parsed = parseSiteDocument(doc);
    if (!parsed.success) throw new BadRequestException({ message: 'Draft is invalid', errors: parsed.errors });
    const academy = await this.prisma.academy.findUnique({
      where: { id: academyId },
      include: { owner: { select: { fullName: true } } },
    });
    if (!academy) throw new NotFoundException('Academy not found');
    return this.render.compile(academyId, parsed.data!, {
      academyName: academy.name,
      ownerName: academy.owner?.fullName,
      slug: academy.slug,
      defaultLang: academy.language === 'en' ? 'en' : 'ar',
    });
  }

  /** Compile a specific version (snapshot) to HTML for preview. */
  async previewSnapshotHtml(academyId: string, snapshotId: string): Promise<string> {
    const site = await this.getByAcademy(academyId);
    if (!site) throw new NotFoundException('Site not found');
    const snap = await this.prisma.academySiteSnapshot.findFirst({
      where: { id: snapshotId, siteId: site.id },
    });
    if (!snap) throw new NotFoundException('Snapshot not found');
    const parsed = parseSiteDocument(snap.doc);
    if (!parsed.success) throw new BadRequestException('Snapshot document is no longer valid');
    const academy = await this.prisma.academy.findUnique({
      where: { id: academyId },
      include: { owner: { select: { fullName: true } } },
    });
    if (!academy) throw new NotFoundException('Academy not found');
    return this.render.compile(academyId, parsed.data!, {
      academyName: academy.name,
      ownerName: academy.owner?.fullName,
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

  /**
   * Publish a specific historical version directly: make it the working draft,
   * then run the normal publish path (media + quality + moderation aware). Lets
   * the owner push any version live without a separate restore-then-publish.
   */
  async publishSnapshot(academyId: string, snapshotId: string, actorUserId: string): Promise<AcademySite> {
    const site = await this.getOrCreate(academyId);
    const snap = await this.prisma.academySiteSnapshot.findFirst({
      where: { id: snapshotId, siteId: site.id },
    });
    if (!snap) throw new NotFoundException('Snapshot not found');
    const parsed = parseSiteDocument(snap.doc);
    if (!parsed.success) throw new BadRequestException('Snapshot document is no longer valid');
    await this.prisma.academySite.update({
      where: { id: site.id },
      data: { draftDoc: snap.doc as unknown as object },
    });
    return this.publish(academyId, actorUserId);
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
    this.assertQuality(parsed.data!);

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
    this.assertQuality(parsed.data!);
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

  /**
   * Re-render every published site from the document it was published with.
   *
   * Publishing bakes the HTML into `publishedHtml`, so a fix to the renderer
   * reaches new publishes only — live sites keep serving whatever markup was
   * correct at the time. That is how every academy went on shipping course cards
   * pointing at `/courses/<id>`, a path the app has never served, long after the
   * generator was fixed.
   *
   * Content is untouched: same document, same version, only the markup is rebuilt.
   */
  /** Rebuild one academy's live HTML — used after its slug changes. */
  async recompileAcademy(academyId: string): Promise<boolean> {
    const site = await this.prisma.academySite.findUnique({ where: { academyId } });
    if (!site || site.status !== 'PUBLISHED' || !site.publishedDoc) return false;
    const academy = await this.prisma.academy.findUnique({
      where: { id: academyId },
      include: { owner: { select: { fullName: true } } },
    });
    if (!academy) return false;
    const html = await this.render.compile(
      academyId,
      site.publishedDoc as unknown as SiteDocument,
      {
        academyName: academy.name,
        ownerName: academy.owner?.fullName,
        slug: academy.slug,
        defaultLang: academy.language === 'en' ? 'en' : 'ar',
      },
    );
    await this.prisma.academySite.update({ where: { id: site.id }, data: { publishedHtml: html } });
    return true;
  }

  /**
   * Move this academy's draft to the composition engine without a model call.
   *
   * The design it was published with is lifted into the new system and each
   * section is given the best layout its content can carry. Explicit on purpose:
   * a teacher asks for it, sees the preview, and publishes if they want it.
   */
  async upgradeDraft(academyId: string, actorUserId: string) {
    const site = await this.getByAcademy(academyId);
    const source = site?.draftDoc ?? site?.publishedDoc;
    if (!source) throw new BadRequestException('There is no page to upgrade yet');
    const parsed = parseSiteDocument(source);
    if (!parsed.success) {
      throw new BadRequestException({ message: 'The current page is invalid', errors: parsed.errors });
    }
    if (!needsUpgrade(parsed.data!)) {
      return { upgraded: false, version: site!.version, reason: 'already on the composition engine' };
    }
    const upgraded = upgradeToComposition(parsed.data!, await this.contentProfile(academyId));
    const { site: updated, snapshot } = await this.saveDraft(academyId, upgraded, 'upgrade');
    await this.log(actorUserId, 'site.upgrade', updated.id, { version: updated.version });
    return { upgraded: true, version: updated.version, snapshotId: snapshot.id };
  }

  /** The live half of the content profile, for pattern selection during upgrade. */
  private async contentProfile(academyId: string): Promise<ContentProfile> {
    const [courseCount, reviews, media, facts] = await Promise.all([
      this.prisma.course.count({ where: { tenantId: academyId, status: 'PUBLISHED', deletedAt: null } }),
      this.prisma.review.aggregate({
        where: { tenantId: academyId, comment: { not: '' } },
        _count: { _all: true },
        _avg: { rating: true },
      }),
      this.prisma.academyMedia.findMany({
        where: { academyId, status: 'READY' },
        select: { kind: true },
      }),
      this.prisma.academyProfileFacts.findUnique({ where: { academyId } }),
    ]);
    const bio = facts?.bio ?? '';
    const list = (v: unknown) => (Array.isArray(v) ? v.length : 0);
    return {
      hasCover: media.some((m) => m.kind === 'COVER'),
      hasLogo: media.some((m) => m.kind === 'LOGO'),
      galleryCount: media.filter((m) => m.kind === 'GALLERY').length,
      bioLength: bio.length,
      subjectsCount: list(facts?.subjects),
      achievementsCount: list(facts?.achievements),
      courseCount,
      reviewCount: reviews._count._all ?? 0,
      avgRating: reviews._avg.rating ?? 0,
      bioParagraphs: bio.split(/\n{2,}/).filter((p) => p.trim()).length,
      avgAchievementLength: 0,
    };
  }

  async recompilePublished(): Promise<{ recompiled: number; failed: string[] }> {
    const sites = await this.prisma.academySite.findMany({
      where: { status: 'PUBLISHED' },
      select: { id: true, academyId: true, publishedDoc: true },
    });

    let recompiled = 0;
    const failed: string[] = [];
    for (const site of sites) {
      try {
        const academy = await this.prisma.academy.findUnique({
          where: { id: site.academyId },
          include: { owner: { select: { fullName: true } } },
        });
        // A published row with no stored document cannot be rebuilt; leave it
        // serving what it has rather than blanking a live site.
        if (!academy || !site.publishedDoc) {
          failed.push(site.academyId);
          continue;
        }
        const html = await this.render.compile(
          site.academyId,
          site.publishedDoc as unknown as SiteDocument,
          {
            academyName: academy.name,
            ownerName: academy.owner?.fullName,
            slug: academy.slug,
            defaultLang: academy.language === 'en' ? 'en' : 'ar',
          },
        );
        // Deliberately not bumping `version`: nothing the teacher authored changed.
        await this.prisma.academySite.update({ where: { id: site.id }, data: { publishedHtml: html } });
        recompiled++;
      } catch {
        failed.push(site.academyId);
      }
    }
    return { recompiled, failed };
  }

  private async compileAndPublish(
    siteId: string,
    academyId: string,
    doc: SiteDocument,
    moderatedById?: string,
  ): Promise<AcademySite> {
    const academy = await this.prisma.academy.findUnique({
      where: { id: academyId },
      include: { owner: { select: { fullName: true } } },
    });
    if (!academy) throw new NotFoundException('Academy not found');
    const site = await this.prisma.academySite.findUniqueOrThrow({ where: { id: siteId } });
    const html = await this.render.compile(academyId, doc, {
      academyName: academy.name,
      ownerName: academy.owner?.fullName,
      slug: academy.slug,
      defaultLang: academy.language === 'en' ? 'en' : 'ar',
    });
    // Publishing is the moment the teacher says "this is my academy". Promote the
    // look they approved to the academy's brand, so the console and every other
    // surface stop wearing the generic platform palette and start wearing theirs.
    // Only on publish — a preview they never accepted must not repaint the app.
    //
    // Read through a normaliser rather than off `theme.design`: that field is the
    // older three-colour block, so every site composed by the v3 pipeline — which
    // keeps its colour in `designSpec.palette` — was recording nothing here and
    // publishing left the console on the platform palette.
    await this.prisma.academy.update({
      where: { id: academyId },
      data: {
        colorPrimary: doc.theme.primary,
        colorAccent: doc.theme.accent,
        brandTokens: brandTokensFromTheme(doc.theme) as never,
      },
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

  /** Block publishing a genuinely broken page (deterministic quality gate). */
  private assertQuality(doc: SiteDocument): void {
    const errors = this.quality.blockingErrors(doc);
    if (errors.length) {
      throw new BadRequestException({
        message: 'Page did not pass quality checks — fix these before publishing',
        errors: errors.map((e) => e.message),
      });
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
