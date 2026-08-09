import {
  ACCENT_MARKS, BACKDROPS, BODY_FAMILIES, CONTAINER_WIDTHS, DENSITIES, DIVIDERS, ENTRANCES,
  GUTTERS, HEADING_CASES, HEADING_FAMILIES, IMAGE_TREATMENTS, MEASURES, MOTION_INTENSITIES,
  PALETTE_MODES, RADIUS_STYLES, SCROLL_EFFECTS, SECTION_ALIGNS, SECTION_EMPHASIS,
  SECTION_RHYTHMS, SECTION_SURFACES, SHADOW_DEPTHS, TRACKINGS, TYPE_SCALES, BORDER_WEIGHTS,
} from '../schema/design-spec';
import { ARCHETYPES } from './planning.schema';
import { COMPOSABLE_SECTIONS } from './composition.schema';

/**
 * The strict JSON Schema the model is constrained to (OpenAI Structured
 * Outputs). Every enum is derived from the same constant the renderer and the
 * zod schema read, so adding a backdrop or a scroll effect reaches the model
 * without anyone remembering to update this file.
 *
 * Strict mode requires every property to appear in `required` and every object
 * to set `additionalProperties: false`. Optionality lives in the zod schema,
 * which is what actually guards the response.
 */

export const COMPOSITION_SCHEMA_NAME = 'academy_composition';

const enumOf = (values: readonly (string | number)[], description?: string) => ({
  type: typeof values[0] === 'number' ? 'number' : 'string',
  enum: [...values],
  ...(description ? { description } : {}),
});

const hex = (description: string) => ({ type: 'string', description: `${description} Six-digit hex, #RRGGBB.` });

const object = (properties: Record<string, unknown>, description?: string) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
  ...(description ? { description } : {}),
});

const designSchema = object({
  palette: object({
    background: hex('The page background. Decides whether the whole design reads light or dark.'),
    ink: hex('Body text. Must reach at least 7:1 contrast against the background.'),
    surface: hex('Cards and bands. A step away from the background, not a second theme.'),
    surfaceAlt: hex('A second surface for alternating sections and nested panels.'),
    primary: hex('The dominant brand colour: buttons and emphasis.'),
    accent: hex('The supporting colour: eyebrows, gradients, small marks.'),
    mode: enumOf(PALETTE_MODES, 'Which of the two you built. Be accurate — it is checked.'),
  }),
  typography: object({
    headingFamily: enumOf(HEADING_FAMILIES, 'condensed and display are loud; serif is scholarly; mono is technical.'),
    bodyFamily: enumOf(BODY_FAMILIES),
    scale: enumOf(TYPE_SCALES, 'How far headlines dominate. monumental is a real design choice, not a default.'),
    headingWeight: enumOf([400, 500, 600, 700, 800, 900]),
    headingCase: enumOf(HEADING_CASES),
    tracking: enumOf(TRACKINGS),
    measure: enumOf(MEASURES, 'How wide a paragraph runs.'),
  }),
  geometry: object({
    radius: { type: 'integer', minimum: 0, maximum: 32, description: '0–4 architectural, 10–16 contemporary, 24–32 friendly.' },
    radiusStyle: enumOf(RADIUS_STYLES),
    border: enumOf(BORDER_WEIGHTS),
    shadow: enumOf(SHADOW_DEPTHS, 'brutal is a hard offset with no blur; it needs a border and a small radius.'),
    grain: { type: 'boolean', description: 'Film grain. Expensive on a dark page; it is removed from light ones.' },
  }),
  rhythm: object({
    density: enumOf(DENSITIES),
    sectionRhythm: enumOf(SECTION_RHYTHMS, 'even, alternating bands, or opening up as the page scrolls.'),
    containerWidth: enumOf(CONTAINER_WIDTHS),
    gutter: enumOf(GUTTERS),
  }),
  motion: object({
    intensity: enumOf(MOTION_INTENSITIES, 'How far the page moves. All three animate; they differ in amplitude.'),
    entrance: enumOf(ENTRANCES, 'How a section arrives when it scrolls into view.'),
    scrollFx: {
      type: 'array',
      maxItems: 3,
      items: enumOf(SCROLL_EFFECTS),
      description: 'At most three. More than three is trimmed.',
    },
  }),
  decoration: object({
    backdrop: enumOf(BACKDROPS, 'The atmosphere behind the whole page. The biggest single lever on how it feels.'),
    accents: { type: 'array', maxItems: 3, items: enumOf(ACCENT_MARKS), description: 'Recurring marks that give the page a signature. At most three.' },
    dividers: enumOf(DIVIDERS),
    imageTreatment: enumOf(IMAGE_TREATMENTS),
  }),
});

const sectionSchema = object({
  type: enumOf(COMPOSABLE_SECTIONS),
  pattern: { type: 'string', description: 'A pattern id from the catalogue in the brief, e.g. "hero.split-portrait".' },
  emphasis: enumOf(SECTION_EMPHASIS, 'quiet shrinks the section, feature enlarges it.'),
  width: enumOf(CONTAINER_WIDTHS),
  surface: enumOf(SECTION_SURFACES, 'The band this section sits on. Vary it — a page of identical bands reads as one long scroll.'),
  align: enumOf(SECTION_ALIGNS),
  columns: { type: 'integer', minimum: 1, maximum: 4 },
  accents: { type: 'array', maxItems: 2, items: enumOf(ACCENT_MARKS) },
  imageTreatment: enumOf(IMAGE_TREATMENTS),
});

export const compositionJsonSchema: Record<string, unknown> = object({
  archetype: enumOf(ARCHETYPES),
  design: designSchema,
  sections: {
    type: 'array',
    minItems: 3,
    maxItems: 14,
    items: sectionSchema,
    description: 'The page, in order. The first must be the hero. Include only sections the content supports.',
  },
  content: object({
    statCount: { type: 'integer', minimum: 0, maximum: 6, description: 'Figures to write. 0 if the facts contain no real numbers.' },
    timelineCount: { type: 'integer', minimum: 0, maximum: 8 },
    processCount: { type: 'integer', minimum: 0, maximum: 6 },
    faqCount: { type: 'integer', minimum: 0, maximum: 6 },
    includeQuote: { type: 'boolean' },
  }),
  rationale: { type: 'string', description: 'One sentence on why this design suits this teacher. Under 300 characters.' },
});
