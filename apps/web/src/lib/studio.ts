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

export interface LayoutStyles {
  nav: { desktop: string; tablet: string; mobile: string; labels: boolean; active: string };
  header: { variant: string; sticky: boolean };
  footer: string;
  density: string;
  width: string;
}

export interface StudioStyles {
  button: string;
  card: string;
  nav: string;
  frame: string | null;
  effect: string | null;
  /** The backdrop the theme draws behind the page. */
  pattern: string | null;
  glow: boolean;
  font: string | null;
  radius: string | null;
  /** The shape of the shell. Names only; the stylesheet and the shell decide
   *  what each one is. The default is the app exactly as it was before any
   *  theme could touch layout. */
  layout: LayoutStyles;
  motion: string;
  icons: { fill: 0 | 1; weight: number };
  cardLayout: string;
  typeScale: string;
}

/** What the app is when no theme has said otherwise. Mirrors the server's. */
export const DEFAULT_LAYOUT: LayoutStyles = {
  nav: { desktop: 'expanded', tablet: 'drawer', mobile: 'bottom', labels: true, active: 'bar' },
  header: { variant: 'standard', sticky: true },
  footer: 'none',
  density: 'comfortable',
  width: 'standard',
};

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
/**
 * Whose look the cached one is.
 *
 * Signing out is not the same moment as somebody else signing in, and the two
 * want opposite things. The person who just signed out is usually about to sign
 * back in, and repainting the screen out from under them — red to their
 * teacher's blue, mid-glance — is the one moment the app changes colour while
 * they are looking at it. A different account signing in is the moment that
 * genuinely must not inherit a stranger's colours.
 *
 * So the look is kept on sign-out and released on arrival, and this is how the
 * difference is told: the id it belongs to, remembered alongside it.
 */
const OWNER_KEY = 'darsly-studio-owner';

/** What is equipped, as opposed to what is being tried on. */
let equipped: StudioThemes | null = null;

/**
 * The brand names this module actually wrote, so it can take back its own and
 * nothing else.
 *
 * Removing the whole allowlist instead cost an academy its colours: the theme
 * layer writes `--c-primary` inline, this ran afterwards with nothing equipped,
 * and every teacher and student fell back to platform indigo. A layer may only
 * clear what it put there.
 */
let written: string[] = [];

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
  // The accent family.
  '--c-primary', '--c-primary-text', '--c-on-primary', '--c-primary-hover',
  '--c-primary-container', '--c-on-primary-container',
  '--c-primary-fixed', '--c-primary-fixed-dim',
  '--c-on-primary-fixed', '--c-on-primary-fixed-variant',
  '--c-inverse-primary', '--c-surface-tint',
  '--c-brand-accent', '--c-on-brand-accent',
  '--c-accent-50', '--c-accent-100', '--c-accent-200', '--c-accent-300',
  '--c-accent-400', '--c-accent-500', '--c-accent-600', '--c-accent-700',
  '--c-accent-800', '--c-accent-900',
  // The ground, for a skin that brings one. This is what separates a skin from
  // a tint: without it the platform's greys stay underneath and the result is
  // the same app in a different colour. Every value is derived and floored on
  // the server, and `written[]` means removing the skin puts the academy back
  // exactly as it was.
  '--c-background', '--c-on-background',
  '--c-surface', '--c-surface-dim', '--c-surface-bright',
  '--c-surface-container-lowest', '--c-surface-container-low',
  '--c-surface-container', '--c-surface-container-high',
  '--c-surface-container-highest', '--c-surface-variant',
  '--c-on-surface', '--c-on-surface-variant', '--c-outline', '--c-line',
  '--c-inverse-surface', '--c-inverse-on-surface', '--c-shadow',
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

/**
 * The typefaces a theme may ask for, and where each one comes from.
 *
 * A closed map, not a URL the server sends: a theme names a pairing and this
 * decides what to fetch. Nothing a student equips can point the browser at a
 * font of its own. Fetched on first use rather than up front, so the themes
 * nobody has equipped cost nothing.
 */
