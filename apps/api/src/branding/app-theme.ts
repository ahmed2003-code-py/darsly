import { contrastRatio, isHex, mix, relLuminance } from '../academy-site/renderer/color.util';

/**
 * Turn the palette a teacher published into the colour tokens the console runs on.
 *
 * Publishing is the moment a teacher says "this is my academy", so from then on
 * the app they work in should look like the academy they built rather than like
 * the platform. The site and the app are not the same problem, though. A page
 * needs six colours and can afford a bold one; a console needs about thirty
 * roles and has to stay readable for hours — buttons, chips, hairlines, muted
 * labels, disabled states, error text.
 *
 * So nothing is copied across. Every role is *derived* from the six, and every
 * derivation that carries text is held to a contrast floor. A palette that is
 * beautiful on a landing page and unreadable in a table is the failure this
 * guards against: the teacher chose a look, not an accessibility waiver.
 *
 * Two rules do most of the work, and both are mode-agnostic on purpose:
 *
 *   - panels step from the background *toward the ink*. On a light palette that
 *     darkens them; on a dark one it lightens them. One rule, both worlds, and
 *     no branch that can be right in light and wrong in dark.
 *   - anything carrying text is pushed until it clears its floor, in whichever
 *     direction has room.
 *
 * Pure and total: any input produces a usable theme. The palette arrives as
 * model-authored JSON out of the database, so every field is treated as
 * untrusted and falls back rather than throwing.
 */

/** Contrast floors, in WCAG ratio. Body text is held above the AA minimum. */
const FLOOR = {
  /** Long-form reading: the console is used for hours, so AAA rather than AA. */
  body: 7,
  /** Labels, captions, secondary text. */
  muted: 4.5,
  /** Text on a filled button or chip. */
  onFill: 4.5,
  /** Borders and icons carry no words, so the non-text minimum applies. */
  nonText: 3,
} as const;

/** The platform's own values — the fallback whenever a field is unusable. */
const PLATFORM = {
  background: '#F7F7F4',
  ink: '#1B1B22',
  surface: '#F7F7F4',
  primary: '#4A32C9',
  accent: '#4A32C9',
  error: '#BB3B2E',
} as const;

export interface BrandPalette {
  background?: string;
  ink?: string;
  surface?: string;
  surfaceAlt?: string;
  primary?: string;
  accent?: string;
  mode?: string;
}

export interface AppTheme {
  /** Measured from the background, never taken on trust. */
  mode: 'light' | 'dark';
  /** CSS custom properties: name → "R G B", ready to set on the root element. */
  tokens: Record<string, string>;
}

// ── colour helpers ────────────────────────────────────────────────────────────

const hex = (value: unknown, fallback: string): string =>
  typeof value === 'string' && isHex(value) ? value : fallback;

/**
 * Push `fg` away from `bg` until it clears `target`.
 *
 * Both directions are tried and the first pass wins, because guessing the
 * direction from the background's luminance is wrong in the middle of the range:
 * against a mid-tone red neither white nor black clears 4.5 by much, and the one
 * that does is not always the one a threshold would have picked.
 */
function legible(fg: string, bg: string, target: number): string {
  if (contrastRatio(fg, bg) >= target) return fg;
  let best = fg;
  let bestRatio = contrastRatio(fg, bg);
  // 20 steps of 5% reaches each pole exactly.
  for (let i = 1; i <= 20; i++) {
    for (const pole of ['#000000', '#ffffff']) {
      const out = mix(fg, pole, i / 20);
      const r = contrastRatio(out, bg);
      if (r >= target) return out;
      if (r > bestRatio) [best, bestRatio] = [out, r];
    }
  }
  // Unreachable targets settle on the most legible colour available rather than
  // failing — `seat()` below is what stops a background making them unreachable.
  return best;
}

/**
 * Move a background far enough from mid-tone that readable body text exists.
 *
 * Against a mid grey the best possible contrast is under 5:1 — no ink, of any
 * colour, makes a dense table comfortable on it. Every other repair here adjusts
 * the foreground, but this one cannot: the background is the constraint. It is
 * pushed toward the pole its own mode implies, so a dark palette stays dark and
 * a light one stays light; only the extremity changes.
 */
