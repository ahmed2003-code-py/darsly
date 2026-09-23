import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ADMIN_THEME_PRESETS,
  AdminThemeEntry,
  AdminThemeMode,
  AdminThemePreset,
  AdminThemeTokens,
  hexFromTriple,
  presetEntry,
  ThemeSwatch,
} from '@darsly/shared-types';
import {
  AppTheme,
  BrandPalette,
  deriveAppTheme,
  deriveAppThemeFor,
  paletteFromBrandTokens,
} from '../branding/app-theme';
import { PrismaService } from '../prisma/prisma.service';
import {
  deriveStudioThemes,
  groundMode,
  safeHex,
  surfaceGround,
  ThemeConfig,
} from '../studio/studio-theme';

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
  id: true,
  name: true,
  slug: true,
  kind: true,
  logoUrl: true,
  brandTokens: true,
  colorPrimary: true,
  colorAccent: true,
  owner: { select: { fullName: true } },
} satisfies Prisma.AcademySelect;
type AcademyRow = Prisma.AcademyGetPayload<{ select: typeof ACADEMY_SELECT }>;

const COSMETIC_SELECT = {
  key: true,
  nameAr: true,
  nameEn: true,
  rarity: true,
  config: true,
} satisfies Prisma.CosmeticItemSelect;
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
      presets: ADMIN_THEME_PRESETS.map(bothModesPreset),
      academies: academies.map(academyEntry),
      cosmetics: cosmetics.map(cosmeticEntry),
    };
  }

  async get(userId: string): Promise<AdminThemePreference> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { adminThemePreference: true },
    });
    const stored = (user?.adminThemePreference as { themeId?: unknown } | null)?.themeId;
    if (typeof stored !== 'string' || !stored) return { themeId: null, theme: null };
    const theme = await this.resolve(stored);
    return theme ? { themeId: theme.id, theme } : { themeId: null, theme: null };
  }

  async set(userId: string, themeId: string | null): Promise<AdminThemePreference> {
    const theme = themeId === null ? null : await this.resolve(themeId);
    if (themeId !== null && !theme)
      throw new BadRequestException({
        message: `Unknown admin theme: ${themeId}`,
        code: 'ADMIN_THEME_UNKNOWN',
      });
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
      return preset ? bothModesPreset(preset) : null;
    }
    if (ns === 'preset') {
      const preset = ADMIN_THEME_PRESETS.find((p) => p.id === ref);
      return preset ? bothModesPreset(preset) : null;
    }
    if (ns === 'academy') {
      const row = await this.prisma.academy.findFirst({
        where: { id: ref, deletedAt: null, status: { not: 'ARCHIVED' } },
        select: ACADEMY_SELECT,
      });
      return row ? academyEntry(row) : null;
    }
    if (ns === 'cosmetic') {
      const row = await this.prisma.cosmeticItem.findFirst({
        where: { key: ref, category: 'THEME', isActive: true },
        select: COSMETIC_SELECT,
      });
      return row ? cosmeticEntry(row) : null;
    }
    return null;
  }
}

// ── resolution ───────────────────────────────────────────────────────────────

/**
 * One palette, both ends, reduced to the admin shell's tokens.
 *
 * `deriveAppThemeFor` is the same function the academy console uses to show a
 * published palette at the other end of the day: the brand hue is kept, the
 * neutrals are re-seated, and every contrast floor is enforced by the code that
 * already enforces them for the palette's native mode. Deriving here rather
 * than inventing a second set of rules is the point — an admin look and an
 * academy look go dark by the same means.
 */
function bothModes(
  palette: BrandPalette | null,
): Pick<AdminThemeEntry, 'mode' | 'tokens' | 'modes'> {
  const native = deriveAppTheme(palette);
  const modes = {
    light: adminTokensFrom(deriveAppThemeFor(palette, 'light')),
    dark: adminTokensFrom(deriveAppThemeFor(palette, 'dark')),
  };
  return { mode: native.mode, tokens: modes[native.mode], modes };
}

/**
 * A built-in preset, at both ends.
 *
 * The preset's own tokens are kept verbatim for the mode it was designed in —
 * these are drawn looks and re-deriving them would mean shipping a "Darsly
 * Dark" that is not the one anybody approved. Only the opposite end is derived,
 * from the preset read back as a brand palette.
 */
function bothModesPreset(preset: AdminThemePreset): AdminThemeEntry {
  const other: AdminThemeMode = preset.mode === 'dark' ? 'light' : 'dark';
  const derived = adminTokensFrom(deriveAppThemeFor(paletteFromAdminTokens(preset.tokens), other));
  return {
    ...presetEntry(preset),
    modes: { [preset.mode]: preset.tokens, [other]: derived } as Record<
      AdminThemeMode,
      AdminThemeTokens
    >,
  };
}

