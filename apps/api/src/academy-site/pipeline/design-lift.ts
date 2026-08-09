import { DesignSpec } from '../schema/design-spec';
import { SiteDocument } from '../schema/site-document';
import { lighten, mix, relLuminance } from '../renderer/color.util';
import { resolveDna } from './design-dna';

/**
 * Lifting a v2 document into the v3 design system.
 *
 * Every page generated before the composition pipeline carries either a Design
 * DNA preset or the old nine-field `design` object. Rather than migrate the
 * database — which would rewrite documents teachers already approved — the shape
 * is lifted in code, here, whenever one is needed.
 *
 * That gives the upgrade path a single, testable function: an old document can
 * be re-rendered through the new engine without a model call and without losing
 * the identity it was published with.
 */

const PRESET_PALETTE: Record<string, { background: string; ink: string; surface: string }> = {
  warm: { background: '#FFFDF9', ink: '#231E19', surface: '#FFF7EE' },
  academic: { background: '#FFFFFF', ink: '#0E1A2B', surface: '#F4F8FC' },
  premium: { background: '#0B0B13', ink: '#F4F2F9', surface: '#14141E' },
  energetic: { background: '#0A0A17', ink: '#FFFFFF', surface: '#15152C' },
};

const HEADING_MAP: Record<string, DesignSpec['typography']['headingFamily']> = {
  sans: 'sans', serif: 'serif', display: 'display',
};

const SCALE_MAP: Record<string, DesignSpec['typography']['scale']> = {
  restrained: 'restrained', balanced: 'balanced', dramatic: 'dramatic',
};

const BACKDROP_MAP: Record<string, DesignSpec['decoration']['backdrop']> = {
  flat: 'none', gradient: 'gradient-wash', mesh: 'mesh', spotlight: 'spotlight',
};

const STYLE_RADIUS: Record<string, number> = {
  modern: 18, bold: 12, elegant: 10, minimal: 10, playful: 26,
};

/**
 * Build a v3 design system that reproduces the look a v2 document was published
 * with, as closely as the richer model allows.
 */
export function liftLegacyDesign(doc: SiteDocument): DesignSpec {
  const theme = doc.theme;
  const legacy = theme.design;
  const dna = resolveDna(theme.dna);
  const preset = PRESET_PALETTE[theme.preset ?? 'warm'] ?? PRESET_PALETTE.warm;

  const background = legacy?.background ?? preset.background;
  const ink = legacy?.ink ?? preset.ink;
  const surface = legacy?.surface ?? preset.surface;
  const isDark = relLuminance(background) <= 0.5;

  return {
    palette: {
      background,
      ink,
      surface,
      // v2 had no second surface. Deriving one rather than reusing `surface`
      // keeps alternating sections from collapsing into a flat page.
      surfaceAlt: mix(surface, ink, 0.05),
      primary: theme.primary,
      // Dark presets lightened the brand for accents; keeping that here is what
      // stops a lifted premium page losing its highlight colour.
      accent: isDark ? lighten(theme.accent, 0.28) : theme.accent,
      mode: isDark ? 'dark' : 'light',
    },
    typography: {
      headingFamily: HEADING_MAP[theme.headingFont ?? dna.headingFont] ?? 'sans',
      bodyFamily: legacy?.bodyFont ?? 'sans',
      scale: SCALE_MAP[legacy?.headingScale ?? 'balanced'] ?? 'balanced',
      headingWeight: 800,
      headingCase: 'normal',
      tracking: 'tight',
      measure: 'normal',
    },
    geometry: {
      radius: legacy?.radius ?? STYLE_RADIUS[theme.style ?? 'modern'] ?? 18,
      radiusStyle: 'uniform',
      border: 'hairline',
      shadow: 'soft',
      grain: false,
    },
    rhythm: {
      density: legacy?.density ?? 'regular',
      sectionRhythm: 'even',
      containerWidth: 'standard',
      gutter: 'normal',
    },
    motion: {
      intensity: legacy?.motion ?? 'lively',
      entrance: 'rise',
      // The legacy page had a reading-progress bar, a pointer glow on cards and
      // counting statistics. Naming them here is what keeps a lifted page from
      // feeling flatter than the one it replaced.
      scrollFx: ['progress-bar', 'pointer-glow', 'counters'],
    },
    decoration: {
      backdrop: BACKDROP_MAP[legacy?.heroTreatment ?? 'gradient'] ?? 'gradient-wash',
      accents: ['numbered-sections'],
      dividers: 'gradient',
      imageTreatment: 'rounded',
    },
  };
}

/** The design system in force for a document, lifting a legacy one if needed. */
export function designFor(doc: SiteDocument): DesignSpec {
  return doc.theme.designSpec ?? liftLegacyDesign(doc);
}
