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
   * The dearest thing in the shop, and the last one most students will own.
   *
   * It was a hundred coins once, priced as a doorway when there was nothing else
   * on the shelf and the point was to show what a skin even is. There is a
   * ladder now, and a full skin sitting below a card style made nonsense of it —
   * so it goes where a legendary belongs: the top. Level 7 with it, because a
   * price alone can be saved up to in a fortnight and this is meant to be a
   * season's worth of work.
   *
   * Nobody who already bought it pays again: ownership is a row, and the price
   * is only read at the moment of purchase.
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
    1200,
    10,
    {
      requiredLevel: 7,
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

  /**
   * Rose & Lavender — the second skin, and the expensive one.
   *
   * Legendary, and priced like it: 950 coins and level 6. Only Egyptian King
   * sits above it. A shop whose top shelf is within a week's reach has no top
   * shelf.
   *
   * Two colours with two jobs, and the split is the design. Lavender is the
   * action: buttons, active nav, links, progress — everything the app asks you
   * to press. Rose is identity: the chips, the rails, the streak, the warmth.
   * Reversing them would make a pink app with purple buttons, which is the
   * "girly means pink" failure the brief is against.
   *
   * And no gold. The "earned" semantic is still there — XP, coins, rank and
   * level progress all read from it — but on this theme it is a deep rose. A
   * pale page forces any gold down into copper, and one brown bar is enough to
   * make everything around it look dirty; so "earned" is a third rose here,
   * darker than the streak's, rather than a metal visiting a palette it does
   * not suit.
   *
   * Frosted cards, pill buttons, 26px corners, a rounded typeface and two
   * drifting orbs — lavender in one corner, rose in the other — over a fine dot
   * field. Every one of those is a name the theme engine already knows; none of
   * it is new CSS, which is why it is the same weight as every other theme.
   */
  theme(
    'theme-rose-lavender',
    'LEGENDARY',
    'وردة اللافندر',
    'Rose & Lavender',
    'صبح وردي فاتح أو ليل بنفسجي عميق، كروت من زجاج، ومفيش أصفر ولا ذهبي في أي حتة.',
    'A blush morning or a deep violet night, cards made of frosted glass, and not a trace of gold anywhere.',
    '#8b5cf6',
    '#a78bfa',
    950,
    20,
    {
      requiredLevel: 6,
      // Rose carries identity, not action: chips, rails, the streak, the second
      // orb. Softer at night, where the fuller rose goes heavy.
      secondary: '#ff6b8b',
      secondaryDark: '#fda4af',
      // There is no gold in this theme. The slot is still the platform's
      // "earned" semantic — XP, coins, rank and level progress all read from
      // it — but here it is a deep rose rather than a metal.
      //
      // Not a decoration choice. On a pale page any gold has to fall below
      // roughly 0.28 luminance to stay legible against the deepest card, so it
      // comes back a copper or a mud-brown, and one warm brown bar is enough to
      // make a page of pink and lavender look dirty. A deep rose clears the
      // same floors with room to spare and belongs to the palette instead of
      // fighting it.
      //
      // It sits a step deeper than `secondary`, so the two still tell things
      // apart: earned reads darker, the streak reads softer.
      gold: '#c2185b',
      goldDark: '#ffb3c1',
      wash: '#fff5f7',
      washDark: '#170f28',
      // Night: deep aubergine rather than black or navy. The ink is the
      // theme's own soft lavender, so even the text belongs to the skin.
      surfaces: {
        background: '#170f28',
        surface: '#211536',
        ink: '#ede9fe',
        line: '#4c4370',
      },
      // Day is the one the look was drawn for: a blush ground rather than a
      // white one, white cards on top of it, and the night's own indigo kept as
      // the ink so the two ends read as one skin.
      surfacesLight: {
        background: '#fff5f7',
        surface: '#ffffff',
        ink: '#1e1b4b',
        line: '#efdfe6',
      },
      // A fine dot field, not a poster: at the pattern layer's own low alpha it
      // reads as dust rather than as polka dots.
      pattern: 'halftone',
      // The two orbs — lavender and rose, opposite corners, slowly drifting.
      glow: true,
      font: 'round',
      radius: 'round',
      card: 'glass',
      button: 'pill',
      nav: 'floating',
    },
  ),

  // ── Rung one: one thing, cheaply ─────────────────────────────────────────
  //
  // The bottom of the ladder, and the reason it exists. A skin is a decision
  // and a month of coins; this is a student who wants their buttons round and
  // has forty minutes of lessons to spend on it. Every one of these changes a
  // single slot across the whole app and nothing else, which is also why they
  // are the only items here that carry no colour and so can never be illegible.
  //
  // They stack with a theme and with each other: a skin brings its own shapes,
  // and these are for arguing with it.
  style('BUTTON_STYLE', 'button-pill', 'pill', 'COMMON', 'أزرار بيضاوية', 'Pill buttons',
    'حواف دايرة بالكامل على كل زرار في التطبيق.', 'Fully rounded edges on every button in the app.', 60, 100),
  style('BUTTON_STYLE', 'button-sharp', 'sharp', 'COMMON', 'أزرار حادة', 'Sharp buttons',
    'حواف شبه مستقيمة — شكل أكثر جدية.', 'Near-square edges, for a stricter look.', 60, 101),
  style('BUTTON_STYLE', 'button-elevated', 'elevated', 'COMMON', 'أزرار بارزة', 'Raised buttons',
    'ظل خفيف تحت كل زرار، كإنه مرفوع عن الصفحة.', 'A soft shadow under every button, lifting it off the page.', 80, 102),
  style('CARD_STYLE', 'card-soft', 'soft', 'COMMON', 'كروت ناعمة', 'Soft cards',
    'كورنرز أوسع وخلفية أهدى لكل كارت.', 'Wider corners and a quieter background on every card.', 80, 110),
  style('CARD_STYLE', 'card-paper', 'paper', 'COMMON', 'كروت ورق', 'Paper cards',
    'من غير ظل ولا كورنرز — مسطّح زي الورق.', 'No shadow and barely any corner — flat, like paper.', 80, 111),
  // Dearer than the rest of the rung: a blur is the one shape choice that costs
  // the phone something, so it is used sparingly and priced like it.
  style('CARD_STYLE', 'card-glass', 'glass', 'RARE', 'كروت زجاج', 'Frosted cards',
    'شفافية وضبابية خفيفة — اللي تحت الكارت بيبان من ورا.', 'Translucent and lightly blurred — what is behind shows through.', 170, 112),
  style('NAV_STYLE', 'nav-floating', 'floating', 'COMMON', 'تنقّل عائم', 'Floating nav',
    'عناصر القائمة بتبقى كبسولات دايرة.', 'Menu items become rounded capsules.', 60, 120),
  style('NAV_STYLE', 'nav-compact', 'compact', 'COMMON', 'تنقّل مضغوط', 'Compact nav',
    'مسافات أقل في القائمة — حاجات أكتر من غير نزول.', 'Tighter spacing in the menu — more of it without scrolling.', 60, 121),

  // ── Rung two: the mark on your own face ──────────────────────────────────
  //
  // A frame is the only thing here other people were ever meant to read, so it
  // is the one slot where the ladder is a ladder: bronze is an afternoon,
  // diamond is level six, and the last three cannot be bought at any price.
  style('EFFECT', 'effect-glow', 'glow', 'RARE', 'وهج', 'Glow',
    'هالة خفيفة حوالين الحاجة المختارة في القائمة.', 'A soft halo around whatever is selected in the menu.', 180, 130,
    { requiredLevel: 3 }),
  style('FRAME', 'frame-bronze', 'bronze', 'COMMON', 'إطار برونزي', 'Bronze frame',
    'حلقة برونزي حوالين صورتك في كل مكان.', 'A bronze ring around your picture, everywhere it appears.', 90, 140),
  style('FRAME', 'frame-silver', 'silver', 'COMMON', 'إطار فضي', 'Silver frame',
    'حلقة فضي حوالين صورتك في كل مكان.', 'A silver ring around your picture, everywhere it appears.', 130, 141,
    { requiredLevel: 2 }),
  style('FRAME', 'frame-gold', 'gold', 'RARE', 'إطار ذهبي', 'Gold frame',
    'حلقة ذهب حوالين صورتك في كل مكان.', 'A gold ring around your picture, everywhere it appears.', 260, 142,
    { requiredLevel: 4 }),
  style('FRAME', 'frame-lightning', 'lightning', 'RARE', 'إطار برق', 'Lightning frame',
    'حلقة صفرا لامعة حوالين صورتك.', 'A bright yellow ring around your picture.', 280, 143,
    { requiredLevel: 5 }),
  style('FRAME', 'frame-diamond', 'diamond', 'EPIC', 'إطار ألماس', 'Diamond frame',
    'حلقة سماوي بهالة حواليها.', 'A cyan ring with a halo around it.', 450, 144,
    { requiredLevel: 6 }),

  // Earned, not sold. Nothing on this rung has a price, because a mark that can
  // be bought says nothing about the person wearing it — and these three are
  // the only things in the whole shop that are a claim rather than a taste.
  style('FRAME', 'frame-scholar', 'scholar', 'RARE', 'إطار العالِم', 'Scholar frame',
    'مش بيتباع. بيجي لوحده مع إنجاز «عالِم» — تلات شهادات.',
    'Not for sale. It arrives with the "Scholar" achievement — three certificates.', 0, 145,
    { requiredAchievement: 'scholar' }),
  style('FRAME', 'frame-fire', 'fire', 'EPIC', 'إطار النار', 'Fire frame',
    'مش بيتباع. بيجي لوحده مع إنجاز «شهر كامل» — ٣٠ يوم متواصلين.',
    'Not for sale. It arrives with the "A whole month" achievement — a 30-day streak.', 0, 146,
    { requiredAchievement: 'streak_30' }),
  style('FRAME', 'frame-legendary', 'legendary', 'LEGENDARY', 'إطار الأسطورة', 'Legendary frame',
    'مش بيتباع، ومحدش يقدر يشتريه. مية يوم متواصلين وبس.',
    'Not for sale, and no amount of coins will do. A hundred-day streak, and nothing else.', 0, 147,
    { requiredAchievement: 'streak_100' }),

  // ── Rung three: a colour over the platform, not instead of it ────────────
  //
  // The middle of the ladder, and the rung that explains the top of it. These
  // bring an accent, a second colour, a wash, a backdrop, a typeface and a set
  // of shapes — everything a skin brings except **the ground**. The page stays
  // the platform's own, so the app still looks like Darsly with a mood on it.
  //
  // That is the whole difference in the price: a skin replaces where you are, a
  // tint changes the light in it.
  theme(
    'theme-mint', 'RARE', 'نعناع', 'Mint',
    'أخضر هادي وخلفية فاتحة — شكل مريح للقراءة الطويلة.',
    'A calm green over a light wash — easy on a long evening of reading.',
    '#0f766e', '#2dd4bf', 220, 200,
    {
      requiredLevel: 2,
      secondary: '#0891b2', secondaryDark: '#22d3ee',
      wash: '#effaf7', washDark: '#0b1a18',
      pattern: 'halftone', font: 'round', radius: 'soft', card: 'soft', button: 'rounded',
    },
  ),
  theme(
    'theme-ocean', 'RARE', 'محيط', 'Ocean',
    'أزرق عميق مع ضوء بيتحرك في الخلفية.',
    'A deep blue with a light that drifts behind the page.',
    '#1d4ed8', '#60a5fa', 240, 201,
    {
      requiredLevel: 2,
      secondary: '#0e7490', secondaryDark: '#38bdf8',
      wash: '#eef4ff', washDark: '#0a1020',
      pattern: 'glow', glow: true, font: 'default', radius: 'soft', card: 'elevated', button: 'rounded',
    },
  ),
  theme(
    'theme-sunset', 'EPIC', 'غروب', 'Sunset',
    'برتقالي دافي وخطوط مايلة في الخلفية.',
    'A warm orange with slanted lines running behind everything.',
    '#c2410c', '#fb923c', 320, 202,
    {
      requiredLevel: 3,
      secondary: '#be123c', secondaryDark: '#fb7185',
      wash: '#fff4ec', washDark: '#1a0f0a',
      pattern: 'speed', font: 'display', radius: 'sharp', card: 'elevated', button: 'sharp',
    },
  ),
  theme(
    'theme-grape', 'EPIC', 'عنب', 'Grape',
    'بنفسجي غامق وشبكة رفيعة بالكاد تتشاف.',
    'A deep violet over a grid you can only just see.',
    '#6d28d9', '#a78bfa', 340, 203,
    {
      requiredLevel: 4,
      secondary: '#9333ea', secondaryDark: '#c084fc',
      wash: '#f5f1ff', washDark: '#120b22',
      pattern: 'grid', glow: true, font: 'tech', radius: 'default', card: 'elevated', button: 'elevated',
    },
  ),

  // ── Rung four: a ground of its own ───────────────────────────────────────
  //
  // Where the price jumps, and it jumps for one reason: these replace the page.
  // The background, the panels and the ink all come from the theme, so the app
  // stops being Darsly-in-a-colour and becomes somewhere else.
  theme(
    'theme-paper', 'EPIC', 'ورق', 'Paper',
    'ورق دافي وحبر كحلي — مكتبة، مش تطبيق.',
    'Warm paper and navy ink — a library rather than an app.',
    '#9a3412', '#fdba74', 480, 210,
    {
      requiredLevel: 4,
      secondary: '#0f766e', secondaryDark: '#5eead4',
      gold: '#a16207', goldDark: '#fcd34d',
      wash: '#f7f1e4', washDark: '#191714',
      surfaces: { background: '#191714', surface: '#221f1a', ink: '#ece5d6', line: '#6b6455' },
      surfacesLight: { background: '#f7f1e4', surface: '#fffdf7', ink: '#1f2937', line: '#d9cfb8' },
      pattern: 'none', font: 'default', radius: 'sharp', card: 'paper', button: 'classic',
    },
  ),
  theme(
    'theme-midnight', 'EPIC', 'منتصف الليل', 'Midnight',
    'أزرق ليلي في الوضعين — الفاتح نفسه ليل، بس أهدى.',
    'Night blue at both ends — the light side is still night, only quieter.',
    '#2563eb', '#7dd3fc', 520, 211,
    {
      requiredLevel: 5,
      secondary: '#7c3aed', secondaryDark: '#a78bfa',
      gold: '#a16207', goldDark: '#fcd34d',
      wash: '#e8edf7', washDark: '#080c14',
      surfaces: { background: '#080c14', surface: '#101725', ink: '#dbe4f2', line: '#8c97ab' },
      surfacesLight: { background: '#e8edf7', surface: '#f7f9fd', ink: '#111a2b', line: '#9aa6bb' },
      pattern: 'glow', glow: true, font: 'tech', radius: 'default', card: 'glass', button: 'soft',
    },
  ),
];