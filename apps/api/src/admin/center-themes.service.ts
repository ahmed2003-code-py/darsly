import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AdminThemeEntry } from '@darsly/shared-types';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { AdminThemeService } from './admin-theme.service';

/**
 * Center Studio — the looks a platform admin lets one Center choose from.
 *
 * Two surfaces, one list. A platform admin grants a subset of the platform's
 * whole theme shelf to a Center; the Center's own admin then picks from what
 * they were given and that becomes the organisation's brand. Nothing else about
 * branding changes: applying a look writes the same `brandTokens` /
 * `colorPrimary` / `colorAccent` the academy console, the storefront, the
 * published site and the app shell already read, so a Center that chooses a look
 * here is dressed by the machinery that was already there.
 *
 * Why a grant list at all rather than letting a Center pick anything: the shelf
 * includes every other academy's published brand. A Center helping itself to a
 * competing Center's identity is not a theme choice, it is impersonation — so
 * which looks are on offer is the platform's decision, per Center, and the
 * default is none.
 */
@Injectable()
export class CenterThemesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly themes: AdminThemeService,
    private readonly audit: AuditService,
  ) {}

  /** The whole shelf, each entry flagged with whether this Center has it. The
   *  admin's granting screen. */
  async catalogFor(academyId: string) {
    const academy = await this.requireCenter(academyId);
    const [catalog, granted] = await Promise.all([
      this.themes.catalog(),
      this.grantedIds(academyId),
    ]);
    // A Center is never offered its own brand — it already wears it, and the
    // entry would be a look that changes every time the Center changes.
    const entries = [...catalog.presets, ...catalog.academies, ...catalog.cosmetics].filter(
      (e) => e.meta.academyId !== academyId,
    );
    return {
      academyId,
      slug: academy.slug,
      name: academy.name,
      appliedThemeId: this.appliedThemeId(academy.brandTokens),
      granted: [...granted],
      themes: entries.map((e) => ({ ...e, granted: granted.has(e.id) })),
    };
  }

  /**
   * Replace the Center's grant list.
   *
   * A whole-list write rather than add/remove calls: the screen is a set of
   * checkboxes over a fixed shelf, and two admins editing it should not be able
   * to interleave into a list neither of them chose. Every id is resolved before
   * anything is stored — an id that names nothing would otherwise sit in the
   * list until a Center tried to wear it.
   *
   * Revoking the look a Center is currently wearing does NOT strip it: their
   * pages, their students' app shells and their published site are all dressed
   * in it, and repainting an organisation without warning because an admin
   * unticked a box is a worse outcome than a Center keeping a look it can no
   * longer re-pick. The grant governs choosing, not keeping.
   */
  async setGrants(academyId: string, themeIds: string[], adminUserId: string) {
    await this.requireCenter(academyId);
    const unique = [...new Set(themeIds.map((id) => id.trim()).filter(Boolean))];

    const resolved = await Promise.all(unique.map((id) => this.themes.resolve(id)));
    const unknown = unique.filter((_, i) => !resolved[i]);
    if (unknown.length) {
      throw new BadRequestException({
        message: 'Some of those themes do not exist',
        code: 'THEME_UNKNOWN',
        unknown,
      });
    }
    if (unique.includes(`academy:${academyId}`)) {
      throw new BadRequestException({
        message: 'A center cannot be granted its own brand',
        code: 'THEME_SELF_GRANT',
      });
    }

    const before = await this.grantedIds(academyId);
    await this.prisma.$transaction([
      this.prisma.academyThemeGrant.deleteMany({
        where: { academyId, themeId: { notIn: unique.length ? unique : ['\u0000'] } },
      }),
      ...unique.map((themeId) =>
        this.prisma.academyThemeGrant.upsert({
          where: { academyId_themeId: { academyId, themeId } },
          create: { academyId, themeId, grantedBy: adminUserId },
          update: {},
        }),
      ),
    ]);

    await this.audit.log({
      actorUserId: adminUserId,
      action: 'center.themes.grant',
      entity: 'Academy',
      entityId: academyId,
      academyId,
      meta: {
        added: unique.filter((id) => !before.has(id)),
        removed: [...before].filter((id) => !unique.includes(id)),
      },
    });
    return { academyId, granted: unique };
  }

  /**
   * Grant the list at creation time, inside the caller's transaction-free path.
   * Split out so AdminCentersService can hand a new Center its looks without
   * duplicating the resolve-then-store dance.
   */
  async grantAtCreation(academyId: string, themeIds: string[], adminUserId: string) {
    if (!themeIds.length) return;
    const unique = [...new Set(themeIds.map((id) => id.trim()).filter(Boolean))];
    const resolved = await Promise.all(unique.map((id) => this.themes.resolve(id)));
    const known = unique.filter((_, i) => resolved[i]);
    if (!known.length) return;
    await this.prisma.academyThemeGrant.createMany({
      data: known.map((themeId) => ({ academyId, themeId, grantedBy: adminUserId })),
      skipDuplicates: true,
    });
  }

  /** What this Center may wear, resolved — the Center Studio's own shelf. */
  async grantedFor(academyId: string) {
    const academy = await this.requireCenter(academyId);
    const ids = [...(await this.grantedIds(academyId))];
    const resolved = await Promise.all(ids.map((id) => this.themes.resolve(id)));
    // A look whose source has since been archived or deleted resolves to null
    // and is simply not offered; the stale grant row is harmless and is cleaned
    // up the next time an admin saves the list.
    const themes = resolved.filter((e): e is AdminThemeEntry => !!e);
    return {
      academyId,
      name: academy.name,
      appliedThemeId: this.appliedThemeId(academy.brandTokens),
      themes,
    };
  }

  /**
   * Wear one of the granted looks.
   *
   * The grant is checked here and not only in the UI: the Center's own admin is
   * the caller, and the id arrives from their browser. Writing the palette
   * rather than the derived tokens is the platform's existing convention (see
   * `brandTokensFromTheme`) — sharpening the derivation later then improves
   * every academy at once instead of only the ones that pick a theme again.
   */
  async apply(academyId: string, themeId: string, userId: string) {
    await this.requireCenter(academyId);
    const granted = await this.grantedIds(academyId);
    if (!granted.has(themeId)) {
      throw new ForbiddenException({
        message: 'That theme has not been granted to this center',
        code: 'THEME_NOT_ALLOWED',
      });
    }
    const entry = await this.themes.resolve(themeId);
    if (!entry)
      throw new NotFoundException({
        message: 'That theme no longer exists',
        code: 'THEME_UNKNOWN',
      });

    const palette = paletteFromAdminEntry(entry);
    const updated = await this.prisma.academy.update({
      where: { id: academyId },
      data: {
        colorPrimary: palette.primary,
        colorAccent: palette.accent,
        brandTokens: {
          // `themeId` is what makes "which look am I wearing" answerable without
          // comparing colours; the flat three are what the storefront reads.
          themeId,
          background: palette.background,
          ink: palette.ink,
          surface: palette.surface,
          palette,
        },
      },
      select: { id: true, colorPrimary: true, colorAccent: true, brandTokens: true },
    });

    await this.audit.log({
      actorUserId: userId,
      action: 'center.themes.apply',
      entity: 'Academy',
      entityId: academyId,
      academyId,
      meta: { themeId, source: entry.source, name: entry.name },
    });
    return { academyId, appliedThemeId: themeId, theme: entry, brand: updated };
  }

  private async grantedIds(academyId: string): Promise<Set<string>> {
    const rows = await this.prisma.academyThemeGrant.findMany({
      where: { academyId },
      select: { themeId: true },
    });
    return new Set(rows.map((r) => r.themeId));
  }

  /** The look recorded on the academy, if it was chosen here rather than published. */
  private appliedThemeId(brandTokens: unknown): string | null {
    const id = (brandTokens as { themeId?: unknown } | null)?.themeId;
    return typeof id === 'string' ? id : null;
  }

  private async requireCenter(academyId: string) {
    const academy = await this.prisma.academy.findFirst({
      where: { id: academyId, deletedAt: null },
      select: { id: true, slug: true, name: true, kind: true, brandTokens: true },
    });
    if (!academy)
      throw new NotFoundException({ message: 'Center not found', code: 'CENTER_NOT_FOUND' });
    if (academy.kind !== 'CENTER') {
      throw new BadRequestException({
        message: 'Theme grants apply to Centers only',
        code: 'NOT_A_CENTER',
      });
    }
    return academy;
  }
}

/**
 * An admin-catalogue entry read back as the brand palette an academy stores.
 *
 * The entry's native-mode tokens are the source: `deriveAppThemes` on the read
 * side produces both ends from this palette anyway, so recording one end and
 * deriving the other is the same shape a published site already uses.
 */
function paletteFromAdminEntry(entry: AdminThemeEntry) {
  const t = entry.tokens;
  return {
    primary: hexFromTriple(t.primary),
    accent: hexFromTriple(t.accent),
    background: hexFromTriple(t.background),
    surface: hexFromTriple(t.surface),
    surfaceAlt: hexFromTriple(t.surfaceElevated),
    ink: hexFromTriple(t.text),
    mode: entry.mode,
  };
}

/** `"110 91 211"` → `"#6e5bd3"`. */
function hexFromTriple(triple: string): string {
  const parts = triple
    .trim()
    .split(/\s+/)
    .map((n) => Math.max(0, Math.min(255, Number(n) | 0)));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return '#000000';
  return `#${parts.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}
