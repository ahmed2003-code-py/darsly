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
 * shared shell and `components/ui.tsx` already use (sidebar, topbar, cards,
 * buttons, badges, tables, modals, forms, charts, skeletons, empty states)
 * re-skins for free, with zero changes to those shared files, and zero
 * effect on any session where the attribute is never set (every
 * Student/Teacher session, and an admin session before a theme is chosen).
 */

export interface AdminThemeTokens {
  background: string;
  surface: string;
  surfaceElevated: string;
  text: string;
  textMuted: string;
  primary: string;
  secondary: string;
  accent: string;
  success: string;
  warning: string;
  danger: string;
  border: string;
  sidebar: string;
  topbar: string;
  chart1: string;
  chart2: string;
  chart3: string;
}

export interface AdminTheme {
  id: string;
  name: string;
  mode: 'light' | 'dark';
  tokens: AdminThemeTokens;
}

/** "R G B" triples — the same format lib/theme.ts already uses, so both
 *  systems read the same way in devtools and neither invents a second
 *  color-value convention. */
export const ADMIN_THEME_PRESETS: AdminTheme[] = [
  {
    id: 'darsly-dark',
    name: 'Darsly Dark',
    mode: 'dark',
    tokens: {
      background: '14 14 18', surface: '19 19 24', surfaceElevated: '26 26 32',
      text: '237 237 242', textMuted: '169 168 180',
      primary: '110 91 211', secondary: '201 200 210', accent: '156 143 226',
      success: '52 199 89', warning: '251 191 36', danger: '229 103 90',
      border: '46 46 56', sidebar: '14 14 18', topbar: '19 19 24',
      chart1: '110 91 211', chart2: '52 199 89', chart3: '251 191 36',
    },
  },
  {
    id: 'crimson-gold',
    name: 'Crimson Gold',
    mode: 'dark',
    tokens: {
      background: '17 12 12', surface: '24 17 17', surfaceElevated: '33 22 22',
      text: '245 236 230', textMuted: '186 160 150',
      primary: '196 55 55', secondary: '212 175 110', accent: '224 168 52',
      success: '87 168 96', warning: '224 168 52', danger: '212 60 50',
      border: '58 35 32', sidebar: '17 12 12', topbar: '24 17 17',
      chart1: '196 55 55', chart2: '224 168 52', chart3: '212 175 110',
    },
  },
  {
    id: 'emerald',
    name: 'Emerald',
    mode: 'dark',
    tokens: {
      background: '9 20 17', surface: '13 27 23', surfaceElevated: '18 36 31',
      text: '232 245 239', textMuted: '150 186 172',
      primary: '16 163 116', secondary: '110 200 170', accent: '52 211 153',
      success: '52 211 153', warning: '234 179 8', danger: '239 100 90',
      border: '26 51 43', sidebar: '9 20 17', topbar: '13 27 23',
      chart1: '16 163 116', chart2: '52 211 153', chart3: '110 200 170',
    },
  },
  {
    id: 'midnight',
    name: 'Midnight',
    mode: 'dark',
    tokens: {
      background: '8 11 20', surface: '13 17 28', surfaceElevated: '19 25 40',
      text: '227 232 245', textMuted: '150 160 190',
      primary: '69 108 235', secondary: '119 141 219', accent: '96 165 250',
      success: '52 199 120', warning: '234 179 8', danger: '239 90 100',
      border: '28 36 56', sidebar: '8 11 20', topbar: '13 17 28',
      chart1: '69 108 235', chart2: '96 165 250', chart3: '119 141 219',
    },
  },
  {
    id: 'royal',
    name: 'Royal',
    mode: 'dark',
    tokens: {
      background: '16 12 24', surface: '23 17 33', surfaceElevated: '32 24 45',
      text: '240 234 248', textMuted: '178 163 198',
      primary: '147 76 224', secondary: '198 165 230', accent: '212 175 55',
      success: '61 191 130', warning: '212 175 55', danger: '224 90 100',
      border: '48 35 66', sidebar: '16 12 24', topbar: '23 17 33',
      chart1: '147 76 224', chart2: '212 175 55', chart3: '198 165 230',
    },
  },
  {
    id: 'minimal',
    name: 'Minimal',
    mode: 'light',
    tokens: {
      background: '250 250 249', surface: '255 255 255', surfaceElevated: '255 255 255',
      text: '27 27 34', textMuted: '105 105 115',
      primary: '40 40 46', secondary: '110 110 120', accent: '74 50 201',
      success: '22 163 74', warning: '202 138 4', danger: '187 59 46',
      border: '228 228 224', sidebar: '250 250 249', topbar: '255 255 255',
      chart1: '40 40 46', chart2: '74 50 201', chart3: '110 110 120',
    },
  },
  {
    id: 'cyber',
    name: 'Cyber',
    mode: 'dark',
    tokens: {
      background: '6 10 12', surface: '10 16 19', surfaceElevated: '14 22 26',
      text: '211 250 245', textMuted: '110 168 163',
      primary: '0 224 194', secondary: '236 72 153', accent: '0 224 194',
      success: '0 224 194', warning: '250 204 21', danger: '236 72 153',
      border: '20 42 40', sidebar: '6 10 12', topbar: '10 16 19',
      chart1: '0 224 194', chart2: '236 72 153', chart3: '250 204 21',
    },
  },
  {
    id: 'command-center',
    name: 'Command Center',
    mode: 'dark',
    tokens: {
      background: '11 14 19', surface: '16 20 27', surfaceElevated: '22 28 37',
      text: '229 235 242', textMuted: '148 163 184',
      primary: '56 189 248', secondary: '148 163 184', accent: '250 204 21',
      success: '74 222 128', warning: '250 204 21', danger: '248 113 113',
      border: '30 41 54', sidebar: '11 14 19', topbar: '16 20 27',
      chart1: '56 189 248', chart2: '74 222 128', chart3: '250 204 21',
    },
  },
];

export function findAdminTheme(id: string | null | undefined): AdminTheme | null {
  return ADMIN_THEME_PRESETS.find((t) => t.id === id) ?? null;
}

const CACHE_KEY = 'darsly-admin-theme';
const ATTR = 'data-admin-theme';

/** Paint the Admin Studio in `theme`. Writes only `--adm-*` variables and
 *  the gating attribute — never touches `--c-*` directly, so the remap
 *  block in admin-theme.css is the one and only place the two systems
 *  ever meet. */
export function applyAdminTheme(theme: AdminTheme): void {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme.tokens)) {
    root.style.setProperty(`--adm-${camelToKebab(key)}`, value);
  }
  root.setAttribute(ATTR, 'true');
  try {
    localStorage.setItem(CACHE_KEY, theme.id);
  } catch {
    // A full or blocked storage costs the next load its head start, nothing more.
  }
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
    const id = localStorage.getItem(CACHE_KEY);
    // No cache yet (first admin session on this browser) → the platform
    // default, not undecorated — a SUPER_ADMIN console must look distinct
    // from a teacher's from the very first paint, before useSyncAdminTheme's
    // server round-trip even lands.
    applyAdminTheme(findAdminTheme(id) ?? ADMIN_THEME_PRESETS[0]);
  } catch {
    // No storage reachable at all — falls back to whatever useSyncAdminTheme
    // applies once React mounts and the server round-trip resolves.
  }
}

function camelToKebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}
