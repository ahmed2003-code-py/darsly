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
    pattern?: string;
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
    ...(extra.pattern ? { pattern: extra.pattern } : {}),
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

export const CATALOG: CatalogSeed[] = [
  // ── Themes ────────────────────────────────────────────────────────────────
  //
  // One pick, one whole look: a colour for both ends of the palette, a wash
  // under the page, a pattern drawn over it, and the shapes the buttons and
  // cards take. Nothing here is a photograph and nothing is a licence — the
  // loud ones borrow an energy, not a character, because the characters belong
  // to the people who made them.
  theme('theme-paper', 'COMMON', 'ورق وحبر', 'Paper & Ink', 'مظهر درسلي الأساسي — هادي وواضح.',
    "Darsly's own look — calm and clear.", '#4a32c9', '#8d7bf0', 0, 10, { isStarter: true }),

  theme('theme-ocean', 'COMMON', 'عمق', 'Deep', 'أزرق ساكن بيريّح العين في المذاكرة الطويلة.',
    'A still blue that holds up over a long session.', '#0f6f9c', '#3fb3e0', 120, 20,
    { wash: '#0f6f9c', washDark: '#0ea5e9', pattern: 'glow', card: 'soft', button: 'rounded' }),

  theme('theme-forest', 'COMMON', 'ملعب', 'Pitch', 'أخضر النجيلة وخطوط الملعب — لو الكورة مالياك.',
    'Mown grass and touchlines, for anyone who lives on a pitch.', '#15803d', '#4ade80', 120, 30,
    { wash: '#15803d', washDark: '#22c55e', pattern: 'pitch', card: 'soft', button: 'pill' }),

  theme('theme-court', 'RARE', 'ملعب سلة', 'Court', 'برتقالي وأسود ونقط كوميكس — إيقاع سريع.',
    'Orange, black and comic dots, played fast.', '#c2410c', '#fb923c', 250, 40,
    { wash: '#431407', washDark: '#ea580c', pattern: 'halftone', card: 'elevated', button: 'sharp' }),

  // The colours and the crosshatch of a certain wall-crawler, with no character
  // and no badge anywhere near it. The palette is not the trademark.
  theme('theme-web', 'EPIC', 'خيوط', 'Webline', 'أحمر على أزرق وشبكة خيوط — طاقة أبطال الكوميكس.',
    'Red over blue with a web of lines. Comic-book energy, nobody else\'s name on it.',
    '#dc2626', '#f87171', 600, 50,
    { requiredLevel: 3, wash: '#1e3a8a', washDark: '#1d4ed8', pattern: 'web', card: 'elevated', button: 'sharp' }),

  theme('theme-steel', 'EPIC', 'فولاذ', 'Steel', 'أزرق وأحمر وذهبي — شكل بطل كلاسيكي.',
    'Blue, red and gold. The classic hero palette.', '#1d4ed8', '#60a5fa', 600, 55,
    { requiredLevel: 4, wash: '#7f1d1d', washDark: '#1e40af', pattern: 'rays', card: 'elevated', button: 'elevated' }),

  theme('theme-nocturne', 'EPIC', 'مدينة الليل', 'Nocturne', 'أسود وأصفر — ظلام المدينة.',
    'Black and yellow, after dark.', '#ca8a04', '#facc15', 600, 60,
    { requiredLevel: 4, wash: '#0c0a09', washDark: '#1c1917', pattern: 'speed', card: 'elevated', button: 'sharp' }),

  theme('theme-cyber', 'EPIC', 'نيون', 'Neon', 'طاقة عالية وحواف حادّة وشبكة تقنية.',
    'High energy, sharp edges, a technical grid.', '#0d9488', '#2dd4bf', 500, 70,
    { requiredLevel: 3, wash: '#042f2e', washDark: '#14b8a6', pattern: 'grid', card: 'glass', button: 'sharp' }),

  theme('theme-midnight', 'RARE', 'آخر الليل', 'Midnight', 'أناقة داكنة لمحبّي المذاكرة بالليل.',
    'Dark and quiet, for people who study late.', '#4338ca', '#a5b4fc', 250, 80,
    { wash: '#312e81', washDark: '#4338ca', pattern: 'glow', card: 'soft', button: 'rounded' }),

  theme('theme-crimson', 'RARE', 'الأحمر', 'Crimson', 'أحمر وأبيض — ألوان الكلاسيكيات.',
    'Red and white. Classic kit colours.', '#b91c1c', '#f87171', 250, 90,
    { wash: '#7f1d1d', washDark: '#dc2626', pattern: 'pitch', card: 'soft', button: 'pill' }),

  theme('theme-sky', 'RARE', 'السماوي', 'Sky', 'أزرق سماوي وأبيض.',
    'Sky blue and white.', '#0369a1', '#38bdf8', 250, 95,
    { wash: '#075985', washDark: '#0284c7', pattern: 'pitch', card: 'soft', button: 'pill' }),

  theme('theme-aurora', 'LEGENDARY', 'شفق', 'Aurora', 'ألوان متدرّجة هادية — أرقى مظهر في الاستوديو.',
    'The most considered look in the Studio.', '#7c3aed', '#c4b5fd', 900, 100,
    { requiredLevel: 6, wash: '#4c1d95', washDark: '#7c3aed', pattern: 'rays', card: 'glass', button: 'elevated' }),

  theme('theme-scholar', 'LEGENDARY', 'وسام', 'Laureate', 'بيتفتح لما تخلّص أول دورة كاملة.',
    'Unlocked by finishing your first course.', '#92400e', '#fbbf24', 0, 110,
    { requiredAchievement: 'first_course', wash: '#451a03', washDark: '#b45309', pattern: 'rays', card: 'elevated', button: 'elevated' }),

  // ── Accents ───────────────────────────────────────────────────────────────
  accent('accent-default', 'COMMON', 'الأساسي', 'Default', '#4a32c9', 0, 10, { isStarter: true }),
  accent('accent-violet', 'COMMON', 'ڤيوليت', 'Violet', '#7c3aed', 80, 20),
  accent('accent-teal', 'COMMON', 'تركواز', 'Teal', '#0d9488', 80, 30),
  accent('accent-rose', 'RARE', 'روز', 'Rose', '#be123c', 180, 40),
  accent('accent-amber', 'RARE', 'عنبر', 'Amber', '#b45309', 180, 50),
  accent('accent-fire', 'EPIC', 'جمرة', 'Ember', '#dc2626', 0, 60,
    { requiredAchievement: 'streak_7', descAr: 'بيتفتح مع سلسلة ٧ أيام.', descEn: 'Unlocked by a seven-day streak.' }),

  // ── Buttons ───────────────────────────────────────────────────────────────
  style('BUTTON_STYLE', 'button-classic', 'classic', 'COMMON', 'الأساسي', 'Classic',
    'شكل الأزرار الأساسي.', 'The default button shape.', 0, 10, { isStarter: true }),
  style('BUTTON_STYLE', 'button-rounded', 'rounded', 'COMMON', 'ناعم', 'Rounded',
    'حواف أنعم شوية.', 'A softer corner.', 60, 20),
  style('BUTTON_STYLE', 'button-pill', 'pill', 'RARE', 'كبسولة', 'Capsule',
    'أزرار دايرية بالكامل.', 'Fully rounded buttons.', 150, 30),
  style('BUTTON_STYLE', 'button-sharp', 'sharp', 'RARE', 'حادّ', 'Edge',
    'حواف مستقيمة وحاسمة.', 'Straight, decisive edges.', 150, 40),
  style('BUTTON_STYLE', 'button-elevated', 'elevated', 'EPIC', 'طاير', 'Lift',
    'ظل خفيف بيدّي إحساس بالعمق.', 'A quiet shadow that lifts them.', 300, 50, { requiredLevel: 3 }),

  // ── Cards ─────────────────────────────────────────────────────────────────
  style('CARD_STYLE', 'card-minimal', 'minimal', 'COMMON', 'الأساسي', 'Minimal',
    'خطوط رفيعة من غير ظل.', 'Hairlines, no shadow.', 0, 10, { isStarter: true }),
  style('CARD_STYLE', 'card-soft', 'soft', 'COMMON', 'ناعم', 'Soft',
    'زوايا أنعم وخلفية أفتح.', 'Softer corners, a lighter ground.', 60, 20),
  style('CARD_STYLE', 'card-elevated', 'elevated', 'RARE', 'طاير', 'Raised',
    'كروت طايرة فوق الصفحة.', 'Cards that sit above the page.', 150, 30),
  style('CARD_STYLE', 'card-paper', 'paper', 'RARE', 'ورقي', 'Paper',
    'ملمس ورقي على هوية درسلي.', "Paper-like, in Darsly's own idiom.", 150, 40),
  style('CARD_STYLE', 'card-glass', 'glass', 'EPIC', 'زجاج', 'Glass',
    'شفافية خفيفة — مستخدمة بحساب.', 'A little translucency, used sparingly.', 300, 50, { requiredLevel: 4 }),

  // ── Navigation ────────────────────────────────────────────────────────────
  style('NAV_STYLE', 'nav-classic', 'classic', 'COMMON', 'الأساسي', 'Classic',
    'القايمة الأساسية.', 'The default navigation.', 0, 10, { isStarter: true }),
  style('NAV_STYLE', 'nav-compact', 'compact', 'COMMON', 'مضغوط', 'Compact',
    'مساحات أقل، عناصر أكتر في الشاشة.', 'Tighter rows, more on screen.', 60, 20),
  style('NAV_STYLE', 'nav-floating', 'floating', 'EPIC', 'عايم', 'Float',
    'القايمة بتبان كإنها طايرة فوق الصفحة.', 'The navigation floats above the page.', 300, 30, { requiredLevel: 3 }),

  // ── Avatars ───────────────────────────────────────────────────────────────
  style('AVATAR', 'avatar-initial', 'initial', 'COMMON', 'حرفك', 'Initial',
    'أول حرف من اسمك.', 'The first letter of your name.', 0, 10, { isStarter: true }),
  style('AVATAR', 'avatar-orbit', 'orbit', 'COMMON', 'مدار', 'Orbit',
    'حلقات حوالين حرفك.', 'Rings around your letter.', 80, 20),
  style('AVATAR', 'avatar-wave', 'wave', 'RARE', 'موجة', 'Wave',
    'تدرّج موجي هادي.', 'A quiet wave gradient.', 180, 30),
  style('AVATAR', 'avatar-grid', 'grid', 'RARE', 'شبكة', 'Grid',
    'نمط هندسي منتظم.', 'An even geometric pattern.', 180, 40),
  style('AVATAR', 'avatar-bloom', 'bloom', 'EPIC', 'هالة', 'Halo',
    'هالة ملوّنة.', 'A coloured bloom.', 350, 50, { requiredLevel: 3 }),
  style('AVATAR', 'avatar-prism', 'prism', 'LEGENDARY', 'منشور', 'Prism',
    'انكسار ضوئي — أندر شكل.', 'Refracted light — the rarest of them.', 700, 60, { requiredLevel: 6 }),

  // ── Frames ────────────────────────────────────────────────────────────────
  style('FRAME', 'frame-none', 'none', 'COMMON', 'بدون', 'None',
    'من غير إطار.', 'No frame at all.', 0, 10, { isStarter: true }),
  style('FRAME', 'frame-bronze', 'bronze', 'COMMON', 'برونز', 'Bronze',
    'إطار برونزي.', 'A bronze ring.', 100, 20),
  style('FRAME', 'frame-silver', 'silver', 'RARE', 'فضّة', 'Silver',
    'إطار فضّي.', 'A silver ring.', 220, 30, { requiredLevel: 2 }),
  style('FRAME', 'frame-gold', 'gold', 'EPIC', 'دهب', 'Gold',
    'إطار ذهبي.', 'A gold ring.', 450, 40, { requiredLevel: 4 }),
  style('FRAME', 'frame-diamond', 'diamond', 'LEGENDARY', 'ألماظ', 'Diamond',
    'إطار ألماسي.', 'A diamond ring.', 800, 50, { requiredLevel: 7 }),
  style('FRAME', 'frame-fire', 'fire', 'EPIC', 'نار', 'Blaze',
    'بيتفتح مع سلسلة ٣٠ يوم.', 'Unlocked by a thirty-day streak.', 0, 60,
    { requiredAchievement: 'streak_30' }),
  style('FRAME', 'frame-scholar', 'scholar', 'LEGENDARY', 'وسام', 'Laureate',
    'بيتفتح لما تخلّص ٥ دورات.', 'Unlocked by finishing five courses.', 0, 70,
    { requiredAchievement: 'courses_5' }),

  // ── Effects ───────────────────────────────────────────────────────────────
  style('EFFECT', 'effect-none', 'none', 'COMMON', 'بدون', 'None',
    'من غير تأثيرات.', 'No effect.', 0, 10, { isStarter: true }),
  style('EFFECT', 'effect-glow', 'glow', 'RARE', 'توهّج', 'Glow',
    'توهّج خفيف حوالين العناصر النشطة.', 'A soft glow on what is active.', 200, 20, { requiredLevel: 2 }),
];
