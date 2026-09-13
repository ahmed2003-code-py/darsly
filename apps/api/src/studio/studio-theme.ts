import { contrastRatio, hexToRgb, mix, relLuminance } from '../academy-site/renderer/color.util';

/**
 * Turn what a student is wearing into the tokens their Darsly reads.
 *
 * This is the only place a student's colour is ever calculated, and it runs on
 * the server for the same reason the academy palette does: contrast floors are
 * a rule, not a suggestion, and a rule enforced in the browser is a rule the
 * browser can be asked to skip. The student sends a key or a hex; what comes
 * back is a fixed set of `--s-*` triples and a handful of shape names.
 *
 * `--s-*` is the whole of what a student can touch. The `--c-*` tokens the
 * product is built on — and that an academy's branding writes — are not
 * reachable from here, which is what lets a student personalise their Darsly
 * without ever repainting a teacher's academy.
 */

/** Secondary text and captions sit on this, so it holds the text floor. */
const TEXT_FLOOR = 4.5;
/** Text on a filled button. */
const ON_FILL_FLOOR = 4.5;

export type StudioMode = 'light' | 'dark';

export interface StudioStyles {
  button: string;
  card: string;
  nav: string;
  frame: string | null;
  avatar: string | null;
  effect: string | null;
  /** The backdrop the theme draws behind the page. */
  pattern: string | null;
  /** Ambient light behind everything. */
  glow: boolean;
  /** The typeface pairing and the corner sharpness the theme asks for. */
  font: string | null;
  radius: string | null;
}

export interface StudioTheme {
  /** CSS custom property → "R G B". Only ever `--s-*`. */
  tokens: Record<string, string>;
  /**
   * The platform's own accent family, restated in the student's colour.
   *
   * This is the part that makes it *their* Darsly rather than a tinted corner
   * of one: the logo tile, every primary button, every active state across the
   * whole app. A closed allowlist of `--c-*` names, all of them derived here
   * against the same contrast floors — a student still sends a colour, never a
   * token, and can still reach nothing outside this list.
   *
   * The published academy page is a different document rendered by the server
   * and never sees any of it, so a teacher's site stays a teacher's site.
   */
  brand: Record<string, string>;
  styles: StudioStyles;
}

export interface StudioThemes {
  light: StudioTheme;
  dark: StudioTheme;
  styles: StudioStyles;
}

/** What a slot may hold. Anything else is refused before it reaches a token. */
export const BUTTON_STYLES = ['classic', 'rounded', 'pill', 'sharp', 'soft', 'elevated'] as const;
export const CARD_STYLES = ['minimal', 'soft', 'elevated', 'paper', 'glass'] as const;
export const NAV_STYLES = ['classic', 'compact', 'floating'] as const;
export const FRAME_STYLES = [
  'none', 'bronze', 'silver', 'gold', 'diamond', 'fire', 'lightning', 'scholar', 'legendary',
] as const;
export const EFFECT_STYLES = ['none', 'glow', 'confetti'] as const;
/**
 * Backdrops, drawn entirely in CSS.
 *
 * No images and no files: a pattern is a name the stylesheet knows how to draw
 * with gradients. That keeps the page fast, keeps every theme the same weight,
 * and means a student's choice can never point the browser at somebody else's
 * artwork.
 */
export const PATTERNS = [
  'none', 'web', 'halftone', 'pitch', 'speed', 'grid', 'glow', 'rays', 'stadium',
] as const;

/**
 * Typeface pairings a theme may ask for.
 *
 * A name, never a URL and never a family string: the stylesheet decides what
 * each one is and the loader only ever fetches from the one list it knows. A
 * theme cannot point the browser at a font of its own.
 */
export const FONTS = ['default', 'display', 'tech', 'round'] as const;

/** How sharp the corners are, as a name. */
export const RADII = ['default', 'sharp', 'soft', 'round'] as const;
export const AVATAR_STYLES = [
  'initial', 'orbit', 'wave', 'grid', 'bloom', 'prism',
] as const;

const HEX = /^#[0-9a-fA-F]{6}$/;

