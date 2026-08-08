import { SiteBlock } from '../../schema/site-document';
import { RenderContext, VariantContext } from '../types';

/**
 * The Variant Registry — an open catalogue of section renderers keyed by
 * `(blockType, variantId)`. Adding a new premium layout later (e.g. `hero_11`)
 * is a single `registerVariant('hero', 'hero_11', fn, meta)` call: the pipeline,
 * the Site Brain and the AI prompts discover variants from here and never change.
 *
 * The first variant registered for a type is its default (used when a block
 * carries no explicit variant, or an unknown one).
 */
export type VariantRenderer = (block: SiteBlock, ctx: VariantContext) => string;

/** Everything the Site Brain knows when it scores variants for selection. */
export interface VariantSelectionContext {
  dna: string;
  archetype: string;
  preset: string;
  hasHeroImage: boolean;
  hasAboutImage: boolean;
  bioLength: number;
  subjectsCount: number;
  achievementsCount: number;
  galleryCount: number;
}

export interface VariantMeta {
  /**
   * Fit score for this variant in a given context (higher = better). The Site
   * Brain picks the highest-scoring variant. Return a large negative number to
   * disqualify. Omitted → a neutral baseline of 0.5.
   */
  score?: (ctx: VariantSelectionContext) => number;
}

interface Entry {
  render: VariantRenderer;
  meta: VariantMeta;
}

const REGISTRY = new Map<string, Map<string, Entry>>();
const DEFAULTS = new Map<string, string>();

export function registerVariant(type: string, id: string, render: VariantRenderer, meta: VariantMeta = {}): void {
  let byId = REGISTRY.get(type);
  if (!byId) {
    byId = new Map();
    REGISTRY.set(type, byId);
  }
  byId.set(id, { render, meta });
  if (!DEFAULTS.has(type)) DEFAULTS.set(type, id);
}

export function defaultVariantId(type: string): string | undefined {
  return DEFAULTS.get(type);
}

/** Resolve a requested variant to one that actually exists, else the default. */
export function resolveVariantId(type: string, requested?: string): string {
  const byId = REGISTRY.get(type);
  if (requested && byId?.has(requested)) return requested;
  return DEFAULTS.get(type) ?? requested ?? '';
}

export function getVariantRenderer(type: string, id?: string): VariantRenderer | undefined {
  const byId = REGISTRY.get(type);
  if (!byId) return undefined;
  const resolved = id && byId.has(id) ? id : DEFAULTS.get(type);
  return resolved ? byId.get(resolved)?.render : undefined;
}

/** All variant ids registered for a section type (registration order). */
export function listVariants(type: string): string[] {
  return Array.from(REGISTRY.get(type)?.keys() ?? []);
}

/**
 * Pick the best variant id for a block type in the given context. Scores every
 * registered variant and returns the highest; ties break by registration order
 * (so the default wins a tie). Falls back to the default when the type has no
 * registered variants scored above disqualification.
 */
export function selectVariant(type: string, ctx: VariantSelectionContext): string {
  const byId = REGISTRY.get(type);
  const fallback = DEFAULTS.get(type) ?? '';
  if (!byId || byId.size === 0) return fallback;
  let bestId = fallback;
  let bestScore = -Infinity;
  for (const [id, entry] of byId) {
    const s = entry.meta.score ? entry.meta.score(ctx) : 0.5;
    if (s > bestScore) {
      bestScore = s;
      bestId = id;
    }
  }
  return bestId;
}