/** An admin token set read back as the five-field palette the derivation takes. */
function paletteFromAdminTokens(tokens: AdminThemeTokens): BrandPalette {
  return {
    background: hexFromTriple(tokens.background),
    surface: hexFromTriple(tokens.surface),
    surfaceAlt: hexFromTriple(tokens.surfaceElevated),
    ink: hexFromTriple(tokens.text),
    primary: hexFromTriple(tokens.primary),
    accent: hexFromTriple(tokens.accent),
  };
}

function academyEntry(a: AcademyRow): AdminThemeEntry {
  const palette = paletteFromBrandTokens(a.brandTokens, a.colorPrimary, a.colorAccent);
  return {
    id: `academy:${a.id}`,
    source: 'ACADEMY',
    name: a.name,
    subtitle: a.owner?.fullName ?? null,
    ...bothModes(palette),
    // Exactly the card a student sees for this academy in their Studio (the
    // teachers' looks row): the brand's two colours, on no ground of its own.
    swatch: { accent: palette?.primary ?? '#4a32c9', accentDark: palette?.accent ?? null },
    meta: {
      academyId: a.id,
      academyKind: a.kind,
      slug: a.slug,
      logoUrl: a.logoUrl,
      ownerName: a.owner?.fullName ?? null,
    },
  };
}

function cosmeticEntry(c: CosmeticRow): AdminThemeEntry {
  const cfg = (c.config && typeof c.config === 'object' ? c.config : {}) as ThemeConfig;
  return {
    id: `cosmetic:${c.key}`,
    source: 'COSMETIC',
    name: c.nameAr,
    subtitle: c.nameEn,
    ...cosmeticModes(cfg),
    swatch: swatchFromCosmetic(cfg),
    meta: {
      cosmeticKey: c.key,
      rarity: c.rarity,
      pattern: typeof cfg.pattern === 'string' ? cfg.pattern : null,
    },
  };
}

/**
 * A store theme, at both ends, in the colours a student wearing it sees.
 *
 * This used to read only the theme's dark ground as an academy palette and
 * derive the light end from a generic paper — so a skin that ships its own
 * day ground (`surfacesLight`: Editorial's cream, Egyptian King's chalk) came
 * out as a different theme in the admin console from the one a student
 * bought. It now runs through `deriveStudioThemes`, the only engine a
 * student's theme is ever resolved by, and takes each end's ground, accent
 * family, partner and gold from it. What a tint does not bring — a ground —
 * is the platform's own page, which is also what a student wearing a tint
 * sits on.
 */
export function cosmeticModes(
  cfg: ThemeConfig,
): Pick<AdminThemeEntry, 'mode' | 'tokens' | 'modes'> {
  const studio = deriveStudioThemes({ themeConfig: cfg });
  const end = (want: AdminThemeMode): AdminThemeTokens => {
    const groundCfg = want === 'dark' ? cfg.surfaces : (cfg.surfacesLight ?? cfg.surfaces);
    // The seating follows the ground, not the switch — the student rule.
    const mode = groundCfg ? groundMode(surfaceGround(groundCfg)) : want;
    const side = studio[want];
    const base = deriveAppThemeFor(null, mode);
    const tokens = adminTokensFrom({ mode, tokens: { ...base.tokens, ...side.brand } });
    const partner = side.tokens['--s-secondary'] ?? side.tokens['--s-gold'];
    return {
      ...tokens,
      ...(side.tokens['--s-secondary'] ? { secondary: side.tokens['--s-secondary'] } : {}),
      ...(partner ? { accent: partner, chart2: partner } : {}),
      ...(side.tokens['--s-gold'] ? { chart3: side.tokens['--s-gold'] } : {}),
    };
  };
  const modes = { light: end('light'), dark: end('dark') };
  const native: AdminThemeMode = cfg.surfaces ? groundMode(surfaceGround(cfg.surfaces)) : 'light';
  return { mode: native, tokens: modes[native], modes };
}

/**
 * The student Studio's card for this theme, field for field (StudioPage's
 * `Swatch`): the accent, the dark accent, gold-or-partner, the theme's own
 * (night) ground and its pattern. Every colour through `safeHex`, so a stored
 * config can put nothing on the page but a colour.
 */
export function swatchFromCosmetic(cfg: ThemeConfig): ThemeSwatch {
  const ground = cfg.surfaces ?? null;
  return {
    accent: safeHex(cfg.accent) ?? '#c8102e',
    accentDark: safeHex(cfg.accentDark),
    gold: safeHex(cfg.gold) ?? safeHex(cfg.secondary),
    surfaces: ground
      ? {
          background: safeHex(ground.background) ?? undefined,
          surface: safeHex(ground.surface) ?? undefined,
          ink: safeHex(ground.ink) ?? undefined,
        }
      : null,
    pattern: typeof cfg.pattern === 'string' ? cfg.pattern : null,
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