/** A colour, or nothing — never a guess, and never something unparseable. */
export function safeHex(value: unknown): string | null {
  return typeof value === 'string' && HEX.test(value.trim()) ? value.trim().toLowerCase() : null;
}

function triple(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `${r} ${g} ${b}`;
}

/** Walk toward a pole until the pair clears `target`, the way the academy
 *  palette does. Unreachable targets settle on the best available. */
function legible(fg: string, bg: string, target: number): string {
  if (contrastRatio(fg, bg) >= target) return fg;
  let best = fg;
  let bestRatio = contrastRatio(fg, bg);
  for (let i = 1; i <= 20; i++) {
    for (const pole of ['#000000', '#ffffff']) {
      const out = mix(fg, pole, i / 20);
      const r = contrastRatio(out, bg);
      if (r >= target) return out;
      if (r > bestRatio) [best, bestRatio] = [out, r];
    }
  }
  return best;
}

/**
 * The page behind the student's accent, per mode. Not the academy's surface:
 * the floors have to hold on the platform's own light and dark grounds, which
 * is the worst case either way.
 */
const GROUND: Record<StudioMode, string> = { light: '#fdfdfb', dark: '#0e0e12' };

/**
 * One accent, seated for a mode, plus everything drawn from it.
 *
 * A student picks one colour. Hover, the soft fill behind a chip, the text that
 * goes on top — all of it follows, because asking somebody to choose six
 * colours that work together is asking them to do a designer's job.
 */
export function deriveAccent(
  hex: string,
  mode: StudioMode,
  on?: string | null,
  seat?: string | null,
): Record<string, string> {
  const ground = on ?? GROUND[mode];
  const floorOn = seat ?? ground;
  // Seated first: a colour that cannot be read on this ground is moved until it
  // can, rather than shipped and then apologised for.
  const accent = legible(hex, hardest(hex, [ground, floorOn]), 3);
  const onAccent = legible(relLuminance(accent) > 0.5 ? '#12121a' : '#ffffff', accent, ON_FILL_FLOOR);
  const hover = mode === 'dark' ? mix(accent, '#ffffff', 0.16) : mix(accent, '#000000', 0.14);
  const soft = mix(ground, accent, mode === 'dark' ? 0.22 : 0.12);
  const border = mix(ground, accent, mode === 'dark' ? 0.4 : 0.32);
  // The accent used as text rather than as a fill has a harder job.
  const ink = legible(accent, floorOn, TEXT_FLOOR);

  return {
    '--s-accent': triple(accent),
    '--s-accent-hover': triple(hover),
    '--s-accent-soft': triple(soft),
    '--s-accent-border': triple(border),
    '--s-accent-ink': triple(ink),
    '--s-on-accent': triple(onAccent),
  };
}

/**
 * The theme's second colour.
 *
 * Seated and floored exactly like the first: a scheme is two colours that both
 * work, not one that works and one that was picked to go with it.
 */
export function deriveSecondary(
  hex: string,
  mode: StudioMode,
  on?: string | null,
  seat?: string | null,
): Record<string, string> {
  const ground = on ?? GROUND[mode];
  const floorOn = seat ?? ground;
  const secondary = legible(hex, hardest(hex, [ground, floorOn]), 3);
  const onSecondary = legible(
    relLuminance(secondary) > 0.5 ? '#12121a' : '#ffffff',
    secondary,
    ON_FILL_FLOOR,
  );
  return {
    '--s-secondary': triple(secondary),
    '--s-on-secondary': triple(onSecondary),
    '--s-secondary-soft': triple(mix(ground, secondary, mode === 'dark' ? 0.22 : 0.12)),
    '--s-secondary-ink': triple(legible(secondary, floorOn, TEXT_FLOOR)),
  };
}

/**
 * Gold, meaning premium.
 *
 * Not a third accent: a semantic. XP, coins, trophies, rank, rewards and
 * anything that marks an achievement read from this, so "this was earned" has
 * one colour across the whole app rather than an amber hard-coded into each
 * component that happened to need one.
 */
