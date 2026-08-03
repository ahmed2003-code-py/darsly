import { SITE_PRESETS, SITE_STYLES, SiteTheme } from '../schema/site-document';

/**
 * Design DNA — the curated design directions the pipeline chooses from. Each DNA
 * is a *complete signature look*: preset (surface/mood), style (radius), heading
 * font, AND its own palette. The AI never invents layout or CSS; it picks (or
 * the vibe rotation picks) a DNA key, and this registry resolves it into render
 * tokens + colors deterministically. Adding a DNA is a data change here.
 */
export type HeadingFont = 'sans' | 'serif' | 'display';

export interface DesignDna {
  preset: (typeof SITE_PRESETS)[number];
  style: (typeof SITE_STYLES)[number];
  headingFont: HeadingFont;
  /** Signature palette used when the teacher gave no explicit color brief. */
  palette: { primary: string; accent: string };
  /** Human label + when-to-use guidance shown to the Planning model. */
  description: string;
}

export const DESIGN_DNA = {
  editorial_dark: {
    preset: 'premium', style: 'elegant', headingFont: 'serif',
    palette: { primary: '#6366F1', accent: '#E3B341' },
    description: 'Dark, editorial, luxury. Serif headlines, indigo + gold. For established, authoritative teachers who signal prestige.',
  },
  royal_night: {
    preset: 'premium', style: 'bold', headingFont: 'sans',
    palette: { primary: '#3B82F6', accent: '#A78BFA' },
    description: 'Dark, confident, modern. Bold sans, blue + violet. A premium tech feel for senior/university teachers.',
  },
  bold_energetic: {
    preset: 'energetic', style: 'bold', headingFont: 'display',
    palette: { primary: '#FB3B6C', accent: '#22D3EE' },
    description: 'Dark with vibrant animated gradients, pink + cyan display type. For youth, motivation and exam-prep audiences.',
  },
  warm_mentor: {
    preset: 'warm', style: 'modern', headingFont: 'sans',
    palette: { primary: '#D2603A', accent: '#0F766E' },
    description: 'Warm cream light theme, terracotta + teal, friendly and rounded. For school-stage students and the parents who choose for them.',
  },
  sunrise_warm: {
    preset: 'warm', style: 'modern', headingFont: 'display',
    palette: { primary: '#EA580C', accent: '#F59E0B' },
    description: 'Bright, upbeat light theme, orange + amber. Energetic but approachable — great for junior stages and clubs.',
  },
  academic_precise: {
    preset: 'academic', style: 'minimal', headingFont: 'sans',
    palette: { primary: '#1D4ED8', accent: '#0EA5E9' },
    description: 'Crisp white, minimal, high-contrast, blue. For university, STEM and rigorous, results-focused positioning.',
  },
  creative_serif: {
    preset: 'warm', style: 'elegant', headingFont: 'serif',
    palette: { primary: '#7C3AED', accent: '#DB2777' },
    description: 'Light editorial with an elegant serif, violet + pink — refined yet warm. For languages, humanities and personal-brand teachers.',
  },
} as const satisfies Record<string, DesignDna>;

export type DesignDnaKey = keyof typeof DESIGN_DNA;

export const DESIGN_DNA_KEYS = Object.keys(DESIGN_DNA) as DesignDnaKey[];

export const DEFAULT_DNA: DesignDnaKey = 'warm_mentor';

/**
 * Each vibe maps to an ordered rotation of DNAs. The generation index (how many
 * times this academy has generated) walks the list, so: picking a different vibe
 * gives a different look, and regenerating the SAME vibe rotates to the next —
 * guaranteed variety, alternating light/dark for drama.
 */
export const VIBE_DNA_ROTATION: Record<string, DesignDnaKey[]> = {
  trusted: ['warm_mentor', 'editorial_dark', 'creative_serif'],
  academic: ['academic_precise', 'editorial_dark', 'creative_serif'],
  premium: ['editorial_dark', 'creative_serif', 'royal_night'],
  energetic: ['bold_energetic', 'sunrise_warm', 'royal_night'],
};

/** Deterministically pick a DNA for a vibe at a given generation index. */
export function pickVibeDna(vibe: string | undefined, generationIndex: number): DesignDnaKey {
  const list = VIBE_DNA_ROTATION[vibe ?? 'trusted'] ?? VIBE_DNA_ROTATION.trusted;
  const i = ((generationIndex % list.length) + list.length) % list.length;
  return list[i];
}

export function isDnaKey(key: string): key is DesignDnaKey {
  return Object.prototype.hasOwnProperty.call(DESIGN_DNA, key);
}

export function resolveDna(key: string | undefined): DesignDna & { key: DesignDnaKey } {
  const k = key && isDnaKey(key) ? key : DEFAULT_DNA;
  return { key: k, ...DESIGN_DNA[k] };
}

/** The tokens a resolved DNA contributes to the Site Document theme. */
export interface DesignTokenSet {
  preset: SiteTheme['preset'];
  style: SiteTheme['style'];
  headingFont: HeadingFont;
  dna: DesignDnaKey;
}

/** A compact catalogue string for the Planning prompt (kept in sync with the map). */
export function dnaCatalogueForPrompt(): string {
  return DESIGN_DNA_KEYS.map((k) => `- ${k}: ${DESIGN_DNA[k].description}`).join('\n');
}
