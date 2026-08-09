import { DesignSpec } from '../schema/design-spec';
import { ResolvedSection } from '../renderer/compose';
import { SiteBlock, SiteDocument, SiteSeo, SiteTheme } from '../schema/site-document';

/**
 * Pipeline data contracts. The generation flow is a chain of pure/deterministic
 * transforms with two AI calls at the ends:
 *
 *   Facts + Media + History
 *     → AI PLANNING      (proposes: SitePlan)
 *     → DESIGN RULES     (validates/constrains: RulesVerdict[])
 *     → SITE BRAIN       (decides, authoritative: RenderPlan)
 *     → AI GENERATION    (fills content for the planned slots)
 *     → assemble         (SiteDocument)
 *     → RENDERER         (pure: RenderPlan → HTML)
 *
 * Phase 1 introduces the spine: the RenderPlan the Site Brain hands the
 * renderer, and the RulesVerdict the Rules Engine emits. `SitePlan` and
 * `DesignTokens` are declared here as the target contracts; the AI Planning
 * stage that populates them lands in Phase 2.
 */

/** A design rule outcome. `error` = must not render as proposed; `warn` = advisory. */
export interface RulesVerdict {
  code: string;
  severity: 'error' | 'warn';
  message: string;
  /** Block id / section type the verdict applies to, when scoped. */
  target?: string;
}

/** One block promoted to a concrete, ready-to-render decision by the Site Brain. */
export interface RenderPlanBlock {
  block: SiteBlock;
  /** Authoritative variant id, resolved against the Variant Registry. */
  variant: string;
}

/**
 * The Site Brain's authoritative output and the only thing the renderer reads.
 * The renderer makes no decisions — it renders exactly this.
 */
export interface RenderPlan {
  theme: SiteTheme;
  seo?: SiteSeo;
  blocks: RenderPlanBlock[];
  /** Advisory/diagnostic verdicts carried alongside (never block rendering). */
  verdicts: RulesVerdict[];
}

/** One section promoted to a concrete, ready-to-render composition decision. */
export interface ComposeSection {
  block: SiteBlock;
  spec: ResolvedSection;
}

/**
 * The Site Brain's output for a v3 document, and the only thing the composition
 * compiler reads. Every optional in the design and in each section spec has
 * already been filled in, every pattern id already resolved against the
 * registry, and every content requirement already checked — so the compiler is
 * total and never has to decide anything.
 */
export interface ComposePlan {
  theme: SiteTheme;
  design: DesignSpec;
  seo?: SiteSeo;
  sections: ComposeSection[];
  verdicts: RulesVerdict[];
}

// ── Forward contracts (populated in later phases) ────────────────────────────

/**
 * The full design token set a DNA resolves to (Phase 2). Superset of the
 * current `SiteTheme`; the renderer will consume tokens instead of ad-hoc
 * preset/style fields.
 */
export interface DesignTokens {
  primary: string;
  accent: string;
  /** Named DNA, e.g. 'editorial-serif-dark' — drives type/shadow/motion. */
  dna?: string;
}

/**
 * The AI Planning proposal (Phase 2): brand read, design direction, storytelling
 * archetype and *proposed* (non-authoritative) variant choices. The Site Brain,
 * not this, decides what actually renders.
 */
export interface SitePlan {
  brandProfile?: Record<string, unknown>;
  designTokens?: DesignTokens;
  archetype?: string;
  /** Proposed section order + variant ids (advisory; Rules + Brain may override). */
  proposedSections?: { type: SiteBlock['type']; variant?: string }[];
}

/** Convenience: the shape the Site Brain consumes today (an assembled document). */
export type BrainInput = SiteDocument;
