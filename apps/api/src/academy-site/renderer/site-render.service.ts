import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SiteBrainService } from '../pipeline/site-brain.service';
import { SiteDocument } from '../schema/site-document';
import { compileSite } from './site-compiler';
import { RenderMedia } from './types';

@Injectable()
export class SiteRenderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly brain: SiteBrainService,
  ) {}

  /** Compile a document to HTML, resolving this academy's READY media. */
  async compile(
    academyId: string,
    doc: SiteDocument,
    ctx: { academyName: string; slug: string; defaultLang: 'ar' | 'en' },
  ): Promise<string> {
    const media = await this.prisma.academyMedia.findMany({
      where: { academyId, status: 'READY' },
      select: { id: true, url: true, blurhash: true, width: true, height: true },
    });
    const map = new Map<string, RenderMedia>(
      media.map((m) => [m.id, { url: m.url ?? '', blurhash: m.blurhash, width: m.width, height: m.height }]),
    );
    // Site Brain resolves the authoritative RenderPlan; the renderer is pure.
    const plan = this.brain.plan(doc);
    return compileSite(plan, { ...ctx, media: (id) => map.get(id) });
  }
}
