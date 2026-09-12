import { darken, lighten } from '../renderer/color.util';

/**
 * The only design choice left in the Studio: a brand colour pair.
 *
 * The fixed template (see `renderer/fixed/fixed-template.ts`) is one design —
 * structure, sections, animations, everything — reproduced identically for
 * every academy. The single axis that still varies is colour, so it is picked
 * from a small curated list rather than trusted to freehand hex input: every
 * pair here is already checked to read well as a `linear-gradient(primary,
 * accent)` button/band and against the template's fixed neutral tokens, in
 * both light and dark mode.
 */
export interface Palette {
  key: string;
  primary: string;
  accent: string;
}

export const PALETTES: Palette[] = [
  { key: 'royal', primary: '#2f5fe0', accent: '#7c3aed' },
  { key: 'teal', primary: '#0d9488', accent: '#0891b2' },
  { key: 'sunset', primary: '#ea580c', accent: '#db2777' },
  { key: 'forest', primary: '#059669', accent: '#16a34a' },
  { key: 'berry', primary: '#a21caf', accent: '#e11d48' },
  { key: 'amber', primary: '#d97706', accent: '#ca8a04' },
  { key: 'sky', primary: '#2563eb', accent: '#0ea5e9' },
  { key: 'slate', primary: '#475569', accent: '#2563eb' },
];

export const PALETTE_KEYS = PALETTES.map((p) => p.key);
const DEFAULT_PALETTE = PALETTES[0];

export function resolvePalette(key?: string | null): Palette {
  return PALETTES.find((p) => p.key === key) ?? DEFAULT_PALETTE;
}

/** Every colour token the fixed template's two theme blocks need, derived from just the pair above. */
export interface PaletteTokens {
  primary: string;
  accent: string;
  primaryInk: string;
  primaryDark: string;
  accentDark: string;
}

export function paletteTokens(primary: string, accent: string): PaletteTokens {
  return {
    primary,
    accent,
    // A fixed darker readable variant of the brand colour, used as text-on-white
    // (e.g. the on-brand button). The reference page keeps this identical across
    // light and dark mode rather than deriving it per-theme, so this does too.
    primaryInk: darken(primary, 0.32),
    // Dark mode reads a lightened brand pair, same ratio the reference itself
    // uses between its own light (#2f5fe0) and dark (#6f90ff) primary.
    primaryDark: lighten(primary, 0.3),
    accentDark: lighten(accent, 0.3),
  };
}
