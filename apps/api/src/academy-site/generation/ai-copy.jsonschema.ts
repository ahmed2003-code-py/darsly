/**
 * Strict JSON Schema for the AI Generation copy (OpenAI Structured Outputs).
 * Mirrors `aiCopySchema` structurally. Length caps are enforced afterwards by
 * the zod schema (parseAiCopy), keeping this within the guaranteed-supported
 * strict subset. Every object sets additionalProperties:false and lists all
 * properties as required, as strict mode requires.
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
  required: ['seo', 'hero', 'about', 'toolkitHeading', 'highlights', 'credentialsHeading', 'credentials', 'faq', 'cta'],
  properties: {
    seo: {
      type: 'object',
      additionalProperties: false,
      required: ['metaTitle', 'metaDescription'],
      properties: { metaTitle: localizedText, metaDescription: localizedText },
    },
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
    toolkitHeading: localizedText,
    highlights: { type: 'array', items: localizedText },
    credentialsHeading: localizedText,
    credentials: { type: 'array', items: localizedText },
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
