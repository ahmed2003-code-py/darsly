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
  required: ['designDNA', 'theme', 'archetype'],
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
  },
};
