import { SITE_PRESETS, SITE_STYLES, SiteTheme } from '../schema/site-document';

/**
 * Design DNA — the curated design directions the AI Planning stage may choose
 * from. The AI never invents layout or CSS; it picks a DNA *key*, and this
 * registry deterministically resolves it into render tokens (preset + style +
 * heading-font treatment). Adding a new DNA is a data change here — the pipeline
 * and prompts read the catalogue, so nothing else changes.
 */
export type HeadingFont = 'sans' | 'serif' | 'display';

export interface DesignDna {
  /** Surface/mood family consumed by the renderer CSS. */
  preset: (typeof SITE_PRESETS)[number];
  /** Corner/визual style (radius family). */
  style: (typeof SITE_STYLES)[number];
  /** Heading typeface treatment. */
  headingFont: HeadingFont;
  /** Human label + when-to-use guidance shown to the Planning model. */
  description: string;
}

export const DESIGN_DNA = {
  editorial_dark: {
    preset: 'premium',
    style: 'elegant',
    headingFont: 'serif',
    description: 'Dark, editorial, luxury. Serif headlines, generous space. For established, authoritative teachers who signal prestige.',
  },
  bold_energetic: {
    preset: 'energetic',
    style: 'bold',
    headingFont: 'display',
    description: 'Dark with vibrant animated gradients and punchy display type. For youth, motivation and exam-prep audiences.',
  },
  warm_mentor: {
    preset: 'warm',
    style: 'modern',
    headingFont: 'sans',
    description: 'Warm cream light theme, friendly and rounded, calm and trustworthy. For school-stage students and the parents who choose for them.',
  },
  academic_precise: {
    preset: 'academic',
    style: 'minimal',
    headingFont: 'sans',
    description: 'Crisp white, minimal, high-contrast and precise. For university, STEM and results-focused, rigorous positioning.',
  },
  creative_serif: {
    preset: 'warm',
    style: 'elegant',
    headingFont: 'serif',
    description: 'Light editorial with an elegant serif — refined yet warm. For languages, humanities and personal-brand teachers.',
  },
} as const satisfies Record<string, DesignDna>;

export type DesignDnaKey = keyof typeof DESIGN_DNA;

export const DESIGN_DNA_KEYS = Object.keys(DESIGN_DNA) as DesignDnaKey[];

export const DEFAULT_DNA: DesignDnaKey = 'warm_mentor';

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
