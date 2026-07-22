/**
 * Strict JSON Schema for the AI copy, used with OpenAI Structured Outputs so the
 * model is constrained to return exactly this shape (no free-form JSON parsing).
 *
 * It mirrors `aiCopySchema` (zod) structurally. Length caps are intentionally
 * NOT encoded here — they are enforced afterwards by the zod schema
 * (parseAiCopy), keeping this JSON Schema within the guaranteed-supported strict
 * subset (types, required, additionalProperties) so schema registration never
 * fails. Every object sets additionalProperties:false and lists all properties
 * as required, as strict mode requires.
 */

const localizedText = {
  type: 'object',
  additionalProperties: false,
  required: ['ar', 'en'],
  properties: { ar: { type: 'string' }, en: { type: 'string' } },
} as const;

export const AI_COPY_SCHEMA_NAME = 'academy_copy';

export const aiCopyJsonSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['hero', 'about', 'faq', 'cta'],
  properties: {
    hero: {
      type: 'object',
      additionalProperties: false,
      required: ['headline', 'subheadline', 'ctaLabel'],
      properties: { headline: localizedText, subheadline: localizedText, ctaLabel: localizedText },
    },
    about: {
      type: 'object',
      additionalProperties: false,
      required: ['heading', 'body'],
      properties: { heading: localizedText, body: localizedText },
    },
    faq: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['q', 'a'],
        properties: { q: localizedText, a: localizedText },
      },
    },
    cta: {
      type: 'object',
      additionalProperties: false,
      required: ['headline', 'buttonLabel'],
      properties: { headline: localizedText, buttonLabel: localizedText },
    },
  },
};
