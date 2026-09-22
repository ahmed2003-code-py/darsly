import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ADMIN_THEME_PRESETS,
  AdminThemeEntry,
  AdminThemeTokens,
  presetEntry,
} from '@darsly/shared-types';
import { AppTheme, BrandPalette, deriveAppTheme, paletteFromBrandTokens } from '../branding/app-theme';
import { PrismaService } from '../prisma/prisma.service';
import { safeHex, ThemeConfig } from '../studio/studio-theme';

export interface AdminThemePreference {
  themeId: string | null;
  /** The chosen look, resolved — null when nothing is chosen or the choice no longer exists. */
  theme: AdminThemeEntry | null;
}

export interface AdminThemeCatalog {
  presets: AdminThemeEntry[];
  academies: AdminThemeEntry[];
  cosmetics: AdminThemeEntry[];
}

const ACADEMY_SELECT = {
  id: true, name: true, slug: true, kind: true, logoUrl: true, brandTokens: true, colorPrimary: true, colorAccent: true,
  owner: { select: { fullName: true } },
} satisfies Prisma.AcademySelect;
type AcademyRow = Prisma.AcademyGetPayload<{ select: typeof ACADEMY_SELECT }>;

const COSMETIC_SELECT = { key: true, nameAr: true, nameEn: true, rarity: true, config: true } satisfies Prisma.CosmeticItemSelect;
type CosmeticRow = Prisma.CosmeticItemGetPayload<{ select: typeof COSMETIC_SELECT }>;

/**
 * A SUPER_ADMIN's own console look — per-admin, never platform-wide, and
 * never read outside /admin/*. Persisted as one namespaced id in
 * User.adminThemePreference; every colour is resolved HERE from the source
 * the id names, so nothing a client sends is ever painted:
 *
 *   preset:<id>        the built-in presets (shared-types)
 *   academy:<id>       any Academy's published brand — a Center's or a
 *                      teacher's — run through the same contrast-floored
 *                      derivation the academy console itself uses
 *   cosmetic:<key>     any active store THEME, from its stored config
 *
 * A bare id from before the catalogue existed still resolves as a preset.
 * Every read/write is scoped to the caller's own userId — there is no "set
 * theme for user X" path, so this is IDOR-proof by construction.
 */
@Injectable()
export class AdminThemeService {
  constructor(private readonly prisma: PrismaService) {}

  async catalog(): Promise<AdminThemeCatalog> {
    const [academies, cosmetics] = await Promise.all([
      this.prisma.academy.findMany({
        where: { deletedAt: null, status: { not: 'ARCHIVED' } },
        select: ACADEMY_SELECT,
        orderBy: [{ kind: 'desc' }, { createdAt: 'asc' }],
      }),
      this.prisma.cosmeticItem.findMany({
        where: { category: 'THEME', isActive: true },
        select: COSMETIC_SELECT,
        orderBy: { sortOrder: 'asc' },
      }),
    ]);
    return {
      presets: ADMIN_THEME_PRESETS.map(presetEntry),
      academies: academies.map(academyEntry),
      cosmetics: cosmetics.map(cosmeticEntry),
    };
  }

  async get(userId: string): Promise<AdminThemePreference> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { adminThemePreference: true } });
    const stored = (user?.adminThemePreference as { themeId?: unknown } | null)?.themeId;
    if (typeof stored !== 'string' || !stored) return { themeId: null, theme: null };
    const theme = await this.resolve(stored);
    return theme ? { themeId: theme.id, theme } : { themeId: null, theme: null };
  }

  async set(userId: string, themeId: string | null): Promise<AdminThemePreference> {
    const theme = themeId === null ? null : await this.resolve(themeId);
    if (themeId !== null && !theme) throw new BadRequestException({ message: `Unknown admin theme: ${themeId}`, code: 'ADMIN_THEME_UNKNOWN' });
    await this.prisma.user.update({
      where: { id: userId },
      data: { adminThemePreference: theme ? { themeId: theme.id } : Prisma.DbNull },
    });
    return { themeId: theme?.id ?? null, theme };
  }

  /** One id → one fully resolved look, or null if it names nothing that exists any more. */
  async resolve(themeId: string): Promise<AdminThemeEntry | null> {
    const [ns, ...rest] = themeId.split(':');
    const ref = rest.join(':');
    if (!ref) {
      const preset = ADMIN_THEME_PRESETS.find((p) => p.id === themeId);
      return preset ? presetEntry(preset) : null;
    }
    if (ns === 'preset') {
      const preset = ADMIN_THEME_PRESETS.find((p) => p.id === ref);
      return preset ? presetEntry(preset) : null;
    }
    if (ns === 'academy') {
      const row = await this.prisma.academy.findFirst({ where: { id: ref, deletedAt: null, status: { not: 'ARCHIVED' } }, select: ACADEMY_SELECT });
      return row ? academyEntry(row) : null;
    }
    if (ns === 'cosmetic') {
      const row = await this.prisma.cosmeticItem.findFirst({ where: { key: ref, category: 'THEME', isActive: true }, select: COSMETIC_SELECT });
      return row ? cosmeticEntry(row) : null;
    }
    return null;
  }
}

