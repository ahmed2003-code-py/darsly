import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { AcademyMedia, AcademyMediaKind } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageProvider } from '../../storage/storage.provider';
import { AcademyMediaProcessor } from './academy-media.processor';
import { parseSiteDocument } from '../schema/site-document';
import { stripMediaId } from '../site/academy-site.service';

// Max non-REJECTED media per kind. GALLERY and PROMO are the repeatable kinds.
const KIND_MAX_COUNT: Partial<Record<AcademyMediaKind, number>> = {
  LOGO: 1,
  COVER: 1,
  AVATAR: 1,
  GALLERY: 12,
  PROMO: 6,
  // One per course, plus the ones left behind by re-recording. The cap is a
  // runaway guard, not an editorial limit like GALLERY's.
  COURSE_INTRO: 200,
};

// Kinds a video upload is meaningful for. LOGO/COVER/AVATAR are single still
// images by design; GALLERY is a mixed reel of photos and clips, same as the
// hand-authored reference page it now always renders as.
const VIDEO_MIME = /^video\/mp4$/;
const VIDEO_CAPABLE: Partial<Record<AcademyMediaKind, true>> = {
  GALLERY: true,
  PROMO: true,
  COURSE_INTRO: true,
};

// A course's intro clip is the one a teacher records on a phone rather than
// picks from a reel, so it gets more headroom than a gallery highlight.
const KIND_MAX_VIDEO_BYTES: Partial<Record<AcademyMediaKind, number>> = {
  COURSE_INTRO: 50 * 1024 * 1024,
};

const STUCK_MINUTES = 30;
const REJECTED_RETENTION_DAYS = 7;

@Injectable()
export class AcademyMediaService {
  private readonly logger = new Logger(AcademyMediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageProvider,
    private readonly processor: AcademyMediaProcessor,
  ) {}

  private key(academyId: string, mediaId: string, isVideo: boolean): string {
    const ext = isVideo ? 'mp4' : 'webp';
    return `academy-media/${academyId}/${mediaId}.${ext}`;
  }

  private publicUrl(mediaId: string): string {
    // Same-origin in prod; global prefix is api/v1.
    return `/api/v1/files/academy-media/${mediaId}`;
  }

  /** Validate, process and store an uploaded image. Deduplicates identical
   *  uploads by content hash so re-uploading the same file is cheap. */
  async upload(
    academyId: string,
    kind: AcademyMediaKind,
    file: { buffer: Buffer; mimetype: string },
  ): Promise<AcademyMedia> {
    // Dedupe FIRST (before the count limit) so re-uploading the same file is
    // idempotent and never trips the per-kind cap.
    const contentHash = createHash('sha256').update(file.buffer).digest('hex');
    const dup = await this.prisma.academyMedia.findFirst({
      where: { academyId, kind, contentHash, status: 'READY' },
    });
    if (dup) return dup;

    const max = KIND_MAX_COUNT[kind] ?? 1;
    const existing = await this.prisma.academyMedia.count({
      where: { academyId, kind, status: { in: ['UPLOADING', 'PROCESSING', 'READY'] } },
    });
    if (existing >= max) {
      throw new ConflictException(
        `You already have the maximum number of ${kind.toLowerCase()} items (${max}). Delete one first.`,
      );
    }

    // Which pipeline runs is decided by what was actually uploaded, not by
    // `kind` alone — a GALLERY slot takes photos and clips, same mix the
    // reference page's own gallery does, and only PROMO/GALLERY accept video
    // at all. Video stored as-is; PROMO's old dedicated branch is now just the
    // "always video" case of the same check.
    const isVideo = VIDEO_MIME.test(file.mimetype);
    if (isVideo && !VIDEO_CAPABLE[kind]) {
      throw new BadRequestException(`${kind.toLowerCase()} does not accept video`);
    }
    const processed = isVideo
      ? await this.processor.processVideo(file.buffer, file.mimetype, KIND_MAX_VIDEO_BYTES[kind])
      : await this.processor.process(file.buffer, file.mimetype, kind);

    const media = await this.prisma.academyMedia.create({
      data: { academyId, kind, status: 'PROCESSING', mimeType: processed.mimeType },
    });
    try {
      const storageKey = this.key(academyId, media.id, isVideo);
      await this.storage.put(storageKey, processed.data, {
        contentType: processed.mimeType,
        cacheControl: 'public, max-age=31536000, immutable',
      });
      return await this.prisma.academyMedia.update({
        where: { id: media.id },
        data: {
          status: 'READY',
          storageKey,
          url: this.publicUrl(media.id),
          width: processed.width,
          height: processed.height,
          bytes: processed.bytes,
          blurhash: 'blurhash' in processed ? processed.blurhash || null : null,
          contentHash: processed.contentHash,
        },
      });
    } catch (e) {
      await this.prisma.academyMedia.update({
        where: { id: media.id },
        data: { status: 'REJECTED', rejectReason: 'storage failed' },
      });
      this.logger.error(`media ${media.id} storage failed: ${(e as Error).message}`);
      throw new BadRequestException('Failed to store image');
    }
  }

