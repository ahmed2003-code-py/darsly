import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ContentProfile } from '../pipeline/content-profile';
import { SiteBrainService } from '../pipeline/site-brain.service';
import { RENDERER_COMPOSITION, SiteDocument } from '../schema/site-document';
import { composeSite } from './compose/compile';
import { compileSite } from './site-compiler';
import { RenderMedia } from './types';

export interface RenderTarget {
  academyName: string;
  ownerName?: string;
  slug: string;
  defaultLang: 'ar' | 'en';
}

@Injectable()
export class SiteRenderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly brain: SiteBrainService,
  ) {}

  /**
   * Compile a document to HTML, resolving this academy's READY media.
   *
   * Which engine renders it is decided by the document, not by what is newest.
   * A page published before the composition pipeline existed keeps the renderer
   * it was designed against, byte for byte — because publishing bakes the HTML,
   * and quietly repainting a page a teacher already approved is not an upgrade,
   * it is a surprise. Moving a document forward is a deliberate act with its own
   * entry point.
   */
  async compile(
    academyId: string,
    doc: SiteDocument,
    ctx: RenderTarget,
    profile?: ContentProfile,
  ): Promise<string> {
    const media = await this.prisma.academyMedia.findMany({
      where: { academyId, status: 'READY' },
      select: { id: true, url: true, blurhash: true, width: true, height: true },
    });
    const map = new Map<string, RenderMedia>(
      media.map((m) => [m.id, { url: m.url ?? '', blurhash: m.blurhash, width: m.width, height: m.height }]),
    );
    const renderCtx = { ...ctx, media: (id: string) => map.get(id) };

    if (usesComposition(doc)) {
      return composeSite(this.brain.compose(doc, profile), renderCtx);
    }
    return compileSite(this.brain.plan(doc), renderCtx);
  }
}

/** Whether this document was designed against the composition engine. */
export function usesComposition(doc: SiteDocument): boolean {
  return !!doc.theme.designSpec || doc.renderer?.version === RENDERER_COMPOSITION;
}
