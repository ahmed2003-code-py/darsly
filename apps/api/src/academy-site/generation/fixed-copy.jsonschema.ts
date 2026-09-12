/**
 * Strict JSON Schema for the fixed-template copy call (OpenAI Structured
 * Outputs). Mirrors `fixedCopySchema` structurally — see `ai-copy.jsonschema.ts`
 * for why every object is `additionalProperties:false` with every key required.
 */

const localizedText = {
  type: 'object',
  additionalProperties: false,
  required: ['ar', 'en'],
  properties: { ar: { type: 'string' }, en: { type: 'string' } },
} as const;

export const FIXED_COPY_SCHEMA_NAME = 'academy_fixed_copy';

export const fixedCopyJsonSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'seo', 'hero', 'about', 'toolkitHeading', 'highlights',
    'credentialsHeading', 'credentials', 'process', 'faq', 'quote',
  ],
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
    highlights: {
      type: 'array',
      description: 'Curated skill/topic tags, 2-4 words each. Exactly 6 if the facts support it.',
      items: localizedText,
    },
    credentialsHeading: localizedText,
    credentials: {
      type: 'array',
      description: 'Concise one-line achievements. Exactly 6 if the facts support it.',
      items: localizedText,
    },
    process: {
      type: 'array',
      description: 'EXACTLY 3 steps describing what happens when a student enrols — placement, lesson rhythm, follow-up.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'body'],
        properties: { title: localizedText, body: localizedText },
      },
    },
    faq: {
      type: 'array',
      description: 'EXACTLY 3 questions a real Egyptian parent or student would ask.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['q', 'a'],
        properties: { q: localizedText, a: localizedText },
      },
    },
    quote: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'attribution'],
      properties: { text: localizedText, attribution: localizedText },
      description:
        'One sentence, under 20 words, in the teacher\'s own voice about how they teach. Empty strings if nothing genuine comes to mind — never a generic filler.',
    },
  },
};
