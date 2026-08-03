import { z } from 'zod';
import { DESIGN_DNA_KEYS } from '../pipeline/design-dna';

/**
 * AI Planning output (stage 1). The model *proposes* a design direction and a
 * read of the teacher; it does not decide layout or write copy. The Rules
 * Engine validates this and the Site Brain turns it into render tokens.
 */
export const ARCHETYPES = [
  'programming',
  'math_science',
  'languages',
  'exam_prep',
  'university',
  'general',
] as const;

export type Archetype = (typeof ARCHETYPES)[number];

export const planningSchema = z.object({
  // Chosen from the curated Design DNA catalogue (not free-form).
  designDNA: z.enum(DESIGN_DNA_KEYS as [string, ...string[]]),
  // Brand colors the model proposes (honoured only when the teacher gave a
  // style brief; otherwise the academy's own brand colors win downstream).
  theme: z.object({
    primary: z.string(),
    accent: z.string(),
  }),
  // The teacher's archetype — flavours the copy and (Phase 4) the section order.
  archetype: z.enum(ARCHETYPES),
});

export type SitePlanAi = z.infer<typeof planningSchema>;

export function parseSitePlan(input: unknown): { data?: SitePlanAi; error?: string } {
  const res = planningSchema.safeParse(input);
  if (res.success) return { data: res.data };
  return { error: res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
}
