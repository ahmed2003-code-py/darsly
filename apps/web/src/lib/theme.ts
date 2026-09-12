/**
 * Wear the academy's colours.
 *
 * When a teacher publishes their academy, the palette they approved becomes the
 * palette the console runs on. The API derives the full token set — that is
 * where the contrast floors are enforced and tested — so everything here is
 * deliberately dumb: write the variables onto the root element and let the
 * stylesheet do the rest. No colour decision is made in the browser.
 *
 * The last applied theme is cached, and `bootTheme()` replays it before React
 * mounts. Without that the app would paint in platform indigo, resolve
 * `/academies/mine`, and repaint — a flash of the wrong brand on every load.
 *
 * This module answers "whose colours", never "light or dark". The second
 * question belongs to the reader and lives in `colorMode.ts`.
 */

import { resolveMode } from './colorMode';

export interface AppTheme {
  mode: 'light' | 'dark';
  /** CSS custom property → "R G B". */
  tokens: Record<string, string>;
}

/**
 * The academy's colours at both ends, so switching costs nothing.
 *
 * Derived together on the server, where the contrast floors are enforced and
 * tested. Fetching the other one on a tap would make the switch a round trip
 * with a flash of the old palette in the middle.
 */
export interface AppThemes {
  light: AppTheme;
  dark: AppTheme;
}

const CACHE_KEY = 'darsly-theme';

/**
 * Accept either shape.
 *
 * A browser that cached the single-mode payload before this existed still has
 * it, and a stale cache must not be the reason someone's console loses its
 * colours on one load. It reads as the mode it was derived for.
 */
function pair(theme: unknown): AppThemes | null {
  const t = theme as Partial<AppThemes> & Partial<AppTheme>;
  if (!t || typeof t !== 'object') return null;
  const light = clean(t.light);
  const dark = clean(t.dark);
  if (light && dark) return { light, dark };
  const single = clean(theme);
  return single ? { light: single, dark: single } : null;
}

/** Guard against anything but a `--c-*` name and an "R G B" triple. */
function clean(theme: unknown): AppTheme | null {
  const t = theme as AppTheme | null;
  if (!t || typeof t !== 'object' || !t.tokens) return null;
  const tokens: Record<string, string> = {};
  for (const [name, value] of Object.entries(t.tokens)) {
    // These end up in a style attribute, so nothing that is not plainly a name
    // and three numbers is written — a CSS variable is a small injection
    // surface, but it is not none.
    if (/^--c-[a-z0-9-]+$/.test(name) && /^\d{1,3} \d{1,3} \d{1,3}$/.test(String(value))) {
      tokens[name] = String(value);
    }
  }
  if (!Object.keys(tokens).length) return null;
  return { mode: t.mode === 'dark' ? 'dark' : 'light', tokens };
}

/** The theme the server wrote into the document, when it knew which one to use. */
const serverTheme = () => document.getElementById('academy-theme');

/**
 * True when the server already decided this page's colours.
 *
 * Callers that would otherwise fall back to a remembered theme have to check
 * this first: inline properties beat a stylesheet, so replaying the cache over
 * a server-painted page paints the wrong academy.
 */
export function hasServerTheme(): boolean {
  return !!serverTheme();
}

/**
 * The last theme this browser wore, if any.
 *
 * Kept separate from `bootTheme` because it answers a different question. That
 * one asks "what should I paint before React mounts"; this one asks "what were
 * we wearing a moment ago" — which is what a screen that has just lost its
 * session needs in order not to change colour in the user's face.
 */
export function rememberedTheme(): AppThemes | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? pair(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/**
 * Repaint in the other end of the palette the app is already wearing.
 *
 * Called when the reader flips the switch. Without it, the mode attribute
 * changes and the academy's inline properties — which beat the stylesheet —
 * keep the old end on screen.
 */
export function repaintForMode(): void {
  const both = rememberedTheme();
  if (both) applyTheme(both);
}

/**
 * Paint the app in `theme`, or hand it back to the platform palette.
 *
 * The pair is cached whole and the half matching the reader's current mode is
 * written, so flipping the switch repaints from memory rather than from the
 * network.
 */
export function applyTheme(theme: unknown): void {
  const root = document.documentElement;
  const both = pair(theme);
  const next = both?.[resolveMode()] ?? null;

  if (!next) {
    // Remove rather than overwrite: the platform values live in the stylesheet's
    // own `:root`, so clearing the inline ones restores them exactly.
    for (const name of Array.from(root.style).filter((n) => n.startsWith('--c-'))) {
      root.style.removeProperty(name);
    }
    // The server's block is another `:root`, so clearing the inline properties
    // alone would fall back to the academy rather than to the platform.
    serverTheme()?.remove();
    localStorage.removeItem(CACHE_KEY);
    return;
  }

  for (const [name, value] of Object.entries(next.tokens)) {
    root.style.setProperty(name, value);
  }
  // `data-theme` is deliberately not written here. It says which end of the
  // palette the reader asked for, and that is theirs to decide — see
  // `colorMode.ts`. An academy that sets it too would take the switch away
  // from the person using it the moment their colours loaded.
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(both));
  } catch {
    // A full or blocked storage costs the next load its head start, nothing more.
  }
}

/**
 * Replay the cached theme synchronously, before the first paint.
 *
 * Called from the module top level rather than an effect: by the time React has
 * mounted and a query has resolved, the wrong colours are already on screen.
 *
 * Skipped entirely when the server has already answered. It knows which academy
 * this page load is about; the cache only knows which one the last one was. On a
 * visitor who opens a second teacher's link, replaying the cache would paint the
 * first teacher's colours *over* the correct ones — inline properties beat a
 * stylesheet — which is worse than the flash it exists to prevent.
 */
export function bootTheme(): void {
  if (serverTheme()) return;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) applyTheme(JSON.parse(raw));
  } catch {
    localStorage.removeItem(CACHE_KEY);
  }
}
