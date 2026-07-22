import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { PublicSiteService } from './public-site.service';

function clampLimit(raw: unknown, def = 6): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(24, Math.max(1, n));
}

@ApiTags('academy-studio/public')
@Public()
@Controller()
export class PublicSiteController {
  constructor(private readonly site: PublicSiteService) {}

  @Get('a/:slug')
  @ApiOperation({ summary: 'Public: the published academy landing page (HTML)' })
  async page(@Param('slug') slug: string, @Req() req: Request, @Res() res: Response) {
    const published = await this.site.getPublished(slug);
    if (!published) {
      res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>404</title><h1>Page not found</h1>');
      return;
    }
    const etag = `W/"site-${published.academyId}-v${published.version}"`;
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=600');
    res.type('html').send(published.html);
  }

  @Get('a/:slug/courses')
  @ApiOperation({ summary: 'Public: published courses for the academy (hydration)' })
  courses(@Param('slug') slug: string, @Query('limit') limit?: string) {
    return this.site.courses(slug, clampLimit(limit));
  }

  @Get('a/:slug/reviews')
  @ApiOperation({ summary: 'Public: recent reviews for the academy (hydration)' })
  reviews(@Param('slug') slug: string, @Query('limit') limit?: string) {
    return this.site.reviews(slug, clampLimit(limit));
  }

  @Get('sitemap.xml')
  @ApiOperation({ summary: 'Public: sitemap of published academy pages' })
  async sitemap(@Res() res: Response) {
    const base = (process.env.API_URL ?? '').replace(/\/$/, '');
    const rows = await this.site.publishedSlugs();
    const urls = rows
      .map(
        (r) =>
          `<url><loc>${base}/api/v1/a/${encodeURIComponent(r.slug)}</loc><lastmod>${r.updatedAt.toISOString()}</lastmod></url>`,
      )
      .join('');
    res
      .type('application/xml')
      .send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
  }

  @Get('robots.txt')
  @ApiOperation({ summary: 'Public: robots.txt' })
  robots(@Res() res: Response) {
    const base = (process.env.API_URL ?? '').replace(/\/$/, '');
    res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${base}/api/v1/sitemap.xml\n`);
  }
}
