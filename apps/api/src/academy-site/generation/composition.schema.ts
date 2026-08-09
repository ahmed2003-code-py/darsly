import { z } from 'zod';
import {
  ACCENT_MARKS, CONTAINER_WIDTHS, IMAGE_TREATMENTS, SECTION_ALIGNS, SECTION_EMPHASIS,
  SECTION_SURFACES, designSpecSchema,
} from '../schema/design-spec';
import { ARCHETYPES } from './planning.schema';

/**
 * What the planning model now produces.
 *
 * It used to choose a catalogue entry, two colours and six enums, and everything
 * else about the page was decided by a fixed stylesheet. It now composes the
 * whole visual system *and* the page itself: which sections exist, in what
 * order, laid out by which pattern, on which band, at what emphasis.
 *
 * What it still cannot do is unchanged, and is the reason it can be given this
 * much freedom: there is no field here that can hold markup, CSS, a class name,
 * a script or a URL. Every value is an enum, a bounded integer, a hex colour or
 * the id of something the platform already built.
 */

/** The sections a composition may place. Live ones resolve at view time. */
export const COMPOSABLE_SECTIONS = [
  'hero', 'about', 'toolkit', 'credentials', 'stats', 'timeline', 'process',
  'quote', 'courses', 'gallery', 'reviews', 'faq', 'contact', 'cta',
] as const;

export type ComposableSection = (typeof COMPOSABLE_SECTIONS)[number];

export const composedSectionSchema = z.object({
  type: z.enum(COMPOSABLE_SECTIONS),
  /** A pattern id from the catalogue the prompt listed. Unknown ids degrade. */
  pattern: z.string().max(60),
  emphasis: z.enum(SECTION_EMPHASIS),
  width: z.enum(CONTAINER_WIDTHS),
  surface: z.enum(SECTION_SURFACES),
  align: z.enum(SECTION_ALIGNS),
  columns: z.number().int().min(1).max(4),
  accents: z.array(z.enum(ACCENT_MARKS)).max(2),
  imageTreatment: z.enum(IMAGE_TREATMENTS),
});

export type ComposedSection = z.infer<typeof composedSectionSchema>;

/**
 * How much writing the page needs.
 *
 * The copy stage runs after this one, so the composition is what tells it how
 * many statistics, timeline entries and method steps to write. Asking for a
 * timeline and then not writing one is the failure this prevents.
 */
export const contentPlanSchema = z.object({
  statCount: z.number().int().min(0).max(6),
  timelineCount: z.number().int().min(0).max(8),
  processCount: z.number().int().min(0).max(6),
  faqCount: z.number().int().min(0).max(6),
  includeQuote: z.boolean(),
});

export type ContentPlan = z.infer<typeof contentPlanSchema>;

export const compositionSchema = z.object({
  archetype: z.enum(ARCHETYPES),
  design: designSpecSchema,
  sections: z.array(composedSectionSchema).min(3).max(14),
  content: contentPlanSchema,
  /** One line on the thinking. Stored and shown in the Studio; never rendered. */
  rationale: z.string().max(400),
});

export type SiteComposition = z.infer<typeof compositionSchema>;

export function parseComposition(input: unknown): { data?: SiteComposition; error?: string } {
  const res = compositionSchema.safeParse(input);
  if (res.success) return { data: res.data };
  return { error: res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
}
