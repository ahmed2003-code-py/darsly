import {
  ACCENT_MARKS, BACKDROPS, DIVIDERS, DesignSpec, ENTRANCES, HEADING_FAMILIES, IMAGE_TREATMENTS,
  SCROLL_EFFECTS,
} from '../schema/design-spec';
import { contrastRatio, isHex, mix, relLuminance } from '../renderer/color.util';
import { RulesVerdict } from './contracts';

/**
 * Design repair.
 *
 * The governing decision of this whole layer is *repair, never reject*. A model
 * asked for thirty design choices will occasionally get one wrong, and throwing
 * away an otherwise good page because its body text is 30 points too dark costs
 * a generation, costs money and gives the teacher nothing. So every rule here
 * returns a corrected design and a verdict explaining what it changed.
 *
 * The corrections are deliberately minimal: they move the offending value just
 * far enough to be defensible and leave everything else alone, so a repaired
 * design still looks like the design the model intended.
 */

/** WCAG AAA for body text. Deliberately strict — this is the floor, not the target. */
const BODY_CONTRAST = 7;
/** Below this a "second surface" is invisible; above it, it is a different theme. */
const SURFACE_MIN = 1.06;
const SURFACE_MAX = 2.6;
const MAX_SCROLL_FX = 3;
const MAX_ACCENTS = 3;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Push `color` away from `background` until it is legible against it. */
function pushToContrast(color: string, background: string, target: number): string {
  if (contrastRatio(color, background) >= target) return color;
  // Move toward whichever extreme the background is furthest from, so dark pages
  // brighten their ink and light pages darken it.
  const toward = relLuminance(background) > 0.5 ? '#000000' : '#FFFFFF';
  let best = color;
  for (let w = 0.05; w <= 1; w += 0.05) {
    best = mix(color, toward, w);
    if (contrastRatio(best, background) >= target) return best;
  }
  return toward;
}

/** Pull `color` toward `background` until it stops reading as a separate theme. */
function pullToward(color: string, background: string, maxRatio: number): string {
  let best = color;
  for (let w = 0.05; w <= 1; w += 0.05) {
    if (contrastRatio(best, background) <= maxRatio) return best;
    best = mix(color, background, w);
  }
  return best;
}

/** Separate two colours that are nearly, but not exactly, the same. */
function nudgeApart(color: string, from: string): string {
  const toward = relLuminance(from) > 0.5 ? '#000000' : '#FFFFFF';
  return mix(color, toward, 0.18);
}

const unique = <T>(xs: T[]): T[] => [...new Set(xs)];

export interface RepairResult {
  design: DesignSpec;
  verdicts: RulesVerdict[];
}

/**
 * Validate and correct a composed design system.
 *
 * Returns a design that is always renderable and always legible, plus the list
 * of what had to be changed to make it so.
 */
