import { SiteBlock } from '../../schema/site-document';
import { SectionSpec } from '../../schema/design-spec';
import { ComposeContext } from './types';

/**
 * The Pattern Registry.
 *
 * A pattern is one hand-built way to lay out one kind of section: a bento hero,
 * a credentials timeline, a course rail. It owns its markup, its stylesheet and
 * the conditions under which it is worth using — and the compiler emits its CSS
 * only on pages that actually use it, so a quiet typographic page does not ship
 * the stylesheet for a mosaic it never renders.
 *
 * This is deliberately a *second* registry, separate from `renderer/variants`.
 * That one is frozen: it renders every page published before the composition
 * pipeline existed, and it must go on producing the same bytes forever. Keeping
 * them apart is what makes it safe to change anything here.
 *
 * Adding a pattern is one `registerPattern()` call. Nothing in the pipeline, the
 * prompts or the Site Brain needs to know it exists — they all read this.
 */

export interface PatternContentNeeds {
  /** Minimum items/entries the section must have for this pattern to be honest. */
  items?: number;
  /** Requires a usable image on the block itself. */
  media?: boolean;
  /** Requires at least this many gallery images. */
  gallery?: number;
  /** Requires at least this much body text (characters). */
  text?: number;
  /** Requires at least this many published courses. */
  courses?: number;
  /** Requires at least this many reviews. */
  reviews?: number;
}

export interface PatternDefinition {
  /** Namespaced id, e.g. `hero.split-portrait`. */
  id: string;
  /** The block type this pattern lays out. */
  section: SiteBlock['type'];
  /** A one-line brief shown to the planning model. */
  brief: string;
  /** What the section needs before this pattern is a good idea. */
  needs?: PatternContentNeeds;
  /** Per-archetype preference. Missing archetypes score 1. */
  weight?: Partial<Record<string, number>>;
  /** Baseline preference among patterns for the same section. */
  base?: number;
  /** This pattern's stylesheet, emitted once per page that uses it. */
  css: () => string;
  /** Client behaviours this pattern needs, resolved against the effect registry. */
  js?: string[];
  /** Whether the pattern can carry a full-bleed container. */
  fullBleed?: boolean;
  render: (block: SiteBlock, spec: ResolvedSection, ctx: ComposeContext) => string;
}

/** A section spec with every optional filled in by the Site Brain. */
export interface ResolvedSection extends Required<Omit<SectionSpec, 'columns' | 'accents' | 'imageTreatment'>> {
  columns: number;
  accents: NonNullable<SectionSpec['accents']>;
  imageTreatment: NonNullable<SectionSpec['imageTreatment']>;
  /** Position on the page, so patterns can respond to the section rhythm. */
  index: number;
}

const BY_SECTION = new Map<string, PatternDefinition[]>();
const BY_ID = new Map<string, PatternDefinition>();

export function registerPattern(def: PatternDefinition): void {
  if (BY_ID.has(def.id)) throw new Error(`duplicate pattern id: ${def.id}`);
  BY_ID.set(def.id, def);
  const list = BY_SECTION.get(def.section) ?? [];
  list.push(def);
  BY_SECTION.set(def.section, list);
}

export function getPattern(id: string | undefined): PatternDefinition | undefined {
  return id ? BY_ID.get(id) : undefined;
}

export function patternsFor(section: string): PatternDefinition[] {
  return BY_SECTION.get(section) ?? [];
}

export function allPatterns(): PatternDefinition[] {
  return [...BY_ID.values()];
}

/** The first pattern registered for a section — its always-safe fallback. */
export function defaultPatternFor(section: string): PatternDefinition | undefined {
  return BY_SECTION.get(section)?.[0];
}

/** Everything the Site Brain knows when it judges whether a pattern fits. */
export interface FitContext {
  archetype: string;
  items: number;
  hasMedia: boolean;
  galleryCount: number;
  textLength: number;
  courseCount: number;
  reviewCount: number;
}

/** Whether a pattern's content requirements are met. */
export function patternFits(def: PatternDefinition, fit: FitContext): boolean {
  const n = def.needs;
  if (!n) return true;
  if (n.items != null && fit.items < n.items) return false;
  if (n.media && !fit.hasMedia) return false;
  if (n.gallery != null && fit.galleryCount < n.gallery) return false;
  if (n.text != null && fit.textLength < n.text) return false;
  if (n.courses != null && fit.courseCount < n.courses) return false;
  if (n.reviews != null && fit.reviewCount < n.reviews) return false;
  return true;
}

/**
 * The best pattern for a section given the content available.
 *
 * Used when the model names a pattern that does not exist or cannot be honoured,
 * and when a document is upgraded without a model call. Ties break by
 * registration order, so the result never depends on object iteration order.
 */
export function choosePattern(section: string, fit: FitContext): PatternDefinition | undefined {
  const candidates = patternsFor(section).filter((p) => patternFits(p, fit));
  if (!candidates.length) return defaultPatternFor(section);
  let best = candidates[0];
  let bestScore = -Infinity;
  for (const p of candidates) {
    const score = (p.base ?? 1) * (p.weight?.[fit.archetype] ?? 1);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}
