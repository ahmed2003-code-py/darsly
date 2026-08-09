import { z } from 'zod';
import { designSpecSchema, fingerprintSchema, sectionSpecSchema } from './design-spec';

/**
 * The Site Document — the single source of truth for an academy landing page.
 * It is presentation data only (a closed set of typed blocks); live facts like
 * course lists and reviews are marked `auto` and resolved at render time, never
 * frozen into the document. All human-visible text is bilingual (ar + en).
 */

const HEX = /^#[0-9a-fA-F]{6}$/;

// Bilingual text. `en` may be empty when only Arabic was produced.
export const localizedText = (max: number) =>
  z.object({ ar: z.string().max(max), en: z.string().max(max) });

// Site Document v2: the layout variant chosen by the Site Brain for this block
// (resolved against the Variant Registry). Optional so pre-v2 documents — which
// render with each section's default variant — still validate.
const variant = z.string().max(40).optional();

/**
 * Site Document v3: how this section is composed — which pattern renders it and
 * how loudly it is played. Present only on documents the composition pipeline
 * produced; a document without one renders through the frozen legacy path.
 */
const section = sectionSpecSchema.optional();

const heroBlock = z.object({
  type: z.literal('hero'),
  id: z.string(),
  variant,
  section,
  headline: localizedText(160),
  subheadline: localizedText(400),
  ctaLabel: localizedText(60),
  mediaId: z.string().optional(), // COVER media
});

const aboutBlock = z.object({
  type: z.literal('about'),
  id: z.string(),
  variant,
  section,
  heading: localizedText(120),
  body: localizedText(2000),
  mediaId: z.string().optional(),
});

const statsBlock = z.object({
  type: z.literal('stats'),
  id: z.string(),
  variant,
  section,
  heading: localizedText(120),
  items: z
    .array(z.object({ label: localizedText(60), value: z.string().max(40) }))
    .max(6),
});

const faqBlock = z.object({
  type: z.literal('faq'),
  id: z.string(),
  variant,
  section,
  heading: localizedText(120),
  items: z.array(z.object({ q: localizedText(200), a: localizedText(800) })).max(8),
});

const ctaBlock = z.object({
  type: z.literal('cta'),
  id: z.string(),
  variant,
  section,
  headline: localizedText(160),
  buttonLabel: localizedText(60),
});

// A display list item: bilingual (AI-curated, toggles with language) or a plain
// string (legacy documents / raw-fact fallback). The renderer handles both.
const listItem = (max: number) => z.union([z.string().max(max), localizedText(max)]);
export type ListItem = string | { ar: string; en: string };

// Skills / subjects shown as tags (from the teacher's facts).
const toolkitBlock = z.object({
  type: z.literal('toolkit'),
  id: z.string(),
  variant,
  section,
  heading: localizedText(120),
  items: z.array(listItem(60)).max(20),
});

// Achievements / credentials shown as an editorial "track record" list.
const credentialsBlock = z.object({
  type: z.literal('credentials'),
  id: z.string(),
  variant,
  section,
  heading: localizedText(120),
  items: z.array(listItem(240)).max(12),
});

// Live data blocks: config only, resolved at render.
const coursesBlock = z.object({
  type: z.literal('courses'),
  id: z.string(),
  variant,
  section,
  heading: localizedText(120),
  mode: z.literal('auto'),
  limit: z.number().int().min(1).max(24),
});

const reviewsBlock = z.object({
  type: z.literal('reviews'),
  id: z.string(),
  variant,
  section,
  heading: localizedText(120),
  mode: z.literal('auto'),
  limit: z.number().int().min(1).max(24),
});

const galleryBlock = z.object({
  type: z.literal('gallery'),
  id: z.string(),
  variant,
  section,
  heading: localizedText(120),
  mediaIds: z.array(z.string()).max(12),
});

const contactBlock = z.object({
  type: z.literal('contact'),
  id: z.string(),
  variant,
  section,
  heading: localizedText(120),
  socials: z
    .array(z.object({ platform: z.string().max(30), url: z.string().url().max(300) }))
    .max(10),
});

/**
 * A dated or ordered track record: study, posts held, results delivered. A list
 * of achievements says the same things a timeline does, but a timeline says them
 * as a career, which is the argument an experienced teacher is actually making.
 */
const timelineBlock = z.object({
  type: z.literal('timeline'),
  id: z.string(),
  variant,
  section,
  heading: localizedText(120),
  items: z
    .array(
      z.object({
        marker: localizedText(24), // a year, a stage, a number
        title: localizedText(120),
        body: localizedText(400),
      }),
    )
    .max(10),
});

/** How the teaching actually works, as ordered steps. Answers "what happens if I enrol?" */
const processBlock = z.object({
  type: z.literal('process'),
  id: z.string(),
  variant,
  section,
  heading: localizedText(120),
  steps: z.array(z.object({ title: localizedText(120), body: localizedText(400) })).max(8),
});

/** One sentence, set large. The cheapest way to give a page a moment of quiet. */
const quoteBlock = z.object({
  type: z.literal('quote'),
  id: z.string(),
  variant,
  section,
  text: localizedText(400),
  attribution: localizedText(80),
});

export const siteBlockSchema = z.discriminatedUnion('type', [
  heroBlock,
  aboutBlock,
  statsBlock,
  toolkitBlock,
  credentialsBlock,
  faqBlock,
  ctaBlock,
  coursesBlock,
  reviewsBlock,
  galleryBlock,
  contactBlock,
  timelineBlock,
  processBlock,
  quoteBlock,
]);

