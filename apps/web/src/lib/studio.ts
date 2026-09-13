import { api } from './api';
import { resolveMode } from './colorMode';

/**
 * The student's own copy of Darsly.
 *
 * Its counterpart is `theme.ts`, which wears the academy's colours. The two
 * never collide because they write different namespaces: the academy owns
 * `--c-*`, which the whole product is built on, and a student can only ever
 * reach `--s-*`, which a handful of the student's own surfaces read. Every
 * `--s-*` token falls back to a `--c-*` one in the Tailwind config, so a
 * student who has customised nothing sees the academy exactly as before.
 *
 * Nothing here decides a colour. The server derives every variant and enforces
 * the contrast floors — the same arrangement the academy palette uses, for the
 * same reason. This module writes what it is given, after checking it looks
 * like what it is supposed to be.
 *
 * Preview is the one thing that is purely local: trying a theme on must not
 * write anything, so it swaps the tokens in memory and the next `restore()`
 * puts back whatever was equipped.
 */

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
  tokens: Record<string, string>;
  /** The platform accent family, restated in the student's colour. */
  brand: Record<string, string>;
  styles: StudioStyles;
}

export interface StudioThemes {
  light: StudioTheme;
  dark: StudioTheme;
  styles: StudioStyles;
}

const CACHE_KEY = 'darsly-studio';

/** What is equipped, as opposed to what is being tried on. */
let equipped: StudioThemes | null = null;

/**
 * Reject anything that is not a `--s-*` name and three numbers.
 *
 * These end up in a style attribute. A CSS variable is a small injection
 * surface but it is not none, and the prefix check is also what guarantees a
 * student's payload can never reach an academy's token.
 */
function clean(theme: unknown): StudioTheme | null {
  const t = theme as StudioTheme | null;
  if (!t || typeof t !== 'object') return null;
  const tokens: Record<string, string> = {};
  for (const [name, value] of Object.entries(t.tokens ?? {})) {
    if (/^--s-[a-z0-9-]+$/.test(name) && /^\d{1,3} \d{1,3} \d{1,3}$/.test(String(value))) {
      tokens[name] = String(value);
    }
  }
  return { tokens, brand: brandTokens(t.brand), styles: styles(t.styles) };
}

/**
 * The only `--c-*` names a student's choice may reach.
 *
 * An allowlist rather than a prefix check: `--c-*` is the namespace the whole
 * product is built on, and a student restating their accent must not be able to
 * reach the surfaces, the ink or the error colour through the same door.
 */
const BRAND_ALLOWED = new Set([
  '--c-primary', '--c-on-primary', '--c-primary-hover',
  '--c-primary-container', '--c-on-primary-container',
  '--c-primary-fixed', '--c-primary-fixed-dim',
  '--c-on-primary-fixed', '--c-on-primary-fixed-variant',
  '--c-inverse-primary', '--c-surface-tint',
  '--c-brand-accent', '--c-on-brand-accent',
  '--c-accent-50', '--c-accent-100', '--c-accent-200', '--c-accent-300',
  '--c-accent-400', '--c-accent-500', '--c-accent-600', '--c-accent-700',
  '--c-accent-800', '--c-accent-900',
]);

function brandTokens(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries((input ?? {}) as Record<string, string>)) {
    if (BRAND_ALLOWED.has(name) && /^\d{1,3} \d{1,3} \d{1,3}$/.test(String(value))) {
      out[name] = String(value);
    }
  }
  return out;
}

const BUTTONS = ['classic', 'rounded', 'pill', 'sharp', 'soft', 'elevated'];
const CARDS = ['minimal', 'soft', 'elevated', 'paper', 'glass'];
const NAVS = ['classic', 'compact', 'floating'];

/** A style is a name from a closed list, or the default. Never a value. */
function styles(input: unknown): StudioStyles {
  const s = (input ?? {}) as Partial<StudioStyles>;
  const pick = (v: unknown, allowed: string[], fallback: string) =>
    typeof v === 'string' && allowed.includes(v) ? v : fallback;
  return {
    button: pick(s.button, BUTTONS, 'classic'),
    card: pick(s.card, CARDS, 'minimal'),
    nav: pick(s.nav, NAVS, 'classic'),
    frame: typeof s.frame === 'string' && /^[a-z]+$/.test(s.frame) ? s.frame : null,
    avatar: typeof s.avatar === 'string' && /^[a-z]+$/.test(s.avatar) ? s.avatar : null,
    effect: typeof s.effect === 'string' && /^[a-z]+$/.test(s.effect) ? s.effect : null,
  };
}

