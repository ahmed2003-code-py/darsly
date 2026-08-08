import { ARCHETYPES } from './planning.schema';
import { DESIGN_DNA_KEYS } from '../pipeline/design-dna';

/**
 * Strict JSON Schema for the Planning stage (OpenAI Structured Outputs). Mirrors
 * planningSchema. Enums are derived from the DNA/archetype catalogues so this
 * stays in sync automatically.
 */
export const PLANNING_SCHEMA_NAME = 'academy_plan';

export const planningJsonSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['designDNA', 'theme', 'archetype', 'design'],
  properties: {
    designDNA: { type: 'string', enum: [...DESIGN_DNA_KEYS] },
    theme: {
      type: 'object',
      additionalProperties: false,
      required: ['primary', 'accent'],
      properties: {
        primary: { type: 'string' },
        accent: { type: 'string' },
      },
    },
    archetype: { type: 'string', enum: [...ARCHETYPES] },
    // The model composes its own visual system here. Constrained values only —
    // it never emits markup, CSS or script, so a hostile response can change how
    // the page looks and nothing else.
    design: {
      type: 'object',
      additionalProperties: false,
      // OpenAI's structured-output mode requires every key in `properties` to be
      // listed here — an optional field is rejected outright with a 400, not
      // silently ignored. Optionality lives in the zod schema instead, which is
      // what actually guards the response.
      required: ['background', 'ink', 'surface', 'radius', 'density', 'headingScale', 'heroTreatment', 'bodyFont'],
      properties: {
        background: { type: 'string', description: 'Page background, #RRGGBB. Dark or light — your call.' },
        ink: { type: 'string', description: 'Body text colour, #RRGGBB. Must be legible on the background.' },
        surface: { type: 'string', description: 'Cards and section bands, #RRGGBB. Close to the background.' },
        radius: { type: 'integer', minimum: 0, maximum: 28, description: '0 = hard-edged, 28 = very soft.' },
        density: { type: 'string', enum: ['compact', 'regular', 'airy'] },
        headingScale: { type: 'string', enum: ['restrained', 'balanced', 'dramatic'] },
        heroTreatment: { type: 'string', enum: ['flat', 'gradient', 'mesh', 'spotlight'] },
        bodyFont: { type: 'string', enum: ['sans', 'serif', 'mono'] },
      },
    },
  },
};
