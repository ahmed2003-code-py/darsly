import { z } from 'zod';

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

const heroBlock = z.object({
  type: z.literal('hero'),
  id: z.string(),
  headline: localizedText(160),
  subheadline: localizedText(400),
  ctaLabel: localizedText(60),
  mediaId: z.string().optional(), // COVER media
});

const aboutBlock = z.object({
  type: z.literal('about'),
  id: z.string(),
  heading: localizedText(120),
  body: localizedText(2000),
  mediaId: z.string().optional(),
});

const statsBlock = z.object({
  type: z.literal('stats'),
  id: z.string(),
  heading: localizedText(120),
  items: z
    .array(z.object({ label: localizedText(60), value: z.string().max(40) }))
    .max(6),
});

const faqBlock = z.object({
  type: z.literal('faq'),
  id: z.string(),
  heading: localizedText(120),
  items: z.array(z.object({ q: localizedText(200), a: localizedText(800) })).max(8),
});

const ctaBlock = z.object({
  type: z.literal('cta'),
  id: z.string(),
  headline: localizedText(160),
  buttonLabel: localizedText(60),
});

// Live data blocks: config only, resolved at render.
const coursesBlock = z.object({
  type: z.literal('courses'),
  id: z.string(),
  heading: localizedText(120),
  mode: z.literal('auto'),
  limit: z.number().int().min(1).max(24),
});

const reviewsBlock = z.object({
  type: z.literal('reviews'),
  id: z.string(),
  heading: localizedText(120),
  mode: z.literal('auto'),
  limit: z.number().int().min(1).max(24),
});

const galleryBlock = z.object({
  type: z.literal('gallery'),
  id: z.string(),
  heading: localizedText(120),
  mediaIds: z.array(z.string()).max(12),
});

const contactBlock = z.object({
  type: z.literal('contact'),
  id: z.string(),
  heading: localizedText(120),
  socials: z
    .array(z.object({ platform: z.string().max(30), url: z.string().url().max(300) }))
    .max(10),
});

export const siteBlockSchema = z.discriminatedUnion('type', [
  heroBlock,
  aboutBlock,
  statsBlock,
  faqBlock,
  ctaBlock,
  coursesBlock,
  reviewsBlock,
  galleryBlock,
  contactBlock,
]);

export const siteThemeSchema = z.object({
  primary: z.string().regex(HEX),
  accent: z.string().regex(HEX),
  logoMediaId: z.string().optional(),
});

export const siteSeoSchema = z.object({
  title: localizedText(70),
  description: localizedText(160),
});

export const siteDocumentSchema = z.object({
  version: z.literal(1),
  theme: siteThemeSchema,
  // Optional so documents generated before SEO existed still validate.
  seo: siteSeoSchema.optional(),
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