export function deriveGold(
  hex: string,
  mode: StudioMode,
  ground: string,
  seat?: string | null,
): Record<string, string> {
  const floorOn = seat ?? ground;
  const gold = legible(hex, hardest(hex, [ground, floorOn]), 3);
  const onGold = legible(relLuminance(gold) > 0.5 ? '#12121a' : '#ffffff', gold, ON_FILL_FLOOR);
  return {
    '--s-gold': triple(gold),
    '--s-on-gold': triple(onGold),
    '--s-gold-soft': triple(mix(ground, gold, mode === 'dark' ? 0.2 : 0.12)),
    '--s-gold-ink': triple(legible(gold, floorOn, TEXT_FLOOR)),
  };
}

/**
 * The page a theme is read on.
 *
 * A theme that only changes buttons is a colour swap; changing the ground under
 * everything is what makes it feel like a different place. Mixed at a low
 * weight against the platform ground so text contrast is untouched — the wash
 * is a tint, not a new background, and nothing has to be re-seated because of it.
 */
export function deriveWash(hex: string, mode: StudioMode, on?: string | null): Record<string, string> {
  const ground = on ?? GROUND[mode];
  const w = mode === 'dark' ? 0.14 : 0.07;
  return {
    '--s-wash': triple(mix(ground, hex, w)),
    '--s-wash-strong': triple(mix(ground, hex, w * 2)),
  };
}

/**
 * Everything a theme decides.
 *
 * One pick, one look. Choosing between six button shapes and five card shapes
 * is a designer's job, not a student's — so a theme brings its own, and the
 * separate slots stay only for anyone who wants to argue with it.
 */
export interface ThemeConfig {
  accent?: string;
  accentDark?: string;
  /** The second colour. A look with one colour is a tint; two make it a scheme —
   *  the accent carries the action, this carries the supporting chips and rails. */
  secondary?: string;
  secondaryDark?: string;
  /** A second colour the page is washed with, behind everything else. Kept
   *  faint on purpose: a background is a mood, not a poster. */
  wash?: string;
  washDark?: string;
  /** The pattern drawn over that wash. A name the stylesheet knows, never art. */
  pattern?: string;
  /** What "earned" looks like: XP, coins, trophies, rank. A semantic, not a
   *  third accent. Named for each ground the way the accent is: a gold bright
   *  enough to glow at night goes brown on paper, and a gold that reads on
   *  paper is invisible against navy. */
  gold?: string;
  goldDark?: string;
  /** Ambient light behind the page — two soft orbs in the theme's own colours. */
  glow?: boolean;
  /** A typeface pairing, by name. The stylesheet owns what each name means and
   *  the browser only ever fetches one it was asked for. */
  font?: string;
  /** How sharp the corners are. A look is as much a shape as a colour. */
  radius?: string;
  button?: string;
  card?: string;
  nav?: string;
  /**
   * A whole ground of its own.
   *
   * The difference between a tint and a skin. Without this a theme is the
   * platform's greys wearing a different accent — which is exactly the "it just
   * looks red" failure. With it, the theme owns the page, the panels and the
   * ink, and the app becomes somewhere else.
   *
   * Every value is still derived and floored on the server, and every name it
   * produces is in the client's allowlist. Removing the theme puts the academy
   * back exactly, because the client only ever clears what it wrote.
   */
  surfaces?: SurfaceConfig;
  /**
   * The same skin, for a reader who prefers light.
   *
   * Not a concession and not a second theme: the identity is the accent, the
   * gold, the pattern and the typeface, and all four carry across. Only the
   * ground changes — a night match becomes an afternoon one. Left unset, a skin
   * keeps its one ground at both ends, which is the right answer for a look
   * that only makes sense in the dark.
   */
  surfacesLight?: SurfaceConfig;
}

/** The six colours a skin needs to own a page. */
export interface SurfaceConfig {
  /** The page itself. */
  background?: string;
  /** The panels that sit on it. */
  surface?: string;
  /** Body text. */
  ink?: string;
  /** The accent the hairlines are drawn from. */
  line?: string;
}

/**
 * Everything the student is wearing, resolved.
 *
 * Both modes are derived together for the same reason the academy's are: the
 * light/dark switch is a tap, and a tap should not be a round trip.
 */