export function repairDesign(input: DesignSpec): RepairResult {
  const v: RulesVerdict[] = [];
  const d: DesignSpec = {
    palette: { ...input.palette },
    typography: { ...input.typography },
    geometry: { ...input.geometry },
    rhythm: { ...input.rhythm },
    motion: { ...input.motion, scrollFx: [...input.motion.scrollFx] },
    decoration: { ...input.decoration, accents: [...input.decoration.accents] },
  };
  const p = d.palette;

  const warn = (code: string, message: string, target: string) =>
    v.push({ code, severity: 'warn', message, target });

  // ── Colour ────────────────────────────────────────────────────────────────
  // Anything that is not a colour is replaced before it can be reasoned about.
  for (const key of ['background', 'ink', 'surface', 'surfaceAlt', 'primary', 'accent'] as const) {
    if (!isHex(p[key])) {
      p[key] = key === 'background' ? '#FFFFFF' : '#14141F';
      warn('colour-invalid', `${key} was not a six-digit hex and was replaced`, `palette.${key}`);
    }
  }

  // The single most valuable rule in the system: body text must be readable on
  // the background it was given. Nothing checked this before, so a page could —
  // and eventually would — go live effectively blank.
  const inkRatio = contrastRatio(p.ink, p.background);
  if (inkRatio < BODY_CONTRAST) {
    p.ink = pushToContrast(p.ink, p.background, BODY_CONTRAST);
    warn(
      'ink-contrast-raised',
      `body text contrast was ${inkRatio.toFixed(2)}:1 against the background and was darkened to reach ${BODY_CONTRAST}:1`,
      'palette.ink',
    );
  }

  // A surface identical to the background gives cards no edge; one too far from
  // it reads as a second theme fighting the first.
  const surfaceRatio = contrastRatio(p.surface, p.background);
  if (surfaceRatio < SURFACE_MIN) {
    p.surface = mix(p.background, p.ink, 0.06);
    warn('surface-indistinct', 'surface was indistinguishable from the background', 'palette.surface');
  } else if (surfaceRatio > SURFACE_MAX) {
    p.surface = pullToward(p.surface, p.background, SURFACE_MAX);
    warn('surface-overpowering', 'surface was far enough from the background to read as a second theme', 'palette.surface');
  }
  if (contrastRatio(p.surfaceAlt, p.background) > SURFACE_MAX) {
    p.surfaceAlt = pullToward(p.surfaceAlt, p.background, SURFACE_MAX);
    warn('surface-alt-overpowering', 'the second surface was too far from the background', 'palette.surfaceAlt');
  }
  if (contrastRatio(p.surfaceAlt, p.surface) < 1.02) {
    p.surfaceAlt = mix(p.surface, p.ink, 0.05);
    warn('surface-alt-duplicate', 'both surfaces were the same colour', 'palette.surfaceAlt');
  }

  // Two brand colours that are *nearly* identical read as a mistake; two that
  // are exactly identical read as a deliberate monochrome brand, so only the
  // first is corrected.
  const brandRatio = contrastRatio(p.primary, p.accent);
  if (brandRatio < 1.12 && p.primary.toLowerCase() !== p.accent.toLowerCase()) {
    p.accent = nudgeApart(p.accent, p.primary);
    warn('accent-indistinct', 'the accent was nearly identical to the primary and was separated', 'palette.accent');
  }

  // `mode` is the model describing its own palette, and it can simply be wrong.
  // The compiler derives the truth from the background; this keeps the stored
  // document honest so evolution reasons about what was actually built.
  const derivedMode = relLuminance(p.background) > 0.5 ? 'light' : 'dark';
  if (p.mode !== derivedMode) {
    p.mode = derivedMode;
    warn('mode-corrected', `the palette was described as ${input.palette.mode} but reads as ${derivedMode}`, 'palette.mode');
  }

  // ── Type ──────────────────────────────────────────────────────────────────
  if (!HEADING_FAMILIES.includes(d.typography.headingFamily)) {
    d.typography.headingFamily = 'sans';
    warn('heading-family-unknown', 'unknown heading typeface, fell back to sans', 'typography.headingFamily');
  }
  // Every amplifier at once is not a strong design, it is an unreadable one:
  // condensed uppercase at monumental scale with tight tracking closes the
  // counters until the words stop being letters.
  const t = d.typography;
  const shouting = t.scale === 'monumental' && t.headingCase === 'upper'
    && (t.headingFamily === 'condensed' || t.headingWeight >= 900) && t.tracking === 'tight';
  if (shouting) {
    t.scale = 'dramatic';
    t.tracking = 'normal';
    warn('typography-overloaded', 'monumental uppercase condensed tight type was eased to stay readable', 'typography.scale');
  }

  // ── Geometry ──────────────────────────────────────────────────────────────
  const radius = Math.round(Number(d.geometry.radius));
  if (!Number.isFinite(radius) || radius !== d.geometry.radius || radius < 0 || radius > 32) {
    d.geometry.radius = Number.isFinite(radius) ? clamp(radius, 0, 32) : 14;
    warn('radius-clamped', 'the corner radius was outside the supported range', 'geometry.radius');
  }
  // A hard offset shadow needs an edge to sit against; with no border it reads
  // as a rendering fault rather than a decision.
  if (d.geometry.shadow === 'brutal' && d.geometry.border === 'none') {
    d.geometry.border = 'hairline';
    warn('brutal-needs-border', 'a hard offset shadow was given a border to sit against', 'geometry.border');
  }

  // ── Motion ────────────────────────────────────────────────────────────────
  const fx = unique(d.motion.scrollFx).filter((f) => SCROLL_EFFECTS.includes(f));
  if (fx.length !== d.motion.scrollFx.length) {
    warn('scrollfx-cleaned', 'duplicate or unknown scroll effects were dropped', 'motion.scrollFx');
  }
  if (fx.length > MAX_SCROLL_FX) {
    warn('scrollfx-budget', `${fx.length} scroll effects were requested; the page keeps ${MAX_SCROLL_FX}`, 'motion.scrollFx');
  }
  d.motion.scrollFx = fx.slice(0, MAX_SCROLL_FX);
  // A marquee, a parallax and a cinematic entrance together mean nothing on the
  // page is ever still, and the copy is what the visitor came for.
  if (d.motion.intensity === 'cinematic' && d.motion.scrollFx.includes('marquee') && d.motion.scrollFx.includes('parallax')) {
    d.motion.scrollFx = d.motion.scrollFx.filter((f) => f !== 'marquee');
    warn('motion-overloaded', 'a cinematic page with both parallax and a marquee gave up the marquee', 'motion.scrollFx');
  }
  if (!ENTRANCES.includes(d.motion.entrance)) {
    d.motion.entrance = 'rise';
    warn('entrance-unknown', 'unknown entrance, fell back to rise', 'motion.entrance');
  }

  // ── Decoration ────────────────────────────────────────────────────────────
  if (!BACKDROPS.includes(d.decoration.backdrop)) {
    d.decoration.backdrop = 'none';
    warn('backdrop-unknown', 'unknown backdrop, fell back to none', 'decoration.backdrop');
  }
  const accents = unique(d.decoration.accents).filter((a) => ACCENT_MARKS.includes(a));
  if (accents.length > MAX_ACCENTS) {
    warn('accent-budget', `${accents.length} accent marks were requested; the page keeps ${MAX_ACCENTS}`, 'decoration.accents');
  }
  d.decoration.accents = accents.slice(0, MAX_ACCENTS);
  if (!DIVIDERS.includes(d.decoration.dividers)) {
    d.decoration.dividers = 'none';
    warn('divider-unknown', 'unknown divider, fell back to none', 'decoration.dividers');
  }
  if (!IMAGE_TREATMENTS.includes(d.decoration.imageTreatment)) {
    d.decoration.imageTreatment = 'rounded';
    warn('image-treatment-unknown', 'unknown image treatment, fell back to rounded', 'decoration.imageTreatment');
  }
  // Grain is a film effect: on a light page it is not texture, it is dirt.
  if (d.geometry.grain && derivedMode === 'light') {
    d.geometry.grain = false;
    warn('grain-light-page', 'film grain was removed from a light page, where it reads as dirt', 'geometry.grain');
  }

  return { design: d, verdicts: v };
}
