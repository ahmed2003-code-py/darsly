import { z } from 'zod';
import { localizedText } from '../schema/site-document';

/**
 * The exact JSON shape the model must return. Kept separate from the Site
 * Document: the model only writes prose; the pipeline assembles blocks, wires
 * media and live-data blocks, and applies the brand deterministically.
 */
export const STYLES = ['modern', 'bold', 'elegant', 'minimal', 'playful'] as const;

export const aiCopySchema = z.object({
  // Design direction chosen by the model from the teacher's style brief.
  theme: z.object({
    primary: z.string(),
    accent: z.string(),
    style: z.enum(STYLES),
  }),
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
  faq: z
    .array(z.object({ q: localizedText(200), a: localizedText(800) }))
    .min(1)
    .max(6),
  cta: z.object({
    headline: localizedText(160),
    buttonLabel: localizedText(60),
  }),
});

export type AiCopy = z.infer<typeof aiCopySchema>;

export function parseAiCopy(input: unknown): { data?: AiCopy; error?: string } {
  const res = aiCopySchema.safeParse(input);
  if (res.success) return { data: res.data };
  return { error: res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
}