const FONTS: Record<string, string> = {
  display: 'Outfit:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700',
  tech: 'Space+Grotesk:wght@400;500;600;700&family=Chakra+Petch:wght@500;600;700',
  round: 'Baloo+Bhaijaan+2:wght@400;500;600;700;800',
};
const RADII = ['default', 'sharp', 'soft', 'round'];
const loadedFonts = new Set<string>();

/** Pull a pairing in once, the first time a theme wearing it is painted. */
function ensureFont(name: string | null): void {
  if (!name || !FONTS[name] || loadedFonts.has(name)) return;
  loadedFonts.add(name);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${FONTS[name]}&display=swap`;
  document.head.appendChild(link);
}

const BUTTONS = ['classic', 'rounded', 'pill', 'sharp', 'soft', 'elevated'];
const NAV_DESKTOP = ['expanded', 'rail', 'floating', 'minimal', 'glass', 'hidden'];
const NAV_TABLET = ['drawer', 'expanded', 'rail'];
const NAV_MOBILE = ['bottom', 'drawer'];
const NAV_ACTIVE = ['bar', 'pill', 'glow', 'underline'];
const HEADERS = ['standard', 'minimal', 'floating', 'glass', 'compact', 'centered', 'editorial'];
const FOOTERS = ['none', 'minimal', 'stats', 'bottomBar'];
const DENSITIES = ['comfortable', 'compact', 'spacious'];
const WIDTHS = ['standard', 'narrow', 'wide', 'full'];
const MOTIONS = ['subtle', 'still', 'expressive'];
const ICON_WEIGHTS = [300, 400, 500, 600];
const CARD_LAYOUTS = ['grid', 'imageFirst', 'editorial'];
const TYPE_SCALES = ['default', 'compact', 'editorial'];
const CARDS = ['minimal', 'soft', 'elevated', 'paper', 'glass'];
const NAVS = ['classic', 'compact', 'floating'];
const PATTERNS = [
  'none', 'web', 'halftone', 'pitch', 'speed', 'grid', 'glow', 'rays', 'stadium',
];

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
    effect: typeof s.effect === 'string' && /^[a-z]+$/.test(s.effect) ? s.effect : null,
    pattern: typeof s.pattern === 'string' && PATTERNS.includes(s.pattern) ? s.pattern : null,
    glow: s.glow === true,
    font: typeof s.font === 'string' && FONTS[s.font] ? s.font : null,
    radius: typeof s.radius === 'string' && RADII.includes(s.radius) ? s.radius : null,
    layout: layoutStyles(s.layout),
    motion: pick(s.motion, MOTIONS, 'subtle'),
    icons: {
      fill: s.icons?.fill === 0 ? 0 : 1,
      weight: typeof s.icons?.weight === 'number' && ICON_WEIGHTS.includes(s.icons.weight) ? s.icons.weight : 400,
    },
    cardLayout: pick(s.cardLayout, CARD_LAYOUTS, 'grid'),
    typeScale: pick(s.typeScale, TYPE_SCALES, 'default'),
  };
}

/** The shell's shape, from a closed list per field, or today's app. */
function layoutStyles(input: unknown): LayoutStyles {
  const l = (input ?? {}) as Partial<LayoutStyles>;
  const d = DEFAULT_LAYOUT;
  const pick = (v: unknown, allowed: string[], fallback: string) =>
    typeof v === 'string' && allowed.includes(v) ? v : fallback;
  return {
    nav: {
      desktop: pick(l.nav?.desktop, NAV_DESKTOP, d.nav.desktop),
      tablet: pick(l.nav?.tablet, NAV_TABLET, d.nav.tablet),
      mobile: pick(l.nav?.mobile, NAV_MOBILE, d.nav.mobile),
      labels: typeof l.nav?.labels === 'boolean' ? l.nav.labels : d.nav.labels,
      active: pick(l.nav?.active, NAV_ACTIVE, d.nav.active),
    },
    header: {
      variant: pick(l.header?.variant, HEADERS, d.header.variant),
      sticky: typeof l.header?.sticky === 'boolean' ? l.header.sticky : d.header.sticky,
    },
    footer: pick(l.footer, FOOTERS, d.footer),
    density: pick(l.density, DENSITIES, d.density),
    width: pick(l.width, WIDTHS, d.width),
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

/**
 * Pages a personal look has no business on.
 *
 * A teacher's published portfolio is their shopfront, not the student's app.
 * Somebody arriving at it — or a student browsing it — should see what the
 * teacher published, so the student layer stands down for as long as that page
 * is open and picks up again on the way out.
 */
let suspended = false;

export function setStudioSuspended(on: boolean): void {
  if (suspended === on) return;
  suspended = on;
  paint(equipped);
}

/** Write one end of the pair onto the root element. */
function paint(input: StudioThemes | null): void {
  const themes = suspended ? null : input;
  const root = document.documentElement;
  for (const name of Array.from(root.style).filter((n) => n.startsWith('--s-'))) {
    root.style.removeProperty(name);
  }
  // Only what this module wrote. The academy's own tokens share these names and
  // are not ours to remove.
  for (const name of written) root.style.removeProperty(name);
  written = [];
  if (!themes) {
    for (const attr of SHELL_ATTRS) root.removeAttribute(`data-s-${attr}`);
    return;
  }
  const side = themes[resolveMode()];
  for (const [name, value] of Object.entries(side.tokens)) {
    root.style.setProperty(name, value);
  }
  // This is what carries the choice out of the Studio: the logo tile, every
  // primary button and every active row on every screen. Recorded as it goes,
  // so the next paint takes back exactly this and leaves the academy's alone.
  for (const [name, value] of Object.entries(side.brand ?? {})) {
    root.style.setProperty(name, value);
    written.push(name);
  }
  // Shape choices are attributes rather than variables: the stylesheet decides
  // what "pill" means, so a style name can never become a length or a colour.
  const s = themes.styles;
  root.setAttribute('data-s-button', s.button);
  root.setAttribute('data-s-card', s.card);
  root.setAttribute('data-s-nav', s.nav);
  for (const [attr, value] of [
    ['frame', s.frame], ['effect', s.effect],
    ['pattern', s.pattern], ['font', s.font], ['radius', s.radius],
  ] as const) {
    if (value) root.setAttribute(`data-s-${attr}`, value);
    else root.removeAttribute(`data-s-${attr}`);
  }
  if (s.glow) root.setAttribute('data-s-glow', 'on');
  else root.removeAttribute('data-s-glow');
  // The shell. Written only when a theme moved something off the default, so
  // an untouched app carries no attribute and the base stylesheet applies —
  // which is also what makes "remove the theme" put everything back exactly.
  const l = s.layout;
  const shell: [string, string | null][] = [
    ['nav-desktop', l.nav.desktop === DEFAULT_LAYOUT.nav.desktop ? null : l.nav.desktop],
    ['nav-tablet', l.nav.tablet === DEFAULT_LAYOUT.nav.tablet ? null : l.nav.tablet],
    ['nav-mobile', l.nav.mobile === DEFAULT_LAYOUT.nav.mobile ? null : l.nav.mobile],
    ['nav-labels', l.nav.labels ? null : 'off'],
    ['nav-active', l.nav.active === DEFAULT_LAYOUT.nav.active ? null : l.nav.active],
    ['header', l.header.variant === DEFAULT_LAYOUT.header.variant ? null : l.header.variant],
    ['header-sticky', l.header.sticky ? null : 'off'],
    ['footer', l.footer === DEFAULT_LAYOUT.footer ? null : l.footer],
    ['density', l.density === DEFAULT_LAYOUT.density ? null : l.density],
    ['width', l.width === DEFAULT_LAYOUT.width ? null : l.width],
    ['motion', s.motion === 'subtle' ? null : s.motion],
    ['card-layout', s.cardLayout === 'grid' ? null : s.cardLayout],
    ['type', s.typeScale === 'default' ? null : s.typeScale],
  ];
  for (const [attr, value] of shell) {
    if (value) root.setAttribute(`data-s-${attr}`, value);
    else root.removeAttribute(`data-s-${attr}`);
  }
  // Material Symbols is a variable font; these two axes are what "icon style"
  // honestly means here. Both default to the app's own values.
  root.style.setProperty('--s-icon-fill', String(s.icons.fill));
  root.style.setProperty('--s-icon-wght', String(s.icons.weight));
  ensureFont(s.font);
}

/** Every attribute this module may write on the root, so a clear is a clear. */
const SHELL_ATTRS = [
  'button', 'card', 'nav', 'frame', 'effect', 'pattern', 'font', 'radius', 'glow',
  'nav-desktop', 'nav-tablet', 'nav-mobile', 'nav-labels', 'nav-active',
  'header', 'header-sticky', 'footer', 'density', 'width', 'motion', 'card-layout', 'type',
];

/**
 * The moment a skin goes on.
 *
 * One light crossing the screen and then gone. Appended and removed by this
 * module rather than rendered by a page, so putting a skin on feels the same
 * wherever it happens — and so no page has to know a skin was equipped.
 */
export function playActivation(): void {
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const el = document.createElement('div');
    el.className = 's-activation';
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
    window.setTimeout(() => el.remove(), 1200);
  } catch {
    // A celebration that cannot run is not a reason for anything to fail.
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

/**
 * The academy whose colours the student chose, if they chose one.
 *
 * Kept here rather than in the branding layer because it is a Studio decision;
 * `BrandTheme` reads it to know which of a student's teachers the app should
 * look like. Cached alongside the theme so it survives a reload.
 */
const ACADEMY_KEY = 'darsly-studio-academy';

export function chosenAcademy(): string | null {
  try {
    return localStorage.getItem(ACADEMY_KEY) || null;
  } catch {
    return null;
  }
}

export function rememberAcademy(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACADEMY_KEY, id);
    else localStorage.removeItem(ACADEMY_KEY);
  } catch {
    // Losing the preference costs a repaint on the next load, nothing more.
  }
  try {
    window.dispatchEvent(new CustomEvent('darsly:studio-academy'));
  } catch {
    /* no CustomEvent, no listener */
  }
}

function owner(): string | null {
  try {
    return localStorage.getItem(OWNER_KEY) || null;
  } catch {
    return null;
  }
}

/**
 * Somebody arrived. If it is not who the cached look belongs to, drop it before
 * their own is fetched, so a stranger's colours are never on screen while the
 * request is in flight.
 */
export function claimStudio(userId: string | null): void {
  if (!userId) return;
  if (owner() && owner() !== userId) clearStudio();
  try {
    localStorage.setItem(OWNER_KEY, userId);
  } catch {
    /* the worst case is one stale repaint on a device nobody shares */
  }
}

/** Fetch and apply what this student is wearing. */
export async function loadStudio(userId?: string | null): Promise<void> {
  claimStudio(userId ?? null);
  const { data } = await api.get('/student/studio/theme');
  applyStudio(data?.theme ?? null);
  rememberAcademy(typeof data?.equipped?.academyId === 'string' ? data.equipped.academyId : null);
}

/**
 * Sign-out keeps the look.
 *
 * The academy layer already works this way — it holds the last palette so the
 * sign-in screen does not flash — and the student layer clearing itself at the
 * same moment is what made a red app turn into its teacher's the instant
 * somebody signed out. It stays until a different account claims the device.
 */
export function releaseStudio(): void {
  // Nothing is repainted and nothing is dropped: only the claim is given up,
  // so the next arrival knows to check whose look this is.
}

/** Forget it entirely — a different account, or a reset. */
export function clearStudio(): void {
  equipped = null;
  paint(null);
  rememberAcademy(null);
  try {
    localStorage.removeItem(CACHE_KEY);
    localStorage.removeItem(OWNER_KEY);
  } catch {
    /* nothing to clear */
  }
}
