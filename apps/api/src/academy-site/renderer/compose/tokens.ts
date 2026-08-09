import {
  BodyFamily,
  ContainerWidth,
  DesignSpec,
  HeadingFamily,
} from '../../schema/design-spec';
import { contrastRatio, hexToRgb, isHex, mix, onColor } from '../color.util';

/**
 * The token layer: the one place a design decision becomes CSS.
 *
 * Everything the model chose arrives here as an enum, a bounded integer or a
 * hex, and leaves as a custom property. No other module reads the DesignSpec's
 * raw values, so there is exactly one place to look when a page renders wrong,
 * and exactly one place a bad value could do damage — which is why every value
 * is re-checked here even though the schema already validated it.
 */

const FALLBACK = {
  background: '#FFFFFF', ink: '#14141F', surface: '#F7F7FB',
  surfaceAlt: '#EFEFF6', primary: '#4A32C9', accent: '#4A32C9',
};

const hexOr = (v: string, fallback: string) => (isHex(v) ? v : fallback);

// ── Type ─────────────────────────────────────────────────────────────────────

/**
 * The typefaces available, and the Google family each maps to.
 *
 * Tajawal is always loaded regardless of the design: the page carries both
 * languages and toggles between them in the browser, so an English-looking page
 * still has to be able to draw Arabic the moment a visitor asks for it.
 */
export const FONT_FAMILY: Record<HeadingFamily | BodyFamily, { css: string; google?: string }> = {
  sans: { css: '"Plus Jakarta Sans","Tajawal",system-ui,-apple-system,"Segoe UI",Arial,sans-serif', google: 'Plus+Jakarta+Sans:wght@400;500;700;800' },
  serif: { css: '"Fraunces","Tajawal",Georgia,"Times New Roman",serif', google: 'Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700' },
  display: { css: '"Space Grotesk","Tajawal",system-ui,sans-serif', google: 'Space+Grotesk:wght@500;700' },
  mono: { css: '"JetBrains Mono","Tajawal",ui-monospace,SFMono-Regular,Menlo,monospace', google: 'JetBrains+Mono:wght@400;700' },
  condensed: { css: '"Archivo Narrow","Tajawal",Impact,system-ui,sans-serif', google: 'Archivo+Narrow:wght@600;700' },
};

const ARABIC_FAMILY = 'Tajawal:wght@400;700;800';

/** The single stylesheet request for exactly the families this design uses. */
export function fontHref(design: DesignSpec): string {
  const families = new Set<string>([ARABIC_FAMILY]);
  for (const key of [design.typography.headingFamily, design.typography.bodyFamily]) {
    const g = FONT_FAMILY[key]?.google;
    if (g) families.add(g);
  }
  const q = [...families].map((f) => `family=${f}`).join('&');
  return `https://fonts.googleapis.com/css2?${q}&display=swap`;
}

/** Headline sizes per scale: [h1, h2, h3, lead]. */
const SCALE: Record<string, [string, string, string, string]> = {
  restrained: ['clamp(2rem,4vw,3rem)', 'clamp(1.45rem,2.4vw,1.95rem)', 'clamp(1.05rem,1.4vw,1.2rem)', 'clamp(1rem,1.2vw,1.12rem)'],
  balanced: ['clamp(2.5rem,6vw,4rem)', 'clamp(1.8rem,3.4vw,2.6rem)', 'clamp(1.1rem,1.6vw,1.32rem)', 'clamp(1.08rem,1.5vw,1.25rem)'],
  dramatic: ['clamp(3rem,8vw,5.4rem)', 'clamp(2.15rem,4.4vw,3.3rem)', 'clamp(1.18rem,1.9vw,1.45rem)', 'clamp(1.15rem,1.8vw,1.4rem)'],
  monumental: ['clamp(3.4rem,11vw,7.5rem)', 'clamp(2.5rem,5.6vw,4.2rem)', 'clamp(1.25rem,2.1vw,1.6rem)', 'clamp(1.2rem,2vw,1.5rem)'],
};

