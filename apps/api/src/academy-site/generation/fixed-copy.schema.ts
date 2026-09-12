import { z } from 'zod';
import { localizedText } from '../schema/site-document';

/**
 * The copy call for the fixed template — leaner than `ai-copy.schema.ts`: no
 * `cta`, `stats` or `timeline`, because the fixed page has no slot for them.
 * `process` and `quote` are asked for directly (the composed pipeline only
 * wrote these when a layout decision asked for them; here the layout is
 * always the same, so the ask is unconditional).
 */
export const fixedCopySchema = z.object({
  seo: z.object({ metaTitle: localizedText(70), metaDescription: localizedText(160) }),
  hero: z.object({ headline: localizedText(160), subheadline: localizedText(400), ctaLabel: localizedText(60) }),
  about: z.object({ heading: localizedText(120), body: localizedText(2000) }),
  toolkitHeading: localizedText(120),
  highlights: z.array(localizedText(60)).max(12),
  credentialsHeading: localizedText(120),
  credentials: z.array(localizedText(200)).max(10),
  // Exactly three in the fixed template; a couple extra is harmless, the
  // assembler slices.
  process: z.array(z.object({ title: localizedText(120), body: localizedText(400) })).max(5),
  faq: z.array(z.object({ q: localizedText(200), a: localizedText(800) })).min(1).max(5),
  // One sentence in the teacher's own voice. Optional: omitted rather than
  // fabricated when the facts give the model nothing genuine to draw on.
  quote: z.object({ text: localizedText(400), attribution: localizedText(80) }).optional(),
});

export type FixedCopy = z.infer<typeof fixedCopySchema>;

export function parseFixedCopy(input: unknown): { data?: FixedCopy; error?: string } {
  const res = fixedCopySchema.safeParse(input);
  if (res.success) return { data: res.data };
  return { error: res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
}