export function deriveStudioThemes(input: {
  themeConfig?: ThemeConfig | null;
  accentHex?: string | null;
  button?: string | null;
  card?: string | null;
  nav?: string | null;
  frame?: string | null;
  avatar?: string | null;
  effect?: string | null;
}): StudioThemes {
  // The theme sets the shape of things; an explicitly equipped slot overrides
  // it. Most students will never touch the slots, and should not have to.
  const theme = input.themeConfig ?? {};
  const styles: StudioStyles = {
    button: pick(input.button ?? theme.button, BUTTON_STYLES, 'classic'),
    card: pick(input.card ?? theme.card, CARD_STYLES, 'minimal'),
    nav: pick(input.nav ?? theme.nav, NAV_STYLES, 'classic'),
    frame: pickOrNull(input.frame, FRAME_STYLES),
    avatar: pickOrNull(input.avatar, AVATAR_STYLES),
    effect: pickOrNull(input.effect, EFFECT_STYLES),
    pattern: pickOrNull(theme.pattern, PATTERNS),
    glow: theme.glow === true,
    font: pickOrNull(theme.font, FONTS),
    radius: pickOrNull(theme.radius, RADII),
  };

  // A colour the student picked beats the one their theme came with: it is the
  // more specific choice, and it is the one they made last.
  const chosen = safeHex(input.accentHex);
  const light = chosen ?? safeHex(input.themeConfig?.accent);
  const dark = chosen ?? safeHex(input.themeConfig?.accentDark) ?? light;
  // A colour the student mixed replaces the theme's accent but not its partner:
  // the scheme keeps its shape, in their colour.
  const secLight = safeHex(input.themeConfig?.secondary);
  const secDark = safeHex(input.themeConfig?.secondaryDark) ?? secLight;

  const washLight = safeHex(input.themeConfig?.wash);
  const washDark = safeHex(input.themeConfig?.washDark) ?? washLight;
  // A skin that brings its own ground owns both ends: it is a skin, not a
  // palette, and it looks the same whichever mode the reader prefers.
  const goldLight = safeHex(input.themeConfig?.gold);
  const goldDark = safeHex(input.themeConfig?.goldDark) ?? goldLight;

  /**
   * One end of the pair, ground and all.
   *
   * Each side is seated against the page it will actually be read on. Without
   * that, a skin laying down near-black navy still had its gold and its red
   * measured against the platform's ground — which is how you ship a label that
   * misses its floor on the only background it is ever drawn on. And the mode
   * follows the ground rather than the reader's setting, so a paper ground gets
   * light-mode seating even when the switch says dark.
   */
  const side = (
    cfg: SurfaceConfig | undefined,
    accentHex: string | null,
    washHex: string | null,
    secHex: string | null,
    goldHex: string | null,
    fallbackMode: StudioMode,
  ) => {
    const surfaces = cfg ? deriveSurfaces(cfg) : null;
    const ground = cfg ? surfaceGround(cfg) : null;
    const seat = cfg ? surfaceSeat(cfg) : null;
    const mode = ground ? groundMode(ground) : fallbackMode;
    return {
      tokens: accentHex
        ? {
            ...deriveAccent(accentHex, mode, ground, seat),
            ...(washHex ? deriveWash(washHex, mode, ground) : {}),
            ...(secHex ? deriveSecondary(secHex, mode, ground, seat) : {}),
            ...(goldHex ? deriveGold(goldHex, mode, ground ?? GROUND[fallbackMode], seat) : {}),
          }
        : {},
      brand: accentHex
        ? { ...deriveBrand(accentHex, mode, ground, seat), ...(surfaces ?? {}) }
        : (surfaces ?? {}),
      styles,
    };
  };

  // A skin with one ground wears it at both ends — the right answer for a look
  // that only makes sense in the dark. One that brings a second wears that.
  const darkCfg = input.themeConfig?.surfaces;
  const lightCfg = input.themeConfig?.surfacesLight ?? darkCfg;

  return {
    light: side(lightCfg, light, washLight, secLight, goldLight, 'light'),
    dark: side(darkCfg, dark, washDark, secDark, goldDark, 'dark'),
    styles,
  };
}

