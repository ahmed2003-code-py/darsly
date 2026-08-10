import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { readFile } from 'fs/promises';
import { NextFunction, Request, Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { deriveAppTheme, paletteFromBrandTokens } from './app-theme';
import { academySlugFromUrl, injectTheme } from './academy-theme.html';

/**
 * Serve the app already wearing the academy's colours.
 *
 * Sits in front of the static handler and only ever takes over the one case it
 * can improve: a document request for a page that names an academy. Everything
 * else — assets, the API, an unknown slug, an academy with no published design —
 * falls straight through, so the ordinary path is a regex and nothing more.
 *
 * It fails open, always. A theme is a nicety; serving the page is not. Any error
 * here hands the request back to the static handler and the app themes itself a
 * moment later exactly as it did before.
 */
@Injectable()
export class AcademyThemeMiddleware implements NestMiddleware {
  private readonly logger = new Logger(AcademyThemeMiddleware.name);
  /** The built index.html, read once. It cannot change without a redeploy. */
  private shell?: string;
  /** Derived themes by slug. Short-lived: publishing must show up quickly. */
  private readonly cache = new Map<string, { theme: string | null; until: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly indexPath: string,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    // Only real page loads. An asset, a fetch or a POST has nothing to theme.
    if (req.method !== 'GET' || !req.headers.accept?.includes('text/html')) return next();

    const slug = academySlugFromUrl(req.originalUrl || req.url);
    if (!slug) return next();

    try {
      const css = await this.themeFor(slug);
      if (!css) return next();
      const shell = await this.readShell();
      if (!shell) return next();
      res
        .status(200)
        .type('html')
        // The document varies by academy, so a shared cache must not hand one
        // teacher's colours to another teacher's visitor.
        .set('Cache-Control', 'no-store')
        .send(injectTheme(shell, JSON.parse(css)));
    } catch (e) {
      this.logger.warn(`theme injection skipped for ${slug}: ${String(e)}`);
      next();
    }
  }

  private async readShell(): Promise<string | undefined> {
    if (this.shell === undefined) {
      this.shell = await readFile(this.indexPath, 'utf8').catch(() => '');
    }
    return this.shell || undefined;
  }

  private async themeFor(slug: string): Promise<string | null> {
    const hit = this.cache.get(slug);
    if (hit && hit.until > Date.now()) return hit.theme;

    const academy = await this.prisma.academy.findFirst({
      where: { slug, deletedAt: null, status: { in: ['ACTIVE', 'PENDING'] } },
      select: { colorPrimary: true, colorAccent: true, brandTokens: true },
    });
    const palette = academy
      ? paletteFromBrandTokens(academy.brandTokens, academy.colorPrimary, academy.colorAccent)
      : null;
    // No academy, or one that has never chosen anything: nothing to inject, and
    // the platform's own stylesheet is already correct.
    const theme = palette ? JSON.stringify(deriveAppTheme(palette)) : null;

    // Both answers are cached. A slug that does not resolve is the shape a
    // crawler or a typo produces, and it must not become a database query each
    // time. 30 seconds keeps a publish feeling immediate.
    this.cache.set(slug, { theme, until: Date.now() + 30_000 });
    return theme;
  }
}
