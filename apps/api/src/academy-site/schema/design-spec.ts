import { z } from 'zod';

/**
 * The Design Specification — the visual system the model composes for one
 * academy.
 *
 * It replaces a palette plus six knobs with a whole design language: colour,
 * type, geometry, rhythm, motion and decoration. The point is not more options;
 * it is that these axes multiply. Two teachers now differ in what their page is
 * built out of, not only in what colour it was painted.
 *
 * Every field is an enum, a bounded integer or a six-digit hex. The model never
 * writes CSS, markup, a class name or a URL — the compiler owns the mapping from
 * each token to the stylesheet, so a hostile or incompetent response can change
 * how a page looks and can do nothing else.
 *
 * The whole object is optional on a document. A document without one renders
 * through the frozen legacy renderer exactly as it did the day it was published.
 */

const HEX = /^#[0-9a-fA-F]{6}$/;
const hex = () => z.string().regex(HEX);

export const PALETTE_MODES = ['light', 'dark'] as const;

export const paletteSchema = z.object({
  /** The page background. Decides whether the whole design reads light or dark. */
  background: hex(),
  /** Body text. The rules engine holds this to a contrast ratio against the background. */
  ink: hex(),
  /** Cards, bands and panels — a step away from the background, not a second theme. */
  surface: hex(),
  /** A second surface for alternating sections and nested panels. */
  surfaceAlt: hex(),
  /** The dominant brand colour: primary buttons, links, emphasis. */
  primary: hex(),
  /** The supporting colour: eyebrows, accents, gradient partners. */
  accent: hex(),
  /** What the model believes it built. Checked, and corrected, downstream. */
  mode: z.enum(PALETTE_MODES),
});

export const HEADING_FAMILIES = ['sans', 'serif', 'display', 'mono', 'condensed'] as const;
export const BODY_FAMILIES = ['sans', 'serif', 'mono'] as const;
export const TYPE_SCALES = ['restrained', 'balanced', 'dramatic', 'monumental'] as const;
export const HEADING_WEIGHTS = [400, 500, 600, 700, 800, 900] as const;
export const HEADING_CASES = ['normal', 'upper'] as const;
export const TRACKINGS = ['tight', 'normal', 'wide'] as const;
export const MEASURES = ['narrow', 'normal', 'wide'] as const;

export const typographySchema = z.object({
  headingFamily: z.enum(HEADING_FAMILIES),
  bodyFamily: z.enum(BODY_FAMILIES),
  /** How far headlines are allowed to dominate the page. */
  scale: z.enum(TYPE_SCALES),
  headingWeight: z.union([
    z.literal(400), z.literal(500), z.literal(600),
    z.literal(700), z.literal(800), z.literal(900),
  ]),
  headingCase: z.enum(HEADING_CASES),
  tracking: z.enum(TRACKINGS),
  /** Reading measure for body copy — how wide a paragraph is allowed to run. */
  measure: z.enum(MEASURES),
});

export const RADIUS_STYLES = ['uniform', 'mixed', 'pill', 'cut-corner'] as const;
export const BORDER_WEIGHTS = ['none', 'hairline', 'strong'] as const;
export const SHADOW_DEPTHS = ['none', 'soft', 'deep', 'brutal'] as const;

export const geometrySchema = z.object({
  radius: z.number().int().min(0).max(32),
  radiusStyle: z.enum(RADIUS_STYLES),
  border: z.enum(BORDER_WEIGHTS),
  shadow: z.enum(SHADOW_DEPTHS),
  /** A fine noise overlay. Expensive-looking on dark editorial pages, noise on light ones. */
  grain: z.boolean(),
});

export const DENSITIES = ['compact', 'regular', 'airy', 'expansive'] as const;
export const SECTION_RHYTHMS = ['even', 'alternating', 'crescendo'] as const;
export const CONTAINER_WIDTHS = ['narrow', 'standard', 'wide', 'full'] as const;
export const GUTTERS = ['tight', 'normal', 'generous'] as const;

export const rhythmSchema = z.object({
  density: z.enum(DENSITIES),
  /** Whether every section breathes the same, alternates, or opens up as you scroll. */
  sectionRhythm: z.enum(SECTION_RHYTHMS),
  containerWidth: z.enum(CONTAINER_WIDTHS),
  gutter: z.enum(GUTTERS),
});

export const MOTION_INTENSITIES = ['calm', 'lively', 'cinematic'] as const;
export const ENTRANCES = ['fade', 'rise', 'slide', 'mask-reveal', 'stagger-grid'] as const;
export const SCROLL_EFFECTS = [
  'parallax', 'sticky-headings', 'progress-bar', 'counters', 'pointer-glow', 'marquee',
] as const;