/**
 * Repaint after the academy theme has written its own tokens.
 *
 * `applyTheme` clears every inline `--c-*` before writing the academy's, which
 * would take the student's brand tokens with it. Rather than couple the two
 * modules, the academy layer announces that it has painted and this listens.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('darsly:academy-theme', () => paint(equipped));
}

function pair(input: unknown): StudioThemes | null {
  const t = input as Partial<StudioThemes> | null;
  if (!t || typeof t !== 'object') return null;
  const light = clean(t.light);
  const dark = clean(t.dark);
  if (!light || !dark) return null;
  return { light, dark, styles: styles(t.styles ?? light.styles) };
}

/** Write one end of the pair onto the root element. */
function paint(themes: StudioThemes | null): void {
  const root = document.documentElement;
  for (const name of Array.from(root.style).filter((n) => n.startsWith('--s-'))) {
    root.style.removeProperty(name);
  }
  // Written by this module and removable by it. Clearing them hands the app
  // back to whatever the academy (or the platform) put there.
  for (const name of BRAND_ALLOWED) root.style.removeProperty(name);
  if (!themes) {
    for (const attr of ['button', 'card', 'nav', 'frame', 'avatar', 'effect']) {
      root.removeAttribute(`data-s-${attr}`);
    }
    return;
  }
  const side = themes[resolveMode()];
  for (const [name, value] of Object.entries(side.tokens)) {
    root.style.setProperty(name, value);
  }
  // This is what carries the choice out of the Studio: the logo tile, every
  // primary button and every active row on every screen.
  for (const [name, value] of Object.entries(side.brand ?? {})) {
    root.style.setProperty(name, value);
  }
  // Shape choices are attributes rather than variables: the stylesheet decides
  // what "pill" means, so a style name can never become a length or a colour.
  const s = themes.styles;
  root.setAttribute('data-s-button', s.button);
  root.setAttribute('data-s-card', s.card);
  root.setAttribute('data-s-nav', s.nav);
  for (const [attr, value] of [['frame', s.frame], ['avatar', s.avatar], ['effect', s.effect]] as const) {
    if (value) root.setAttribute(`data-s-${attr}`, value);
    else root.removeAttribute(`data-s-${attr}`);
  }
}

/** Apply and remember what the student has equipped. */
export function applyStudio(input: unknown): void {
  const themes = pair(input);
  equipped = themes;
  paint(themes);
  try {
    if (themes) localStorage.setItem(CACHE_KEY, JSON.stringify(themes));
    else localStorage.removeItem(CACHE_KEY);
  } catch {
    // A full or blocked storage costs the next load its head start, nothing more.
  }
}

/**
 * Try something on, without buying it and without saving it.
 *
 * Deliberately not a server call: previewing must not be able to change
 * anything, which is easiest to guarantee when there is nothing to change.
 */
export function previewStudio(input: unknown): void {
  const themes = pair(input);
  if (themes) paint(themes);
}

/** Put back whatever was equipped before the preview started. */
export function restoreStudio(): void {
  paint(equipped);
}

/** Repaint for the other end of the palette when the reader flips the switch. */
export function repaintStudioForMode(): void {
  paint(equipped);
}

/**
 * Replay the cached personalisation before React mounts.
 *
 * Same reasoning as the academy theme: by the time a query has resolved, the
 * un-personalised version is already on screen and the correction reads as a
 * flash.
 */
export function bootStudio(): void {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const themes = pair(JSON.parse(raw));
    equipped = themes;
    paint(themes);
  } catch {
    localStorage.removeItem(CACHE_KEY);
  }
}

/** Fetch and apply what this student is wearing. */
export async function loadStudio(): Promise<void> {
  const { data } = await api.get('/student/studio/theme');
  applyStudio(data?.theme ?? null);
}

/** Forget it entirely — on sign-out, so the next account starts clean. */
export function clearStudio(): void {
  equipped = null;
  paint(null);
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* nothing to clear */
  }
}