/**
 * The platform accent family, in the student's colour.
 *
 * Every name here is one the product already uses, so restating them is what
 * carries a choice from the Studio out to the logo, the buttons and the active
 * rows on every screen. The floors are the same ones `app-theme.ts` holds the
 * academy palette to: text on a filled button clears 4.5:1, and the ramp is
 * mixed rather than invented.
 */
export function deriveBrand(
  hex: string,
  mode: StudioMode,
  on?: string | null,
  seat?: string | null,
): Record<string, string> {
  const ground = on ?? GROUND[mode];
  const floorOn = seat ?? ground;
  const primary = legible(hex, hardest(hex, [ground, floorOn]), 3);
  const onPrimary = legible(relLuminance(primary) > 0.5 ? '#12121a' : '#ffffff', primary, ON_FILL_FLOOR);
  // Dark brightens on hover and light darkens: a darker hover on a dark page
  // disappears into it.
  const hover = mode === 'dark' ? mix(primary, '#ffffff', 0.16) : mix(primary, '#000000', 0.14);
  const fixed = mix(ground, primary, mode === 'dark' ? 0.2 : 0.12);
  const container = mix(ground, primary, mode === 'dark' ? 0.28 : 0.18);
  const onFixed = legible(primary, fixed, TEXT_FLOOR);

  return {
    '--c-primary': triple(primary),
    '--c-on-primary': triple(onPrimary),
    // The same colour, told it has to be read.
    //
    // A fill and a label have different jobs and different floors. Holding one
    // colour to both is how a crimson button becomes salmon: pushed to 4.5:1
    // against a near-black ground, #dc2626 walks all the way to #ea7d7d and the
    // skin stops being Egyptian red. So the fill keeps the colour at 3:1 and
    // `text-primary` reads this instead, which is the same hue moved only as
    // far as legibility actually requires. On the platform's own grounds the
    // two land on the same value, because indigo on paper already cleared it.
    '--c-primary-text': triple(legible(primary, floorOn, TEXT_FLOOR)),
    '--c-primary-hover': triple(hover),
    '--c-primary-container': triple(container),
    '--c-on-primary-container': triple(onPrimary),
    '--c-primary-fixed': triple(fixed),
    '--c-primary-fixed-dim': triple(mix(ground, primary, mode === 'dark' ? 0.26 : 0.18)),
    '--c-on-primary-fixed': triple(onFixed),
    '--c-on-primary-fixed-variant': triple(onFixed),
    '--c-inverse-primary': triple(mix(primary, ground, 0.25)),
    '--c-surface-tint': triple(primary),
    '--c-brand-accent': triple(primary),
    '--c-on-brand-accent': triple(onPrimary),
    // The ramp buttons and rings are built from. 600 is the primary, matching
    // the platform scale, so every existing `accent-600` keeps its meaning.
    '--c-accent-50': triple(mix(primary, '#ffffff', 0.93)),
    '--c-accent-100': triple(mix(primary, '#ffffff', 0.85)),
    '--c-accent-200': triple(mix(primary, '#ffffff', 0.7)),
    '--c-accent-300': triple(mix(primary, '#ffffff', 0.53)),
    '--c-accent-400': triple(mix(primary, '#ffffff', 0.34)),
    '--c-accent-500': triple(mix(primary, '#ffffff', 0.15)),
    '--c-accent-600': triple(primary),
    '--c-accent-700': triple(mix(primary, '#000000', 0.22)),
    '--c-accent-800': triple(mix(primary, '#000000', 0.4)),
    '--c-accent-900': triple(mix(primary, '#000000', 0.56)),
  };
}

/**
 * A skin's own ground.
 *
 * Panels step from the background toward the ink, the same rule `app-theme.ts`
 * uses for an academy — one rule that is right in light and in dark, rather
 * than a branch that can be wrong in one of them. Every token carrying text is
 * pushed until it clears its floor, so a theme cannot ship an unreadable page
 * however dramatic its palette.
 */
export function surfaceGround(cfg: SurfaceConfig): string {
  return safeHex(cfg.background) ?? '#0a0e16';
}