export const SITE_STYLES = ['modern', 'bold', 'elegant', 'minimal', 'playful'] as const;
// Design preset (from the chosen vibe) — drives a distinct visual identity.
export const SITE_PRESETS = ['warm', 'academic', 'premium', 'energetic'] as const;

export const SITE_HEADING_FONTS = ['sans', 'serif', 'display'] as const;

export const siteThemeSchema = z.object({
  primary: z.string().regex(HEX),
  accent: z.string().regex(HEX),
  logoMediaId: z.string().optional(),
  style: z.enum(SITE_STYLES).optional(),
  preset: z.enum(SITE_PRESETS).optional(),
  // Heading typeface treatment, chosen by the Design DNA.
  headingFont: z.enum(SITE_HEADING_FONTS).optional(),
  // The Design DNA key that produced this theme (for evolution / diagnostics).
  dna: z.string().max(40).optional(),
  // The teacher archetype the strategist inferred (drives section order; kept
  // for evolution / re-arrangement on edit).
  archetype: z.string().max(40).optional(),
  // Default language the compiled page opens in (visitor can still toggle).
  defaultLang: z.enum(['ar', 'en']).optional(),

  /**
   * A design system composed by the model for THIS academy, rather than a preset
   * picked from a catalogue of five.
   *
   * The catalogue guaranteed a competent look and an identical one: two academies
   * that landed on the same DNA were pixel-identical. These fields let the model
   * choose its own surface mood, ink, typography, geometry and rhythm, so the
   * output differs every time.
   *
   * Every value is constrained and validated. The model never emits markup, CSS
   * or script — only tokens the compiler renders — so a hostile or malformed
   * response can change how the page looks and can do nothing else. When the
   * field is absent (older documents, or a response that failed validation) the
   * Design DNA still supplies the look, unchanged.
   */
  design: z
    .object({
      /** Page background. Drives whether the whole page reads light or dark. */
      background: z.string().regex(HEX),
      /** Body text colour. The rules engine checks it against the background. */
      ink: z.string().regex(HEX),
      /** Panels, cards and section bands. */
      surface: z.string().regex(HEX),
      /** Corner radius in px. 0 = hard-edged brutalist, 28 = very soft. */
      radius: z.number().int().min(0).max(28),
      /** Vertical rhythm: how much air the sections breathe. */
      density: z.enum(['compact', 'regular', 'airy']),
      /** Headline weight/scale personality. */
      headingScale: z.enum(['restrained', 'balanced', 'dramatic']),
      /** Background treatment behind the hero. */
      heroTreatment: z.enum(['flat', 'gradient', 'mesh', 'spotlight']),
      /** Body typeface. Headings keep their own (serif/sans/display) choice. */
      bodyFont: z.enum(['sans', 'serif', 'mono']).optional(),
      /**
       * How much the page moves. The renderer owns *what* animates — the model
       * only says how far to push it, because an unconstrained brief produces
       * either a dead page or one that will not sit still long enough to read.
       */
      motion: z.enum(['calm', 'lively', 'cinematic']).optional(),
    })
    .optional(),

  /**
   * Site Document v3: the full design system composed for this academy.
   *
   * Where `design` above is a palette plus six knobs bolted onto a fixed
   * stylesheet, this is the stylesheet — colour, type, geometry, rhythm, motion
   * and decoration, all chosen per academy and all rendered by modules the
   * compiler emits only when they are used.
   *
   * Its presence is what routes a document to the composition renderer. A
   * document without it keeps the frozen legacy renderer, byte for byte, which
   * is what lets every page published so far go on looking exactly as approved.
   */
  designSpec: designSpecSchema.optional(),
});

export const siteSeoSchema = z.object({
  title: localizedText(70),
  description: localizedText(160),
});

/** The renderer generation a document was designed against. */
export const RENDERER_LEGACY = 1;
export const RENDERER_COMPOSITION = 2;

export const siteDocumentSchema = z.object({
  version: z.literal(1),
  theme: siteThemeSchema,
  // Optional so documents generated before SEO existed still validate.
  seo: siteSeoSchema.optional(),
  /**
   * Which compiler generation this document was designed against.
   *
   * Published pages are compiled HTML frozen at publish time, so upgrading the
   * renderer repaints pages a teacher already approved. Stamping the generation
   * makes that an explicit decision — a document always compiles the way it was
   * designed until something deliberately moves it forward.
   */
  renderer: z.object({ version: z.number().int().min(1).max(9) }).optional(),
  /** What this generation looked like, on the axes evolution reasons about. */
  fingerprint: fingerprintSchema.optional(),
  /** One line from the model on why it designed the page this way (never rendered). */
  rationale: z.string().max(400).optional(),
  blocks: z.array(siteBlockSchema).min(1).max(24),
});

export type SiteBlock = z.infer<typeof siteBlockSchema>;
export type SiteTheme = z.infer<typeof siteThemeSchema>;
export type SiteSeo = z.infer<typeof siteSeoSchema>;
export type SiteDocument = z.infer<typeof siteDocumentSchema>;
export type BlockType = SiteBlock['type'];

export interface SiteDocParseResult {
  success: boolean;
  data?: SiteDocument;
  errors?: string[];
}

/** Validate an untrusted object as a Site Document, returning field-path errors. */
export function parseSiteDocument(input: unknown): SiteDocParseResult {
  const res = siteDocumentSchema.safeParse(input);
  if (res.success) return { success: true, data: res.data };
  return {
    success: false,
    errors: res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}