function seat(bg: string, mode: 'light' | 'dark'): string {
  const reachable = (c: string) => Math.max(contrastRatio(c, '#000000'), contrastRatio(c, '#ffffff'));
  if (reachable(bg) >= FLOOR.body) return bg;
  const pole = mode === 'dark' ? '#000000' : '#ffffff';
  for (let i = 1; i <= 20; i++) {
    const out = mix(bg, pole, i / 20);
    if (reachable(out) >= FLOOR.body) return out;
  }
  return pole;
}

/** "#4A32C9" → "74 50 201", the form `rgb(var(--x) / <alpha>)` expects. */
const triple = (h: string): string =>
  h.replace('#', '').match(/../g)!.map((p) => parseInt(p, 16)).join(' ');

/** Hue in degrees, 0–360. Only the angle is needed, so saturation is ignored. */
function hue(h: string): number {
  const [r, g, b] = h.replace('#', '').match(/../g)!.map((p) => parseInt(p, 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const deg =
    max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (deg * 60 + 360) % 360;
}

/** The shorter way round the colour wheel between two hues. */
function hueGap(a: string, b: string): number {
  const d = Math.abs(hue(a) - hue(b)) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Keep danger distinguishable from the brand.
 *
 * An academy whose primary is a red or a terracotta ends up with "Delete" and
 * "Publish" the same colour, which is the one colour confusion in a console that
 * costs a teacher real work. When the two are too close on the wheel, the error
 * is pushed toward crimson and darkened, so danger still reads as danger while
 * clearly not being the brand.
 */
function separateFromBrand(error: string, primary: string, background: string): string {
  if (hueGap(error, primary) >= 30) return error;
  // Crimson is far enough from every warm brand to read as a different thing,
  // and near enough to red to still read as a warning.
  const crimson = relLuminance(background) < 0.35 ? '#FF6B7A' : '#8C1D2E';
  return legible(crimson, background, FLOOR.muted);
}

// ── the derivation ────────────────────────────────────────────────────────────

export function deriveAppTheme(input: BrandPalette | null | undefined): AppTheme {
  const p = input ?? {};
  const primary = hex(p.primary, PLATFORM.primary);
  const accent = hex(p.accent, primary);

  // The palette carries a `mode`, but it records what the model believed it was
  // building. Measuring the background instead means a palette mislabelled
  // "light" cannot hand the console dark text on a dark page.
  const raw = hex(p.background, PLATFORM.background);
  const mode: 'light' | 'dark' = relLuminance(raw) < 0.35 ? 'dark' : 'light';
  const background = seat(raw, mode);

  // Ink drives every reading surface, so it is the one value held to AAA.
  const ink = legible(hex(p.ink, mode === 'dark' ? '#EDEDF2' : PLATFORM.ink), background, FLOOR.body);

  /** A panel `w` of the way from the background toward the ink. */
  const panel = (w: number) => mix(background, ink, w);
  /** A panel `w` of the way from the background *away* from the ink. */
  const raised = (w: number) => mix(background, relLuminance(ink) > 0.5 ? '#000000' : '#ffffff', w);
  /** The background stained with the brand — chips, active rows, tinted fills. */
  const tint = (w: number) => mix(background, primary, w);

  // A published palette may name its own card colour. It is only honoured when
  // it actually separates from the background; a surface equal to the page is a
  // card with no edges, which is the most common way these palettes arrive.
  const named = hex(p.surface, '');
  const step = mode === 'dark' ? 0.07 : 0.055;
  const surfaceContainer =
    named && contrastRatio(named, background) >= 1.04 ? named : panel(step);
  const namedAlt = hex(p.surfaceAlt, '');
  const surfaceAlt =
    namedAlt && contrastRatio(namedAlt, background) >= 1.04 ? namedAlt : panel(step * 1.5);

  const onPrimary = legible(
    relLuminance(primary) > 0.5 ? ink : '#ffffff',
    primary,
    FLOOR.onFill,
  );
  const onAccent = legible(relLuminance(accent) > 0.5 ? ink : '#ffffff', accent, FLOOR.onFill);

  // Error keeps the platform's red so danger still reads as danger, but it is
  // re-seated against this background — the light-mode red disappears on a dark
  // page, and a warning nobody can read is worse than no warning.
  const error = separateFromBrand(
    legible(PLATFORM.error, background, FLOOR.muted),
    primary,
    background,
  );
  const errorContainer = mix(background, error, mode === 'dark' ? 0.22 : 0.14);

  const chip = tint(mode === 'dark' ? 0.18 : 0.1);
  const neutral = mix(ink, background, 0.22);

  const t: Record<string, string> = {
    // ── the brand ramp ────────────────────────────────────────────────────────
    // 600 is the primary action, matching the platform scale, so every existing
    // `accent-600` / `hover:bg-accent-700` keeps meaning what it meant.
    'accent-50': mix(primary, '#ffffff', 0.93),
    'accent-100': mix(primary, '#ffffff', 0.85),
    'accent-200': mix(primary, '#ffffff', 0.7),
    'accent-300': mix(primary, '#ffffff', 0.53),
    'accent-400': mix(primary, '#ffffff', 0.34),
    'accent-500': mix(primary, '#ffffff', 0.15),
    'accent-600': primary,
    'accent-700': mix(primary, '#000000', 0.22),
    'accent-800': mix(primary, '#000000', 0.4),
    'accent-900': mix(primary, '#000000', 0.56),

    primary,
    'on-primary': onPrimary,
    'primary-container': mix(primary, '#ffffff', mode === 'dark' ? 0.1 : 0.15),
    'on-primary-container': onPrimary,
    // The hover partner for a primary button. On a dark palette a darker hover
    // vanishes into the page, so it brightens instead.
    'primary-hover': mode === 'dark' ? mix(primary, '#ffffff', 0.16) : mix(primary, '#000000', 0.22),
    'inverse-primary': mix(primary, '#ffffff', 0.53),

    'primary-fixed': chip,
    'primary-fixed-dim': tint(mode === 'dark' ? 0.28 : 0.18),
    'on-primary-fixed': legible(primary, chip, FLOOR.muted),
    'on-primary-fixed-variant': legible(primary, chip, FLOOR.muted),

    // Secondary is a neutral role, not a second brand colour — the design system
    // allows exactly one accent, and importing a palette must not smuggle in two.
    secondary: neutral,
    'on-secondary': legible('#ffffff', neutral, FLOOR.onFill),
    'secondary-container': chip,
    'on-secondary-container': legible(primary, chip, FLOOR.muted),
    'secondary-fixed': chip,
    'secondary-fixed-dim': tint(mode === 'dark' ? 0.28 : 0.18),
    'on-secondary-fixed': legible(primary, chip, FLOOR.muted),
    'on-secondary-fixed-variant': legible(primary, chip, FLOOR.muted),

    tertiary: mix(ink, background, 0.28),
    'on-tertiary': legible('#ffffff', mix(ink, background, 0.28), FLOOR.onFill),
    'tertiary-container': panel(step * 1.5),
    'on-tertiary-container': legible(ink, panel(step * 1.5), FLOOR.muted),

    error,
    'on-error': legible('#ffffff', error, FLOOR.onFill),
    'error-container': errorContainer,
    'on-error-container': legible(error, errorContainer, FLOOR.muted),

    // ── surfaces ──────────────────────────────────────────────────────────────
    background,
    'on-background': ink,
    surface: background,
    'on-surface': ink,
    'surface-dim': panel(step),
    'surface-bright': raised(0.03),
    'surface-container-lowest': raised(0.03),
    'surface-container-low': panel(step * 0.55),
    'surface-container': surfaceContainer,
    'surface-container-high': surfaceAlt,
    'surface-container-highest': panel(step * 2),
    'surface-variant': surfaceContainer,
    'surface-tint': primary,
    'on-surface-variant': legible(mix(ink, background, 0.4), background, FLOOR.muted),
    'inverse-surface': mix(ink, background, 0.06),
    'inverse-on-surface': mix(background, ink, 0.04),

    outline: legible(mix(ink, background, 0.5), background, FLOOR.nonText),
    // Hairlines and shadows are drawn with an alpha of these, so they are stored
    // as solids. `line` follows the ink, which flips them light on a dark
    // palette; shadow stays black, because a shadow tinted with light ink glows.
    line: ink,
    shadow: mode === 'dark' ? '#000000' : ink,

    // The palette's second colour. Named `brand-accent` to keep it clear of the
    // `accent-*` ramp above, which is built from the primary. Nothing in the
    // console fills with it yet — the design system allows one accent — but it
    // is part of the identity the teacher published, so it travels with it.
    'brand-accent': accent,
    'on-brand-accent': onAccent,
  };

  const tokens: Record<string, string> = {};
  for (const [name, value] of Object.entries(t)) tokens[`--c-${name}`] = triple(value);
  return { mode, tokens };
}

/**
 * The palette carried on a published document, in either generation.
 *
 * v3 composes a full `designSpec.palette`; documents from before it have a
 * `design` block with three colours, and the brand pair lives on the theme
 * beside it. Both reduce to the same six inputs.
 */
export function paletteFromDocumentTheme(theme: unknown): BrandPalette | null {
  const th = theme as
    | {
        primary?: string;
        accent?: string;
        design?: Record<string, unknown>;
        designSpec?: { palette?: Record<string, unknown> };
      }
    | null
    | undefined;
  if (!th) return null;

  const spec = th.designSpec?.palette;
  if (spec) {
    return {
      background: spec.background as string,
      ink: spec.ink as string,
      surface: spec.surface as string,
      surfaceAlt: spec.surfaceAlt as string,
      primary: spec.primary as string,
      accent: spec.accent as string,
      mode: spec.mode as string,
    };
  }
  const legacy = th.design;
  if (legacy) {
    return {
      background: legacy.background as string,
      ink: legacy.ink as string,
      surface: legacy.surface as string,
      primary: th.primary,
      accent: th.accent,
    };
  }
  // No design system at all: the brand pair on its own still beats the platform
  // indigo, and the derivation supplies every surface around it.
  if (th.primary) return { primary: th.primary, accent: th.accent };
  return null;
}

/**
 * What a publish records on the academy.
 *
 * The stored blob keeps the flat fields the storefront already reads and adds
 * the palette beside them, so a v3 document — whose colour lives in
 * `designSpec.palette` and which used to persist nothing at all — finally
 * records the look it published.
 *
 * The palette is stored rather than the derived tokens: sharpening the
 * derivation should improve every academy at once, not only the ones that
 * publish again afterwards.
 */
export function brandTokensFromTheme(theme: unknown): Record<string, unknown> | null {
  const th = theme as
    | { design?: Record<string, unknown>; designSpec?: Record<string, unknown> }
    | null
    | undefined;
  const palette = paletteFromDocumentTheme(theme);
  if (!palette) return null;

  const spec = th?.designSpec as
    | { geometry?: { radius?: number }; rhythm?: { density?: string }; typography?: Record<string, unknown> }
    | undefined;
  const legacy = th?.design ?? {};

  return {
    ...legacy,
    // Kept flat for the storefront, which reads these directly. v3 carries the
    // same ideas under different names, so they are mapped rather than dropped.
    background: palette.background ?? legacy.background,
    ink: palette.ink ?? legacy.ink,
    surface: palette.surface ?? legacy.surface,
    ...(spec?.geometry?.radius != null ? { radius: spec.geometry.radius } : {}),
    ...(spec?.rhythm?.density ? { density: spec.rhythm.density } : {}),
    palette,
  };
}

/** The palette recorded on an academy, for deriving its console theme. */
export function paletteFromBrandTokens(
  brandTokens: unknown,
  colorPrimary?: string | null,
  colorAccent?: string | null,
): BrandPalette | null {
  const bt = brandTokens as { palette?: BrandPalette; background?: string; ink?: string; surface?: string } | null;
  if (bt?.palette) return bt.palette;
  if (bt?.background || bt?.ink || bt?.surface) {
    // Published before the palette was recorded: the three surface colours are
    // there, and the brand pair lives in its own columns.
    return {
      background: bt.background,
      ink: bt.ink,
      surface: bt.surface,
      primary: colorPrimary ?? undefined,
      accent: colorAccent ?? undefined,
    };
  }
  if (colorPrimary) return { primary: colorPrimary, accent: colorAccent ?? undefined };
  return null;
}
