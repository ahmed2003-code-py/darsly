import { Injectable, Logger } from '@nestjs/common';
import { Archetype } from '../generation/planning.schema';
import { SiteDocument } from '../schema/site-document';
import { resolveVariantId, selectVariant, VariantSelectionContext } from '../renderer/variants';
import { RenderPlan } from './contracts';
import { DesignRulesService } from './design-rules.service';

// Section flow. Hero always opens; contact + CTA always close. The middle band
// is ordered by archetype so each teacher's page leads with their strength.
const PIN_FIRST = new Set(['hero']);
const PIN_LAST = ['contact', 'cta'];
const PIN_LAST_SET = new Set(PIN_LAST);

// Base ordering of the middle band (lower = earlier).
const BASE_ORDER: Record<string, number> = {
  about: 10, toolkit: 20, credentials: 30, stats: 35, courses: 40, gallery: 50, reviews: 60, faq: 70,
};

// Per-archetype overrides — push the sections that make each teacher's case up.
const ARCHETYPE_ORDER: Record<Archetype, Partial<Record<string, number>>> = {
  programming: { courses: 8, toolkit: 9 }, // what you'll build + the skills, first
  math_science: { credentials: 12, toolkit: 16 }, // foundations + track record
  languages: { about: 8, reviews: 24 }, // method first, social proof early
  exam_prep: { credentials: 10, reviews: 14, courses: 18 }, // results first
  university: { credentials: 8, about: 14 }, // authority/research first
  general: {},
};

/**
 * The Site Brain — the single authoritative source of rendering decisions
 * (section order, variant selection, visibility, later: density/motion/
 * decoration/spacing). It consults the Design Rules Engine, then emits a
 * RenderPlan the pure renderer executes verbatim.
 *
 * Phase 1 role: resolve each block's variant against the registry (identity
 * order, one variant per section) and attach rule verdicts. Phase 2+ makes it
 * consume the AI SitePlan + evolution history and act on rule vetoes.
 */
@Injectable()
export class SiteBrainService {
  private readonly logger = new Logger(SiteBrainService.name);

  constructor(private readonly rules: DesignRulesService) {}

  /**
   * Build-time storytelling: reorder sections so the page leads with what makes
   * this teacher's case. Hero stays first; contact + CTA stay last; the middle
   * band is ordered by archetype (stable — equal priorities keep their order).
   */
  arrange(doc: SiteDocument, archetype: Archetype): void {
    const first = doc.blocks.filter((b) => PIN_FIRST.has(b.type));
    const last = PIN_LAST.map((t) => doc.blocks.find((b) => b.type === t)).filter(
      (b): b is SiteDocument['blocks'][number] => !!b,
    );
    const middle = doc.blocks.filter((b) => !PIN_FIRST.has(b.type) && !PIN_LAST_SET.has(b.type));
    middle.sort((a, b) => this.priority(a.type, archetype) - this.priority(b.type, archetype));
    doc.blocks = [...first, ...middle, ...last];
  }

  private priority(type: string, archetype: Archetype): number {
    return ARCHETYPE_ORDER[archetype]?.[type] ?? BASE_ORDER[type] ?? 100;
  }

  /**
   * Build-time decision: choose the best variant for each block and bake it into
   * the document. "The AI proposes (DNA + archetype), the Site Brain decides"
   * the concrete layout by scoring registered variants against the context.
   */
  assignVariants(doc: SiteDocument, ctx: VariantSelectionContext): void {
    for (const block of doc.blocks) {
      block.variant = selectVariant(block.type, ctx);
    }
  }

  /** Turn an assembled Site Document into an authoritative RenderPlan. */
  plan(doc: SiteDocument): RenderPlan {
    const verdicts = this.rules.check(doc);
    if (verdicts.length) {
      this.logger.debug(`design-rule verdicts: ${verdicts.map((v) => `${v.severity}:${v.code}`).join(', ')}`);
    }
    const blocks = doc.blocks.map((block) => ({
      block,
      variant: resolveVariantId(block.type, block.variant),
    }));
    return { theme: doc.theme, seo: doc.seo, blocks, verdicts };
  }
}
