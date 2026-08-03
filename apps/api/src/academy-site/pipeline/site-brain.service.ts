import { Injectable, Logger } from '@nestjs/common';
import { SiteDocument } from '../schema/site-document';
import { resolveVariantId, selectVariant, VariantSelectionContext } from '../renderer/variants';
import { RenderPlan } from './contracts';
import { DesignRulesService } from './design-rules.service';

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