/**
 * The hardest surface in a skin to read a colour on.
 *
 * Panels always step from the background toward the ink, so the deepest step is
 * the furthest from the background and the closest to a mid-tone — the worst
 * case for anything drawn on top. Seating against the page alone left brand
 * text at 4.43:1 on a card, which is a floor missed by a hair on the surface
 * most of the product's text actually lives on.
 */
/**
 * Whether a ground reads as light or dark.
 *
 * The seating rules — which way a hover moves, how far a soft fill is mixed —
 * follow the ground, not the reader's setting. A skin that lays down paper in
 * "dark mode" still needs light-mode seating, or its hovers vanish into it.
 */
/**
 * The surface a colour has the hardest time on.
 *
 * A skin has a range of surfaces, and which end is the hard one depends on the
 * colour: a bright gold struggles against the lightest panel, a dark one
 * against the deepest. Flooring against a fixed end therefore either leaves a
 * colour illegible or crushes it for no reason — old gold came out olive-brown
 * on a chalk ground because it was being held against a mid-grey it is never
 * drawn on. So the binding constraint is found rather than assumed.
 */
function hardest(fg: string, grounds: (string | null | undefined)[]): string {
  const real = grounds.filter((g): g is string => !!g);
  return real.reduce((worst, g) => (contrastRatio(fg, g) < contrastRatio(fg, worst) ? g : worst));
}

export function groundMode(hex: string): StudioMode {
  return relLuminance(hex) > 0.45 ? 'light' : 'dark';
}

export function surfaceSeat(cfg: SurfaceConfig): string {
  return mix(surfaceGround(cfg), safeHex(cfg.ink) ?? '#dfe2ee', 0.18);
}

export function deriveSurfaces(cfg: SurfaceConfig): Record<string, string> {
  const background = surfaceGround(cfg);
  const surface = safeHex(cfg.surface) ?? mix(background, '#ffffff', 0.05);
  const ink = safeHex(cfg.ink) ?? '#dfe2ee';
  const line = safeHex(cfg.line) ?? ink;

  // Toward the ink, so this works whichever end the skin sits at.
  const panel = (w: number) => mix(background, ink, w);
  const body = legible(ink, background, 7);
  // Floored against the deepest panel, not a middling one. Text is read on
  // cards more than on the page, and the deepest card is the worst case — on a
  // paper ground the mid-panel floor left muted text at 3.95:1 on it. This is
  // the same seat `surfaceSeat` hands the accent family, so the two agree.
  const worst = panel(0.18);
  const muted = legible(mix(ink, background, 0.34), worst, TEXT_FLOOR);
  const quiet = legible(mix(ink, background, 0.52), worst, TEXT_FLOOR);

  return {
    '--c-background': triple(background),
    '--c-on-background': triple(body),
    '--c-surface': triple(background),
    '--c-surface-dim': triple(mix(background, '#000000', 0.25)),
    '--c-surface-bright': triple(panel(0.16)),
    '--c-surface-container-lowest': triple(surface),
    '--c-surface-container-low': triple(panel(0.05)),
    '--c-surface-container': triple(panel(0.08)),
    '--c-surface-container-high': triple(panel(0.13)),
    '--c-surface-container-highest': triple(panel(0.18)),
    '--c-surface-variant': triple(panel(0.08)),
    '--c-on-surface': triple(body),
    '--c-on-surface-variant': triple(muted),
    '--c-outline': triple(quiet),
    '--c-line': triple(line),
    '--c-inverse-surface': triple(body),
    '--c-inverse-on-surface': triple(background),
    '--c-shadow': '0 0 0',
  };
}

/** The only `--c-*` names a student's choice may ever reach. */
export const BRAND_OVERRIDE_NAMES = [
  ...Object.keys(deriveBrand('#4a32c9', 'light')),
  ...Object.keys(deriveSurfaces({})),
];

function pick<T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T[number])
    : fallback;
}

function pickOrNull<T extends readonly string[]>(value: unknown, allowed: T): T[number] | null {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) return null;
  return value === 'none' ? null : (value as T[number]);
}
