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
}

export interface StudioTheme {
  /** CSS custom property → "R G B". Only ever `--s-*`. */
  tokens: Record<string, string>;
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
export function deriveAccent(hex: string, mode: StudioMode): Record<string, string> {
  const ground = GROUND[mode];
  // Seated first: a colour that cannot be read on this ground is moved until it
  // can, rather than shipped and then apologised for.
  const accent = legible(hex, ground, 3);
  const onAccent = legible(relLuminance(accent) > 0.5 ? '#12121a' : '#ffffff', accent, ON_FILL_FLOOR);
  const hover = mode === 'dark' ? mix(accent, '#ffffff', 0.16) : mix(accent, '#000000', 0.14);
  const soft = mix(ground, accent, mode === 'dark' ? 0.22 : 0.12);
  const border = mix(ground, accent, mode === 'dark' ? 0.4 : 0.32);
  // The accent used as text rather than as a fill has a harder job.
  const ink = legible(accent, ground, TEXT_FLOOR);

  return {
    '--s-accent': triple(accent),
    '--s-accent-hover': triple(hover),
    '--s-accent-soft': triple(soft),
    '--s-accent-border': triple(border),
    '--s-accent-ink': triple(ink),
    '--s-on-accent': triple(onAccent),
  };
}

/** The accent a theme carries, per mode. */
export interface ThemeConfig {
  accent?: string;
  accentDark?: string;
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
  const styles: StudioStyles = {
    button: pick(input.button, BUTTON_STYLES, 'classic'),
    card: pick(input.card, CARD_STYLES, 'minimal'),
    nav: pick(input.nav, NAV_STYLES, 'classic'),
    frame: pickOrNull(input.frame, FRAME_STYLES),
    avatar: pickOrNull(input.avatar, AVATAR_STYLES),
    effect: pickOrNull(input.effect, EFFECT_STYLES),
  };

  // A colour the student picked beats the one their theme came with: it is the
  // more specific choice, and it is the one they made last.
  const chosen = safeHex(input.accentHex);
  const light = chosen ?? safeHex(input.themeConfig?.accent);
  const dark = chosen ?? safeHex(input.themeConfig?.accentDark) ?? light;

  return {
    light: { tokens: light ? deriveAccent(light, 'light') : {}, styles },
    dark: { tokens: dark ? deriveAccent(dark, 'dark') : {}, styles },
    styles,
  };
}

function pick<T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T[number])
    : fallback;
}

function pickOrNull<T extends readonly string[]>(value: unknown, allowed: T): T[number] | null {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) return null;
  return value === 'none' ? null : (value as T[number]);
}
