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

/**
 * The sections the composition stage can now place also need writing. Strict
 * mode requires every property to be listed as required, so the model is asked
 * for all of them and the plan's `content` counts decide what is actually used —
 * an empty array is a perfectly good answer to "write zero statistics".
 */
export const aiCopyJsonSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'seo', 'hero', 'about', 'toolkitHeading', 'highlights', 'credentialsHeading', 'credentials',
    'faq', 'cta', 'stats', 'statsHeading', 'timeline', 'timelineHeading', 'process',
    'processHeading', 'quote',
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
    statsHeading: localizedText,
    stats: {
      type: 'array',
      description: 'Figures grounded in the FACTS. Never invent one. Empty array if there are none.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'value'],
        properties: { label: localizedText, value: { type: 'string', description: 'e.g. "12", "400+", "4.9/5"' } },
      },
    },
    timelineHeading: localizedText,
    timeline: {
      type: 'array',
      description: 'The teacher\'s journey, oldest first. marker is a year or a stage.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['marker', 'title', 'body'],
        properties: { marker: localizedText, title: localizedText, body: localizedText },
      },
    },
    processHeading: localizedText,
    process: {
      type: 'array',
      description: 'What actually happens when a student enrols, in order.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'body'],
        properties: { title: localizedText, body: localizedText },
      },
    },
    quote: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'attribution'],
      properties: { text: localizedText, attribution: localizedText },
      description: 'One sentence in the teacher\'s own voice about how they teach.',
    },
  },
};
