import { SiteBlock } from '../../schema/site-document';
import { RenderContext } from '../types';

/**
 * The Variant Registry — an open catalogue of section renderers keyed by
 * `(blockType, variantId)`. Adding a new premium layout later (e.g. `hero_11`)
 * is a single `registerVariant('hero', 'hero_11', fn)` call: the pipeline, the
 * Site Brain and the AI prompts discover variants from here and never change.
 *
 * The first variant registered for a type is its default (used when a block
 * carries no explicit variant, or an unknown one).
 */
export type VariantRenderer = (block: SiteBlock, ctx: RenderContext) => string;

const REGISTRY = new Map<string, Map<string, VariantRenderer>>();
const DEFAULTS = new Map<string, string>();

export function registerVariant(type: string, id: string, render: VariantRenderer): void {
  let byId = REGISTRY.get(type);
  if (!byId) {
    byId = new Map();
    REGISTRY.set(type, byId);
  }
  byId.set(id, render);
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
  return resolved ? byId.get(resolved) : undefined;
}

/** All variant ids registered for a section type (registration order). */
export function listVariants(type: string): string[] {
  return Array.from(REGISTRY.get(type)?.keys() ?? []);
}
