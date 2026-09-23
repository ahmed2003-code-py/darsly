/**
 * Platform Admin (SUPER_ADMIN console) look — the one table both apps read.
 *
 * The API resolves every look here (a preset, an Academy's brand, a store
 * theme) into the same 17 "R G B" tokens, and the web only ever paints what
 * the API hands back. Presets live here rather than in either app so the
 * server can validate and resolve them from the same values the client draws.
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

export type AdminThemeMode = 'light' | 'dark';

/** Where a look in the admin catalogue comes from. */
export type AdminThemeSource = 'PRESET' | 'ACADEMY' | 'COSMETIC';

/**
 * One entry of the admin look catalogue, fully resolved by the server.
 * `id` is namespaced (`preset:midnight`, `academy:<academyId>`,
 * `cosmetic:<key>`) and is the only thing the client ever sends back.
 */
export interface AdminThemeEntry {
  id: string;
  source: AdminThemeSource;
  name: string;
  subtitle: string | null;
  /** The mode the look was designed in — what `tokens` below is. */
  mode: AdminThemeMode;
  /** The native-mode token set. Equal to `modes[mode]`. */
  tokens: AdminThemeTokens;
  /**
   * Both ends of the look, so the reader's light/dark switch actually switches.
   *
   * Without this an admin look was a single absolute palette, and the CSS remap
   * that paints it outranks `:root[data-theme='dark']` — so the console ignored
   * the mode toggle entirely. The server resolves both halves (same
   * contrast-floored derivation the academy console uses) and the client paints
   * whichever half matches the mode, exactly as `lib/theme.ts` already does for
   * an academy's palette.
   */
  modes: Record<AdminThemeMode, AdminThemeTokens>;
  meta: {
    academyId?: string;
    academyKind?: 'PERSONAL' | 'CENTER';
    slug?: string;
    logoUrl?: string | null;
    ownerName?: string | null;
    cosmeticKey?: string;
    rarity?: string;
    pattern?: string | null;
  };
}

export interface AdminThemePreset {
  id: string;
  name: string;
  mode: AdminThemeMode;
  tokens: AdminThemeTokens;
}