const TRACKING: Record<string, string> = { tight: '-0.04em', normal: '-0.012em', wide: '0.03em' };
const MEASURE: Record<string, string> = { narrow: '52ch', normal: '64ch', wide: '74ch' };

// ── Rhythm ───────────────────────────────────────────────────────────────────

const DENSITY_PAD: Record<string, number> = { compact: 64, regular: 100, airy: 144, expansive: 188 };
const GUTTER: Record<string, string> = { tight: '16px', normal: '24px', generous: '40px' };

export const CONTAINER: Record<ContainerWidth, string> = {
  narrow: '860px',
  standard: '1120px',
  wide: '1340px',
  full: '100%',
};

// ── Geometry ─────────────────────────────────────────────────────────────────

const BORDER_W: Record<string, string> = { none: '0px', hairline: '1px', strong: '2px' };

/**
 * Shadow language. `brutal` is a hard offset with no blur — it only reads as a
 * decision next to a hairline border and a small radius, which is exactly where
 * the model is told to use it.
 */
const SHADOW: Record<string, [string, string]> = {
  none: ['none', 'none'],
  soft: ['0 10px 30px -18px rgba(var(--inkr),.30)', '0 30px 60px -32px rgba(var(--inkr),.38)'],
  deep: ['0 18px 44px -20px rgba(var(--inkr),.45)', '0 50px 90px -40px rgba(var(--inkr),.55)'],
  brutal: ['4px 4px 0 0 var(--ink)', '8px 8px 0 0 var(--ink)'],
};

const clampInt = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

// ── Derived colour ───────────────────────────────────────────────────────────

/**
 * The colours nobody is asked for.
 *
 * Muted text, hairlines and the colour that sits on top of a brand fill all have
 * to *relate* to the palette; a model asked for nine colours reliably produces
 * one that clashes. It picks six, and these are computed.
 */
export interface DerivedPalette {
  background: string; ink: string; surface: string; surfaceAlt: string;
  primary: string; accent: string;
  onPrimary: string; onAccent: string; onInk: string;
  isDark: boolean;
}

export function derivePalette(design: DesignSpec): DerivedPalette {
  const p = design.palette;
  const background = hexOr(p.background, FALLBACK.background);
  const ink = hexOr(p.ink, FALLBACK.ink);
  const surface = hexOr(p.surface, FALLBACK.surface);
  const surfaceAlt = hexOr(p.surfaceAlt, FALLBACK.surfaceAlt);
  const primary = hexOr(p.primary, FALLBACK.primary);
  const accent = hexOr(p.accent, FALLBACK.accent);
  return {
    background, ink, surface, surfaceAlt, primary, accent,
    onPrimary: onColor(primary),
    onAccent: onColor(accent),
    onInk: onColor(ink),
    // Derived from the colours themselves rather than from the model's own
    // `mode` claim, which is a description and can simply be wrong.
    isDark: contrastRatio(background, '#FFFFFF') > contrastRatio(background, '#000000'),
  };
}

/**
 * A brand colour readable as *text* on the page background.
 *
 * A saturated brand colour that works as a button fill is frequently unreadable
 * as an eyebrow on the same page. Rather than forbid the palette, the accent
 * used for text is lightened or darkened until it carries — so the design
 * survives and the words stay legible.
 */
export function readableOn(color: string, background: string, target = 4.5): string {
  if (contrastRatio(color, background) >= target) return color;
  const toward = contrastRatio(background, '#FFFFFF') > contrastRatio(background, '#000000') ? '#FFFFFF' : '#000000';
  let best = color;
  for (let w = 0.1; w <= 0.9; w += 0.1) {
    best = mix(color, toward, w);
    if (contrastRatio(best, background) >= target) return best;
  }
  return best;
}

