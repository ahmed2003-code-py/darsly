import {
  ADMIN_THEME_PRESETS,
  presetEntry,
  type AdminThemeEntry,
  type AdminThemeMode,
  type AdminThemeTokens,
} from '@darsly/shared-types';
import { resolveMode } from './colorMode';

/**
 * Darsly Platform Admin theme — separate from Student Cosmetics, Academy
 * Branding, and the Academy AI Website Studio (see lib/theme.ts for that
 * one). Deliberately NOT the same mechanism: theme.ts writes `--c-*` onto
 * `document.documentElement` and caches under `localStorage['darsly-theme']`
 * — reusing that directly for the admin would mean an admin and a teacher
 * sharing one browser could paint each other's colours on the next load
 * (inline root properties beat the stylesheet, and localStorage is
 * per-origin, not per-account). Instead: a distinct `--adm-*` namespace, a
 * distinct cache key, and a `[data-admin-theme]` attribute that gates a
 * small CSS remap (styles/admin-theme.css) redefining the app's own `--c-*`
 * tokens *underneath* that attribute — every existing Tailwind class the
 * shared shell and `components/ui.tsx` already use re-skins for free, with
 * zero effect on any session where the attribute is never set.
 *
 * What gets painted is always a look the API resolved — a preset, an
 * Academy's brand, a store theme — never colours composed here. The presets
 * themselves come from shared-types, the same table the API validates from.
 */

export type { AdminThemeEntry, AdminThemeTokens };

/** The platform's own look — what a SUPER_ADMIN wears before choosing. */
export const DEFAULT_ADMIN_THEME: AdminThemeEntry = presetEntry(ADMIN_THEME_PRESETS[0]);

function findAdminPreset(id: string | null | undefined): AdminThemeEntry | null {
  if (!id) return null;
  const bare = id.startsWith('preset:') ? id.slice('preset:'.length) : id;
  const preset = ADMIN_THEME_PRESETS.find((p) => p.id === bare);
  return preset ? presetEntry(preset) : null;
}

const CACHE_KEY = 'darsly-admin-theme';
const ATTR = 'data-admin-theme';

/** What is on screen, so flipping the colour mode can repaint the other end of
 *  it without another round trip. */
let current: AdminThemeLook | null = null;

/** A look as this module needs it: an id and both ends of the palette. */
type AdminThemeLook = Pick<AdminThemeEntry, 'id'> &
  Partial<Pick<AdminThemeEntry, 'tokens'>> &
  Partial<Pick<AdminThemeEntry, 'modes'>>;

/**
 * The half of `look` that belongs on screen right now.
 *
 * An entry from the current API carries both ends; one from a cache written
 * before it did carries only `tokens`, so that is the fallback rather than a
 * blank console.
 */
function tokensForMode(look: AdminThemeLook, mode: AdminThemeMode): AdminThemeTokens | null {
  return look.modes?.[mode] ?? look.tokens ?? null;
}

/** Paint the Admin Studio in `theme`. Writes only `--adm-*` variables and
 *  the gating attribute — never touches `--c-*` directly, so the remap
 *  block in admin-theme.css is the one and only place the two systems
 *  ever meet. */
export function applyAdminTheme(theme: AdminThemeLook, remember = true): void {
  const tokens = tokensForMode(theme, resolveMode());
  if (!tokens) return;
  current = theme;
  paint(tokens);
  if (!remember) return;
  try {
    // The resolved tokens travel with the id so a Center's or a store theme's
    // look — which only the API can resolve — replays before first paint too.
    // Both ends are cached, so the mode switch is a repaint from memory.
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ id: theme.id, tokens, modes: theme.modes ?? null }),
    );
  } catch {
    // A full or blocked storage costs the next load its head start, nothing more.
  }
}

/** The half of an entry that applying it would actually paint — so a card in the
 *  shelf shows the look at the end of the day the reader is sitting in. */
export function adminTokensForCurrentMode(entry: AdminThemeLook): AdminThemeTokens {
  return tokensForMode(entry, resolveMode()) ?? DEFAULT_ADMIN_THEME.tokens;
}

