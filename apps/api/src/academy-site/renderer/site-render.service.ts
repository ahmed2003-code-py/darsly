import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SiteDocument } from '../schema/site-document';
import { RenderMedia, compileSite } from './site-compiler';

@Injectable()
export class SiteRenderService {
  constructor(private readonly prisma: PrismaService) {}

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
    return compileSite(doc, { ...ctx, media: (id) => map.get(id) });
  }
}