  list(academyId: string): Promise<AcademyMedia[]> {
    return this.prisma.academyMedia.findMany({
      where: { academyId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(academyId: string, id: string): Promise<AcademyMedia> {
    const media = await this.prisma.academyMedia.findFirst({ where: { id, academyId } });
    if (!media) throw new NotFoundException('Media not found');
    return media;
  }

  async remove(academyId: string, id: string): Promise<{ id: string; deleted: true }> {
    const media = await this.get(academyId, id);
    if (media.storageKey) {
      await this.storage.delete(media.storageKey).catch(() => undefined);
    }
    await this.prisma.academyMedia.delete({ where: { id: media.id } });
    await this.forgetInDraft(academyId, media.id);
    return { id, deleted: true };
  }

  /**
   * Take the deleted image out of the page that points at it.
   *
   * A site document naming media that no longer exists cannot be published, and
   * the refusal lands at publish time — days later, on a screen with nothing to
   * connect it to the delete that caused it. Cleaning up here is the difference
   * between an image disappearing and a page quietly becoming unpublishable.
   *
   * Best-effort on purpose: the image is already gone either way, and a failure
   * to tidy the draft must not turn a successful delete into an error.
   */
  private async forgetInDraft(academyId: string, mediaId: string): Promise<void> {
    try {
      const site = await this.prisma.academySite.findUnique({
        where: { academyId },
        select: { id: true, draftDoc: true },
      });
      if (!site?.draftDoc) return;
      const parsed = parseSiteDocument(site.draftDoc);
      if (!parsed.success) return;
      if (!stripMediaId(parsed.data!, mediaId)) return;
      await this.prisma.academySite.update({
        where: { id: site.id },
        data: { draftDoc: parsed.data! as unknown as object },
      });
    } catch (err) {
      this.logger.warn(`could not take ${mediaId} out of the draft: ${String(err)}`);
    }
  }

  /** Public read for the streaming route: only READY media is exposed. */
  async getReadyForPublic(id: string): Promise<AcademyMedia> {
    const media = await this.prisma.academyMedia.findFirst({ where: { id, status: 'READY' } });
    if (!media || !media.storageKey) throw new NotFoundException('Media not found');
    return media;
  }

  // ── Maintenance ───────────────────────────────────────────────────────────

  /** Mark uploads stuck in UPLOADING/PROCESSING as REJECTED. */
  async sweepStuck(): Promise<number> {
    const cutoff = new Date(Date.now() - STUCK_MINUTES * 60_000);
    const res = await this.prisma.academyMedia.updateMany({
      where: { status: { in: ['UPLOADING', 'PROCESSING'] }, updatedAt: { lt: cutoff } },
      data: { status: 'REJECTED', rejectReason: 'processing timed out' },
    });
    return res.count;
  }

  /** Delete REJECTED media (storage + row) older than the retention window. */
  async purgeRejected(): Promise<number> {
    const cutoff = new Date(Date.now() - REJECTED_RETENTION_DAYS * 86_400_000);
    const stale = await this.prisma.academyMedia.findMany({
      where: { status: 'REJECTED', updatedAt: { lt: cutoff } },
      select: { id: true, storageKey: true },
    });
    for (const m of stale) {
      if (m.storageKey) await this.storage.delete(m.storageKey).catch(() => undefined);
    }
    // A real delete, not a soft one. The file is already gone from storage by
    // this point, so a surviving row could never be restored — it would only
    // be a permanent pointer to nothing, and the retention window it was
    // waiting out would never actually free anything. Raw SQL because the
    // soft-delete middleware rewrites `delete` on this model.
    if (stale.length) {
      await this.prisma.$executeRaw`
        DELETE FROM "AcademyMedia" WHERE "id" = ANY(${stale.map((m) => m.id)}::text[])
      `;
    }
    return stale.length;
  }
}
