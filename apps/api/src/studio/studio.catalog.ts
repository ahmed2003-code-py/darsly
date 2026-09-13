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
   * Egyptian King — the first premium cosmetic.
   *
   * A football look: Egyptian red carrying the action, gold carrying everything
   * that marks an achievement, a deep navy ground with pitch markings drawn
   * over it, and stadium light behind the page. The display pairing and the
   * sharp corners are the rest of it — a theme is a typeface and a shape as
   * much as a colour.
   *
   * Nobody's name and nobody's badge is on it. The aesthetic is Egyptian
   * football; the players and the clubs belong to themselves.
   *
   * Priced against the economy that already exists rather than picked: a
   * finished course pays 250 coins and the dearest thing in the reward store is
   * a title at 400, so 750 sits above everything on sale and lands at about
   * three courses, or three weeks of steady work. Level 3 is the floor — around
   * twenty-four lessons — so it is a goal rather than a wall.
   */
  theme(
    'theme-egyptian-king',
    'LEGENDARY',
    'الملك المصري',
    'Egyptian King',
    'أحمر وذهبي وأرضية ملعب — تجربة درسلي بروح كرة القدم المصرية.',
    'Red, gold and a marked-out pitch. Darsly with the feel of an Egyptian football night.',
    '#c8102e',
    '#f2555f',
    750,
    10,
    {
      requiredLevel: 3,
      secondary: '#b8860b',
      secondaryDark: '#fbbf24',
      wash: '#0b1326',
      washDark: '#0b1326',
      pattern: 'stadium',
      glow: true,
      font: 'display',
      radius: 'sharp',
      card: 'elevated',
      button: 'sharp',
    },
  ),
];
