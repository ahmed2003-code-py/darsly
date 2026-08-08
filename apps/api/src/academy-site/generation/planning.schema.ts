import { z } from 'zod';
import { DESIGN_DNA_KEYS } from '../pipeline/design-dna';

/** Six-digit hex, the only colour form the compiler accepts. */
const HEX = /^#[0-9a-fA-F]{6}$/;

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

  /**
   * The model's own design system for this academy.
   *
   * Optional on purpose: a response that omits it, or emits something outside
   * these bounds, falls back to the chosen Design DNA and still renders a
   * competent page. That keeps a bad generation from producing a broken site
   * while letting a good one produce a site no catalogue could.
   */
  design: z
    .object({
      background: z.string().regex(HEX),
      ink: z.string().regex(HEX),
      surface: z.string().regex(HEX),
      radius: z.number().int().min(0).max(28),
      density: z.enum(['compact', 'regular', 'airy']),
      headingScale: z.enum(['restrained', 'balanced', 'dramatic']),
      heroTreatment: z.enum(['flat', 'gradient', 'mesh', 'spotlight']),
      bodyFont: z.enum(['sans', 'serif', 'mono']).optional(),
      motion: z.enum(['calm', 'lively', 'cinematic']).optional(),
    })
    .optional(),
});

export type SitePlanAi = z.infer<typeof planningSchema>;

export function parseSitePlan(input: unknown): { data?: SitePlanAi; error?: string } {
  const res = planningSchema.safeParse(input);
  if (res.success) return { data: res.data };
  return { error: res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
}