// ── The stylesheet root ──────────────────────────────────────────────────────

export function tokens(design: DesignSpec): string {
  const c = derivePalette(design);
  const t = design.typography;
  const g = design.geometry;
  const r = design.rhythm;

  const [h1, h2, h3, lead] = SCALE[t.scale] ?? SCALE.balanced;
  const headFamily = FONT_FAMILY[t.headingFamily]?.css ?? FONT_FAMILY.sans.css;
  const bodyFamily = FONT_FAMILY[t.bodyFamily]?.css ?? FONT_FAMILY.sans.css;
  const weight = [400, 500, 600, 700, 800, 900].includes(t.headingWeight) ? t.headingWeight : 700;

  const radius = clampInt(g.radius, 0, 32, 14);
  // A pill geometry keeps its cards rectangular — rounding a 400px-wide panel to
  // 999px turns it into a capsule, which is a different design, not this one.
  const cardRadius = g.radiusStyle === 'pill' ? Math.max(radius, 18) : radius;
  const pillRadius = g.radiusStyle === 'cut-corner' ? 0 : 999;
  const [sh1, sh2] = SHADOW[g.shadow] ?? SHADOW.soft;

  const pad = DENSITY_PAD[r.density] ?? DENSITY_PAD.regular;
  const wrap = CONTAINER[r.containerWidth] ?? CONTAINER.standard;

  // Text-safe versions of the brand colours, used wherever a colour is a word
  // rather than a fill.
  const primaryText = readableOn(c.primary, c.background);
  const accentText = readableOn(c.accent, c.background);
  const accentOnSurface = readableOn(c.accent, c.surface);

  return `:root{
--bg:${c.background};--ink:${c.ink};--surface:${c.surface};--surface-2:${c.surfaceAlt};
--p:${c.primary};--a:${c.accent};--on-p:${c.onPrimary};--on-a:${c.onAccent};
--p-text:${primaryText};--a-text:${accentText};--a-surface:${accentOnSurface};
--pr:${hexToRgb(c.primary).join(',')};--ar:${hexToRgb(c.accent).join(',')};--inkr:${hexToRgb(c.ink).join(',')};
--mut:color-mix(in srgb,var(--ink) 60%,var(--bg));
--body:color-mix(in srgb,var(--ink) 88%,var(--bg));
--line:color-mix(in srgb,var(--ink) ${g.border === 'strong' ? 26 : 13}%,var(--bg));
--font-h:${headFamily};--font-b:${bodyFamily};
--wh:${weight};--tr:${TRACKING[t.tracking] ?? TRACKING.normal};--case:${t.headingCase === 'upper' ? 'uppercase' : 'none'};
--h1:${h1};--h2:${h2};--h3:${h3};--lead:${lead};--measure:${MEASURE[t.measure] ?? MEASURE.normal};
--rad:${cardRadius}px;--rad-s:${Math.round(cardRadius * 0.6)}px;--rad-l:${cardRadius + 8}px;--pill:${pillRadius}px;
--bw:${BORDER_W[g.border] ?? '1px'};--sh1:${sh1};--sh2:${sh2};
--pad:${pad}px;--wrap:${wrap};--gut:${GUTTER[r.gutter] ?? '24px'};--gap:${Math.round(pad / 3)}px;
}`;
}

/** The attributes the compiler puts on `<html>` so CSS can branch on the design. */
export function rootAttrs(design: DesignSpec): string {
  const c = derivePalette(design);
  return [
    `data-mode="${c.isDark ? 'dark' : 'light'}"`,
    `data-motion="${design.motion.intensity}"`,
    `data-entrance="${design.motion.entrance}"`,
    `data-rhythm="${design.rhythm.sectionRhythm}"`,
    `data-radius="${design.geometry.radiusStyle}"`,
    `data-shadow="${design.geometry.shadow}"`,
    `data-border="${design.geometry.border}"`,
  ].join(' ');
}
