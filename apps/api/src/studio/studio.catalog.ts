import { CosmeticCategory, CosmeticRarity, Prisma } from '@prisma/client';

/**
 * The cosmetics Darsly ships with.
 *
 * Seeded rather than hard-coded into components, so a theme is a row an admin
 * can price, retire or translate — and adding a seasonal one later is a row,
 * not a release. Every `config` here is read by `studio-theme.ts` and nothing
 * else; there is no path from this file to raw CSS.
 *
 * Prices are in coins. XP is never spent — `requiredLevel` is how progression
 * gates what is available, so unlocking a theme cannot cost a student a level.
 */

export interface CatalogSeed {
  key: string;
  category: CosmeticCategory;
  rarity: CosmeticRarity;
  nameAr: string;
  nameEn: string;
  descAr: string;
  descEn: string;
  config: Prisma.InputJsonValue;
  costCoins: number;
  requiredLevel?: number;
  requiredAchievement?: string;
  isStarter?: boolean;
  sortOrder: number;
}

/** A theme is a coherent look, not a colour swap: it names the accent for each
 *  end of the platform's light and dark grounds. */
const theme = (
  key: string,
  rarity: CosmeticRarity,
  nameAr: string,
  nameEn: string,
  descAr: string,
  descEn: string,
  accent: string,
  accentDark: string,
  costCoins: number,
  sortOrder: number,
  extra: Partial<CatalogSeed> & {
    wash?: string;
    washDark?: string;
    secondary?: string;
    secondaryDark?: string;
    gold?: string;
    goldDark?: string;
    surfaces?: Record<string, string>;
    surfacesLight?: Record<string, string>;
    pattern?: string;
    glow?: boolean;
    font?: string;
    radius?: string;
    button?: string;
    card?: string;
    nav?: string;
  } = {},
): CatalogSeed => ({
  key,
  category: 'THEME',
  rarity,
  nameAr,
  nameEn,
  descAr,
  descEn,
  // A theme brings its own shapes and its own backdrop, so picking one is a
  // single decision instead of five.
  config: {
    accent,
    accentDark,
    ...(extra.wash ? { wash: extra.wash } : {}),
    ...(extra.washDark ? { washDark: extra.washDark } : {}),
    ...(extra.secondary ? { secondary: extra.secondary } : {}),
    ...(extra.secondaryDark ? { secondaryDark: extra.secondaryDark } : {}),
    ...(extra.gold ? { gold: extra.gold } : {}),
    ...(extra.goldDark ? { goldDark: extra.goldDark } : {}),
    ...(extra.surfaces ? { surfaces: extra.surfaces } : {}),
    ...(extra.surfacesLight ? { surfacesLight: extra.surfacesLight } : {}),
    ...(extra.pattern ? { pattern: extra.pattern } : {}),
    ...(extra.glow ? { glow: true } : {}),
    ...(extra.font ? { font: extra.font } : {}),
    ...(extra.radius ? { radius: extra.radius } : {}),
    ...(extra.button ? { button: extra.button } : {}),
    ...(extra.card ? { card: extra.card } : {}),
    ...(extra.nav ? { nav: extra.nav } : {}),
  },
  costCoins,
  sortOrder,
  ...extra,
});

const accent = (
  key: string,
  rarity: CosmeticRarity,
  nameAr: string,
  nameEn: string,
  hex: string,
  costCoins: number,
  sortOrder: number,
  extra: Partial<CatalogSeed> = {},
): CatalogSeed => ({
  key,
  category: 'ACCENT',
  rarity,
  nameAr,
  nameEn,
  descAr: 'لون شخصي لواجهتك.',
  descEn: 'A personal colour for your interface.',
  config: { hex },
  costCoins,
  sortOrder,
  ...extra,
});

const style = (
  category: CosmeticCategory,
  key: string,
  value: string,
  rarity: CosmeticRarity,
  nameAr: string,
  nameEn: string,
  descAr: string,
  descEn: string,
  costCoins: number,
  sortOrder: number,
  extra: Partial<CatalogSeed> = {},
): CatalogSeed => ({
  key,
  category,
  rarity,
  nameAr,
  nameEn,
  descAr,
  descEn,
  config: { style: value },
  costCoins,
  sortOrder,
  ...extra,
});

/**
 * The cosmetics Darsly ships with.
 *
 * Deliberately empty. The Studio, the economy and the theme engine are all
 * here and tested; what a student can actually wear is a decision about the
 * product rather than about the code, and it is being made one item at a time.
 *
 * Adding one back is a single entry in this array — the seeder upserts it on
 * boot and it appears in the shop. Nothing else has to change.
 *
 * Example:
 *
 *   theme('theme-ocean', 'COMMON', 'عمق', 'Deep', '…', '…',
 *     '#0f6f9c', '#3fb3e0', 120, 20,
 *     { wash: '#0f6f9c', pattern: 'glow', font: 'display', radius: 'sharp' }),
 *
 * The helpers above build the row; `studio-theme.ts` is what reads `config`,
 * and it will refuse any name it does not know.
 */
export const CATALOG: CatalogSeed[] = [
  /**
   * Egyptian King — a skin, not a palette.
   *
   * The difference is the ground. A theme that only moves the accent leaves the
   * platform's greys underneath and reads as "the same app in red"; this one
   * brings its own near-black navy, its own panels and its own ink, so the app
   * becomes a night stadium and the red is what happens in it.
   *
   * Three colours doing three jobs. Navy is the environment — most of what you
   * see. Crimson is action: the thing to press, the thing that is live. Gold is
   * earned — XP, coins, trophies, rank — and nothing else, which is what stops
   * it becoming decoration.
   *
   * Nobody's name and nobody's badge is on it. The aesthetic is Egyptian
   * football; the players and the clubs belong to themselves.
   *
   * A hundred coins: ten lessons, or two days of steady work. Priced to be had
   * rather than saved for, because the first skin's job is to show what a skin
   * is. No level gate for the same reason.
   */
  theme(
    'theme-egyptian-king',
    'LEGENDARY',
    'الملك المصري',
    'Egyptian King',
    'ملعب كامل — ليل أزرق داكن أو نهار دافي، أحمر مصري، وذهب لكل حاجة بتتكسب.',
    'A whole stadium — deep navy by night or warm chalk by day, Egyptian crimson, and gold for everything earned.',
    '#dc2626',
    '#ef4444',
    100,
    10,
    {
      secondary: '#ee9800',
      secondaryDark: '#ffb95f',
      // Old gold on chalk, floodlit amber at night. The day value is picked to
      // clear its floors untouched: a brighter gold gets darkened into olive,
      // and a medal that looks olive is not a medal.
      gold: '#a16207',
      goldDark: '#ffb95f',
      wash: '#f3efe6',
      washDark: '#0a0e16',
      surfaces: {
        background: '#0a0e16',
        surface: '#121722',
        ink: '#dfe2ee',
        line: '#aeb5c5',
      },
      // The same match in the afternoon.
      //
      // Warm chalk rather than white — a sunlit stand, not an office — and the
      // night version's navy kept as the ink, so the two ends read as one skin
      // rather than two themes. Everything that carries the identity is
      // unchanged: the crimson, the gold, the pitch markings, the typeface.
      surfacesLight: {
        background: '#f6f2e9',
        surface: '#ffffff',
        ink: '#151b28',
        line: '#5a6376',
      },
      pattern: 'stadium',
      glow: true,
      font: 'display',
      radius: 'sharp',
      card: 'elevated',
      button: 'sharp',
    },
  ),
];