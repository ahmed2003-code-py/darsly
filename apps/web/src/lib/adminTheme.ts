import { ADMIN_THEME_PRESETS, presetEntry, type AdminThemeEntry, type AdminThemeTokens } from '@darsly/shared-types';

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

/** Paint the Admin Studio in `theme`. Writes only `--adm-*` variables and
 *  the gating attribute — never touches `--c-*` directly, so the remap
 *  block in admin-theme.css is the one and only place the two systems
 *  ever meet. */
export function applyAdminTheme(theme: Pick<AdminThemeEntry, 'id' | 'tokens'>, remember = true): void {
  paint(theme.tokens);
  if (!remember) return;
  try {
    // The resolved tokens travel with the id so a Center's or a store theme's
    // look — which only the API can resolve — replays before first paint too.
    localStorage.setItem(CACHE_KEY, JSON.stringify({ id: theme.id, tokens: theme.tokens }));
  } catch {
    // A full or blocked storage costs the next load its head start, nothing more.
  }
}

function paint(tokens: AdminThemeTokens): void {
  const root = document.documentElement;
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

/** The cached look, in either the current `{id, tokens}` form or the older bare preset id. */
function readCache(): Pick<AdminThemeEntry, 'id' | 'tokens'> | null {
  const raw = localStorage.getItem(CACHE_KEY);
  if (!raw) return null;
  if (!raw.startsWith('{')) return findAdminPreset(raw);
  const parsed = JSON.parse(raw) as { id?: unknown; tokens?: unknown };
  if (typeof parsed.id !== 'string' || !isTokens(parsed.tokens)) return null;
  return { id: parsed.id, tokens: parsed.tokens };
}

/** Only ever paints "R G B" triples — a cache is still browser storage, and a stray string in it must not become a CSS value. */
function isTokens(v: unknown): v is AdminThemeTokens {
  if (!v || typeof v !== 'object') return false;
  const keys = Object.keys(DEFAULT_ADMIN_THEME.tokens);
  return keys.every((k) => /^\d{1,3} \d{1,3} \d{1,3}$/.test(String((v as Record<string, unknown>)[k] ?? '')));
}

function camelToKebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}