export const ADMIN_THEME_PRESETS: readonly AdminThemePreset[] = [
  {
    id: 'darsly-dark',
    name: 'Darsly Dark',
    mode: 'dark',
    tokens: {
      background: '14 14 18',
      surface: '19 19 24',
      surfaceElevated: '26 26 32',
      text: '237 237 242',
      textMuted: '169 168 180',
      primary: '110 91 211',
      secondary: '201 200 210',
      accent: '156 143 226',
      success: '52 199 89',
      warning: '251 191 36',
      danger: '229 103 90',
      border: '46 46 56',
      sidebar: '14 14 18',
      topbar: '19 19 24',
      chart1: '110 91 211',
      chart2: '52 199 89',
      chart3: '251 191 36',
    },
  },
  {
    id: 'crimson-gold',
    name: 'Crimson Gold',
    mode: 'dark',
    tokens: {
      background: '17 12 12',
      surface: '24 17 17',
      surfaceElevated: '33 22 22',
      text: '245 236 230',
      textMuted: '186 160 150',
      primary: '196 55 55',
      secondary: '212 175 110',
      accent: '224 168 52',
      success: '87 168 96',
      warning: '224 168 52',
      danger: '212 60 50',
      border: '58 35 32',
      sidebar: '17 12 12',
      topbar: '24 17 17',
      chart1: '196 55 55',
      chart2: '224 168 52',
      chart3: '212 175 110',
    },
  },
  {
    id: 'emerald',
    name: 'Emerald',
    mode: 'dark',
    tokens: {
      background: '9 20 17',
      surface: '13 27 23',
      surfaceElevated: '18 36 31',
      text: '232 245 239',
      textMuted: '150 186 172',
      primary: '16 163 116',
      secondary: '110 200 170',
      accent: '52 211 153',
      success: '52 211 153',
      warning: '234 179 8',
      danger: '239 100 90',
      border: '26 51 43',
      sidebar: '9 20 17',
      topbar: '13 27 23',
      chart1: '16 163 116',
      chart2: '52 211 153',
      chart3: '110 200 170',
    },
  },
  {
    id: 'midnight',
    name: 'Midnight',
    mode: 'dark',
    tokens: {
      background: '8 11 20',
      surface: '13 17 28',
      surfaceElevated: '19 25 40',
      text: '227 232 245',
      textMuted: '150 160 190',
      primary: '69 108 235',
      secondary: '119 141 219',
      accent: '96 165 250',
      success: '52 199 120',
      warning: '234 179 8',
      danger: '239 90 100',
      border: '28 36 56',
      sidebar: '8 11 20',
      topbar: '13 17 28',
      chart1: '69 108 235',
      chart2: '96 165 250',
      chart3: '119 141 219',
    },
  },
  {
    id: 'royal',
    name: 'Royal',
    mode: 'dark',
    tokens: {
      background: '16 12 24',
      surface: '23 17 33',
      surfaceElevated: '32 24 45',
      text: '240 234 248',
      textMuted: '178 163 198',
      primary: '147 76 224',
      secondary: '198 165 230',
      accent: '212 175 55',
      success: '61 191 130',
      warning: '212 175 55',
      danger: '224 90 100',
      border: '48 35 66',
      sidebar: '16 12 24',
      topbar: '23 17 33',
      chart1: '147 76 224',
      chart2: '212 175 55',
      chart3: '198 165 230',
    },
  },
  {
    id: 'minimal',
    name: 'Minimal',
    mode: 'light',
    tokens: {
      background: '250 250 249',
      surface: '255 255 255',
      surfaceElevated: '255 255 255',
      text: '27 27 34',
      textMuted: '105 105 115',
      primary: '40 40 46',
      secondary: '110 110 120',
      accent: '74 50 201',
      success: '22 163 74',
      warning: '202 138 4',
      danger: '187 59 46',
      border: '228 228 224',
      sidebar: '250 250 249',
      topbar: '255 255 255',
      chart1: '40 40 46',
      chart2: '74 50 201',
      chart3: '110 110 120',
    },
  },
  {
    id: 'cyber',
    name: 'Cyber',
    mode: 'dark',
    tokens: {
      background: '6 10 12',
      surface: '10 16 19',
      surfaceElevated: '14 22 26',
      text: '211 250 245',
      textMuted: '110 168 163',
      primary: '0 224 194',
      secondary: '236 72 153',
      accent: '0 224 194',
      success: '0 224 194',
      warning: '250 204 21',
      danger: '236 72 153',
      border: '20 42 40',
      sidebar: '6 10 12',
      topbar: '10 16 19',
      chart1: '0 224 194',
      chart2: '236 72 153',
      chart3: '250 204 21',
    },
  },
  {
    id: 'command-center',
    name: 'Command Center',
    mode: 'dark',
    tokens: {
      background: '11 14 19',
      surface: '16 20 27',
      surfaceElevated: '22 28 37',
      text: '229 235 242',
      textMuted: '148 163 184',
      primary: '56 189 248',
      secondary: '148 163 184',
      accent: '250 204 21',
      success: '74 222 128',
      warning: '250 204 21',
      danger: '248 113 113',
      border: '30 41 54',
      sidebar: '11 14 19',
      topbar: '16 20 27',
      chart1: '56 189 248',
      chart2: '74 222 128',
      chart3: '250 204 21',
    },
  },
];

export const ADMIN_THEME_PRESET_IDS: readonly string[] = ADMIN_THEME_PRESETS.map((p) => p.id);

export const ADMIN_THEME_DEFAULT_ID = `preset:${ADMIN_THEME_PRESETS[0].id}`;

/**
 * A preset as a catalogue entry — the same shape every other source resolves to.
 *
 * `modes` is seeded with the preset's own tokens at both ends. The API replaces
 * the opposite end with a properly derived one (see AdminThemeService); this
 * shape exists so the web can boot from a preset before that round trip, and so
 * a client that somehow has no pair still paints something coherent rather than
 * nothing. The real pair arrives with the catalogue and is cached from then on.
 */
export function presetEntry(preset: AdminThemePreset): AdminThemeEntry {
  return {
    id: `preset:${preset.id}`,
    source: 'PRESET',
    name: preset.name,
    subtitle: null,
    mode: preset.mode,
    tokens: preset.tokens,
    modes: { light: preset.tokens, dark: preset.tokens },
    meta: {},
  };
}
