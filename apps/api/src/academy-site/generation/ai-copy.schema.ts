import { z } from 'zod';
import { localizedText } from '../schema/site-document';

/**
 * The AI Generation output (stage 2): content only. The design direction is
 * already fixed by the Planning stage, so this schema no longer carries a theme.
 * The model writes prose AND curates the teacher's raw facts into clean,
 * bilingual, display-ready lists (skills + one-line credentials) — replacing the
 * old "dump raw facts" behaviour.
 */
export const aiCopySchema = z.object({
  seo: z.object({
    metaTitle: localizedText(70),
    metaDescription: localizedText(160),
  }),
  hero: z.object({
    headline: localizedText(160),
    subheadline: localizedText(400),
    ctaLabel: localizedText(60),
  }),
  about: z.object({
    heading: localizedText(120),
    body: localizedText(2000),
  }),
  // Curated skills/topics (from the teacher's subjects) — clean noun phrases.
  toolkitHeading: localizedText(120),
  highlights: z.array(localizedText(60)).max(12),
  // Curated achievements as concise, scannable one-liners.
  credentialsHeading: localizedText(120),
  credentials: z.array(localizedText(200)).max(10),
  faq: z
    .array(z.object({ q: localizedText(200), a: localizedText(800) }))
    .min(1)
    .max(6),
  cta: z.object({
    headline: localizedText(160),
    buttonLabel: localizedText(60),
  }),

  /**
   * Content for the sections the composition may now place.
   *
   * All optional: a composition that asked for no timeline gets none, and a
   * response written before these existed still validates. The planning stage
   * says how many of each to write, so the writer is never guessing.
   */
  stats: z
    .array(z.object({ label: localizedText(60), value: z.string().max(40) }))
    .max(6)
    .optional(),
  timeline: z
    .array(
      z.object({
        marker: localizedText(24),
        title: localizedText(120),
        body: localizedText(400),
      }),
    )
    .max(8)
    .optional(),
  process: z
    .array(z.object({ title: localizedText(120), body: localizedText(400) }))
    .max(6)
    .optional(),
  timelineHeading: localizedText(120).optional(),
  processHeading: localizedText(120).optional(),
  statsHeading: localizedText(120).optional(),
  quote: z.object({ text: localizedText(400), attribution: localizedText(80) }).optional(),
});

export type AiCopy = z.infer<typeof aiCopySchema>;

export function parseAiCopy(input: unknown): { data?: AiCopy; error?: string } {
  const res = aiCopySchema.safeParse(input);
  if (res.success) return { data: res.data };
  return { error: res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
}