// ── resolution ───────────────────────────────────────────────────────────────

function academyEntry(a: AcademyRow): AdminThemeEntry {
  const palette = paletteFromBrandTokens(a.brandTokens, a.colorPrimary, a.colorAccent);
  const app = deriveAppTheme(palette);
  return {
    id: `academy:${a.id}`,
    source: 'ACADEMY',
    name: a.name,
    subtitle: a.owner?.fullName ?? null,
    mode: app.mode,
    tokens: adminTokensFrom(app),
    meta: { academyId: a.id, academyKind: a.kind, slug: a.slug, logoUrl: a.logoUrl, ownerName: a.owner?.fullName ?? null },
  };
}

function cosmeticEntry(c: CosmeticRow): AdminThemeEntry {
  const cfg = (c.config && typeof c.config === 'object' ? c.config : {}) as ThemeConfig;
  const app = deriveAppTheme(paletteFromCosmetic(cfg));
  return {
    id: `cosmetic:${c.key}`,
    source: 'COSMETIC',
    name: c.nameAr,
    subtitle: c.nameEn,
    mode: app.mode,
    tokens: adminTokensFrom(app),
    meta: { cosmeticKey: c.key, rarity: c.rarity, pattern: typeof cfg.pattern === 'string' ? cfg.pattern : null },
  };
}

/**
 * A store theme's stored config, read as a brand palette. A skin brings its
 * own ground (`surfaces`) and reads dark; a tint has only an accent and sits
 * on the platform's paper. The accent named for the ground the theme owns is
 * the one used — never a client-supplied colour.
 */
export function paletteFromCosmetic(cfg: ThemeConfig): BrandPalette {
  const ground = cfg.surfaces ?? null;
  const dark = !!ground;
  const primary = (dark ? safeHex(cfg.accentDark) : null) ?? safeHex(cfg.accent) ?? undefined;
  const accent = (dark ? safeHex(cfg.secondaryDark) ?? safeHex(cfg.goldDark) : null) ?? safeHex(cfg.secondary) ?? safeHex(cfg.gold) ?? primary;
  return {
    primary,
    accent,
    background: safeHex(ground?.background) ?? safeHex(cfg.wash) ?? undefined,
    surface: safeHex(ground?.surface) ?? undefined,
    ink: safeHex(ground?.ink) ?? undefined,
  };
}

/**
 * The console's derived tokens, reduced to the admin shell's 17. Every value
 * below already cleared the app-theme contrast floors; this only chooses
 * which role fills which slot. Success/warning are not part of a brand
 * palette, so they are seated per mode rather than invented from it.
 */
export function adminTokensFrom(app: AppTheme): AdminThemeTokens {
  const c = (name: string) => app.tokens[`--c-${name}`];
  const dark = app.mode === 'dark';
  return {
    background: c('background'),
    surface: c('surface-container'),
    surfaceElevated: c('surface-container-high'),
    text: c('on-surface'),
    textMuted: c('on-surface-variant'),
    primary: c('primary'),
    secondary: c('secondary'),
    accent: c('brand-accent'),
    success: dark ? '52 199 89' : '22 163 74',
    warning: dark ? '251 191 36' : '180 83 9',
    danger: c('error'),
    border: c('surface-container-highest'),
    sidebar: c('surface-container-lowest'),
    topbar: c('surface-container'),
    chart1: c('primary'),
    chart2: c('brand-accent'),
    chart3: c('secondary'),
  };
}