export const motionSchema = z.object({
  /** How far the page moves. Every setting animates; they differ in amplitude. */
  intensity: z.enum(MOTION_INTENSITIES),
  /** How a section arrives when it scrolls into view. */
  entrance: z.enum(ENTRANCES),
  /** Extra behaviours, budgeted — the rules engine keeps at most three. */
  scrollFx: z.array(z.enum(SCROLL_EFFECTS)).max(6),
});

export const BACKDROPS = [
  'none', 'gradient-wash', 'mesh', 'spotlight', 'grid-lines',
  'dot-matrix', 'blueprint', 'topography', 'orbits', 'aurora',
] as const;
export const ACCENT_MARKS = [
  'rule-lines', 'numbered-sections', 'corner-brackets', 'sticker-badges',
  'underline-swash', 'blob', 'ring',
] as const;
export const DIVIDERS = ['none', 'hairline', 'gradient', 'wave', 'notch'] as const;
export const IMAGE_TREATMENTS = [
  'plain', 'rounded', 'duotone', 'ring', 'tilt', 'mask-arch', 'mask-blob', 'grid-overlay',
] as const;

export const decorationSchema = z.object({
  /** The atmosphere behind the page. The single biggest lever on how it feels. */
  backdrop: z.enum(BACKDROPS),
  /** Recurring marks that give the page a signature. Budgeted to three. */
  accents: z.array(z.enum(ACCENT_MARKS)).max(5),
  dividers: z.enum(DIVIDERS),
  imageTreatment: z.enum(IMAGE_TREATMENTS),
});

export const designSpecSchema = z.object({
  palette: paletteSchema,
  typography: typographySchema,
  geometry: geometrySchema,
  rhythm: rhythmSchema,
  motion: motionSchema,
  decoration: decorationSchema,
});

export type Palette = z.infer<typeof paletteSchema>;
export type Typography = z.infer<typeof typographySchema>;
export type Geometry = z.infer<typeof geometrySchema>;
export type Rhythm = z.infer<typeof rhythmSchema>;
export type Motion = z.infer<typeof motionSchema>;
export type Decoration = z.infer<typeof decorationSchema>;
export type DesignSpec = z.infer<typeof designSpecSchema>;

export type HeadingFamily = (typeof HEADING_FAMILIES)[number];
export type BodyFamily = (typeof BODY_FAMILIES)[number];
export type Backdrop = (typeof BACKDROPS)[number];
export type AccentMark = (typeof ACCENT_MARKS)[number];
export type ScrollEffect = (typeof SCROLL_EFFECTS)[number];
export type ImageTreatment = (typeof IMAGE_TREATMENTS)[number];
export type Entrance = (typeof ENTRANCES)[number];
export type ContainerWidth = (typeof CONTAINER_WIDTHS)[number];

// ── Section composition ──────────────────────────────────────────────────────

export const SECTION_EMPHASIS = ['quiet', 'normal', 'feature'] as const;
export const SECTION_SURFACES = ['page', 'raised', 'inverted', 'accent', 'image'] as const;
export const SECTION_ALIGNS = ['start', 'center'] as const;

/**
 * How one section sits on the page. The pattern decides the layout; these decide
 * how loudly it is played — which is what stops a page of good sections reading
 * as a list of good sections.
 */
export const sectionSpecSchema = z.object({
  /** Registered pattern id, e.g. `hero.split-portrait`. Resolved against the registry. */
  pattern: z.string().max(60),
  emphasis: z.enum(SECTION_EMPHASIS).optional(),
  width: z.enum(CONTAINER_WIDTHS).optional(),
  surface: z.enum(SECTION_SURFACES).optional(),
  align: z.enum(SECTION_ALIGNS).optional(),
  columns: z.number().int().min(1).max(4).optional(),
  accents: z.array(z.enum(ACCENT_MARKS)).max(2).optional(),
  imageTreatment: z.enum(IMAGE_TREATMENTS).optional(),
});

export type SectionSpec = z.infer<typeof sectionSpecSchema>;
export type SectionEmphasis = (typeof SECTION_EMPHASIS)[number];
export type SectionSurface = (typeof SECTION_SURFACES)[number];

// ── Design fingerprint (evolution) ───────────────────────────────────────────

/**
 * A compact description of what a generation actually looked like, on the axes a
 * visitor would notice. Two fingerprints that differ on three of these read as
 * two different designs; two that differ on one read as a recolour.
 */
export const fingerprintSchema = z.object({
  mode: z.enum(PALETTE_MODES),
  hue: z.number().int().min(0).max(360),
  headingFamily: z.enum(HEADING_FAMILIES),
  scale: z.enum(TYPE_SCALES),
  radiusBand: z.enum(['sharp', 'moderate', 'round']),
  densityBand: z.enum(DENSITIES),
  backdrop: z.enum(BACKDROPS),
  heroPattern: z.string().max(60),
  sectionOrder: z.string().max(200),
});

export type DesignFingerprint = z.infer<typeof fingerprintSchema>;
