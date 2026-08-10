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
 */

export interface AppTheme {
  mode: 'light' | 'dark';
  /** CSS custom property → "R G B". */
  tokens: Record<string, string>;
}

const CACHE_KEY = 'darsly-theme';

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

/** Paint the app in `theme`, or hand it back to the platform palette. */
export function applyTheme(theme: unknown): void {
  const root = document.documentElement;
  const next = clean(theme);

  if (!next) {
    // Remove rather than overwrite: the platform values live in the stylesheet's
    // own `:root`, so clearing the inline ones restores them exactly.
    for (const name of Array.from(root.style).filter((n) => n.startsWith('--c-'))) {
      root.style.removeProperty(name);
    }
    root.removeAttribute('data-theme');
    localStorage.removeItem(CACHE_KEY);
    return;
  }

  for (const [name, value] of Object.entries(next.tokens)) {
    root.style.setProperty(name, value);
  }
  // Drives the few effects that are not a flat colour, and tells the browser to
  // render form controls and scrollbars to match.
  root.setAttribute('data-theme', next.mode);
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(next));
  } catch {
    // A full or blocked storage costs the next load its head start, nothing more.
  }
}

/**
 * Replay the cached theme synchronously, before the first paint.
 *
 * Called from the module top level rather than an effect: by the time React has
 * mounted and a query has resolved, the wrong colours are already on screen.
 */
export function bootTheme(): void {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) applyTheme(JSON.parse(raw));
  } catch {
    localStorage.removeItem(CACHE_KEY);
  }
}