/**
 * Repaint the look already on screen at the other end of the palette.
 *
 * This is what makes the console's light/dark switch do anything at all for an
 * admin. `admin-theme.css` redefines the `--c-*` tokens under an attribute
 * specific enough to outrank `:root[data-theme='dark']` — deliberately, so a
 * chosen look is not half-overwritten by the platform's dark block — which also
 * meant flipping the switch changed the attribute and nothing else. The mode
 * picks which half of the admin look is written, the same way lib/theme.ts's
 * `repaintForMode` picks which half of an academy's palette is written.
 */
export function repaintAdminThemeForMode(): void {
  if (!current) return;
  const tokens = tokensForMode(current, resolveMode());
  if (tokens) paint(tokens);
}

function paint(tokens: AdminThemeTokens): void {
  const root = document.documentElement;
  // An academy palette cached by lib/theme.ts writes `--c-*` *inline*, and an
  // inline property beats any stylesheet whatever its specificity — so on a
  // browser that had ever worn an academy's colours the remap below would be
  // dead on arrival. The admin console is never an academy's storefront, so
  // the inline layer is cleared here; the stylesheet's own `:root` is the
  // floor the remap then sits on.
  for (const name of Array.from(root.style).filter((n) => n.startsWith('--c-'))) {
    root.style.removeProperty(name);
  }
  for (const [key, value] of Object.entries(tokens)) {
    root.style.setProperty(`--adm-${camelToKebab(key)}`, value);
  }
  root.setAttribute(ATTR, 'true');
}

/** Strips the admin look from the current page only — `--adm-*` properties
 *  and the gating attribute — without touching the saved preference. Safe
 *  to call for ANY non-admin render (a student or teacher on a browser that
 *  also has an admin account signed in elsewhere): it never destroys that
 *  other account's cached choice, since it doesn't touch storage. */
export function stripAdminThemeFromDom(): void {
  const root = document.documentElement;
  for (const name of Array.from(root.style).filter((n) => n.startsWith('--adm-'))) {
    root.style.removeProperty(name);
  }
  root.removeAttribute(ATTR);
  // Nothing is painted any more, so a later mode flip must not put it back.
  current = null;
}

/**
 * Replay the cached admin theme, synchronously, before first paint — same
 * technique lib/theme.ts's bootTheme() uses for the academy palette.
 * Gated on `role` so this is a no-op for every non-admin session even if a
 * stale cache entry happens to exist from a shared browser profile: the
 * gating attribute this function can set is the only thing the remap CSS
 * looks at, and it is never set here unless the caller has already
 * confirmed the signed-in user is SUPER_ADMIN.
 */
export function bootAdminTheme(isSuperAdmin: boolean): void {
  if (!isSuperAdmin) return;
  try {
    // No cache yet (first admin session on this browser) → the platform
    // default, not undecorated — a SUPER_ADMIN console must look distinct
    // from a teacher's from the very first paint, before useSyncAdminTheme's
    // server round-trip even lands.
    applyAdminTheme(readCache() ?? DEFAULT_ADMIN_THEME, false);
  } catch {
    // No storage reachable at all — falls back to whatever useSyncAdminTheme
    // applies once React mounts and the server round-trip resolves.
  }
}

/** The cached look, in the current `{id, tokens, modes}` form, the `{id, tokens}`
 *  form that predates light/dark pairs, or the oldest bare preset id. */
function readCache(): AdminThemeLook | null {
  const raw = localStorage.getItem(CACHE_KEY);
  if (!raw) return null;
  if (!raw.startsWith('{')) return findAdminPreset(raw);
  const parsed = JSON.parse(raw) as { id?: unknown; tokens?: unknown; modes?: unknown };
  if (typeof parsed.id !== 'string' || !isTokens(parsed.tokens)) return null;
  const modes = parsed.modes as Record<string, unknown> | null | undefined;
  const pair =
    modes && isTokens(modes.light) && isTokens(modes.dark)
      ? { light: modes.light, dark: modes.dark }
      : undefined;
  return { id: parsed.id, tokens: parsed.tokens, modes: pair };
}

/** Only ever paints "R G B" triples — a cache is still browser storage, and a stray string in it must not become a CSS value. */
function isTokens(v: unknown): v is AdminThemeTokens {
  if (!v || typeof v !== 'object') return false;
  const keys = Object.keys(DEFAULT_ADMIN_THEME.tokens);
  return keys.every((k) =>
    /^\d{1,3} \d{1,3} \d{1,3}$/.test(String((v as Record<string, unknown>)[k] ?? '')),
  );
}

function camelToKebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}
