import { Injectable } from '@nestjs/common';
import { SiteDocument } from '../schema/site-document';
import { contrastRatio, isHex, onColor } from '../renderer/color.util';
import { ContentSignals } from '../generation/plan-prompt';
import { SitePlanAi } from '../generation/planning.schema';
import { RulesVerdict } from './contracts';
import { DesignTokenSet, resolveDna } from './design-dna';

/**
 * The Design Rules Engine — deterministic, handcrafted design constraints.
 * "The AI proposes, the Rules Engine validates." It never renders and never
 * mutates; it returns verdicts the Site Brain uses to veto or downgrade
 * proposals.
 *
 * Phase 1 ships one real rule (button contrast) run as a QA lint over the
 * assembled document. Phase 2+ moves it upstream to gate component selection
 * (e.g. image-heavy hero requires good media; editorial about requires a long
 * bio; a credentials layout requires enough achievements).
 */
@Injectable()
export class DesignRulesService {
  /**
   * Validate an AI Planning proposal and resolve it into render tokens.
   * "The AI proposes, the Rules Engine validates." It resolves the chosen DNA
   * deterministically and applies handcrafted guards. Content-gating rules that
   * veto specific *variants* arrive in Phase 3, when there is more than one
   * variant per section to choose between; `signals` is threaded through now so
   * those rules have their inputs.
   */
  validatePlan(plan: SitePlanAi, signals: ContentSignals): { tokens: DesignTokenSet; verdicts: RulesVerdict[] } {
    const verdicts: RulesVerdict[] = [];
    const dna = resolveDna(plan.designDNA);
    let headingFont = dna.headingFont;

    // Rule: display headings fight a minimal/precise, academic look — downgrade
    // to a clean sans so the type doesn't overpower the layout.
    if (headingFont === 'display' && dna.preset === 'academic') {
      headingFont = 'sans';
      verdicts.push({
        code: 'display-font-downgraded',
        severity: 'warn',
        message: 'display heading downgraded to sans for a minimal/academic preset',
        target: 'theme.headingFont',
      });
    }

    // Rule: an image-forward direction with no imagery still renders (gradient
    // heroes), but flag it so Phase 3 can prefer a text-forward hero variant.
    if (signals.galleryCount === 0 && !signals.hasCover) {
      verdicts.push({
        code: 'no-media',
        severity: 'warn',
        message: 'no cover or gallery media available',
        target: 'media',
      });
    }

    const tokens: DesignTokenSet = { preset: dna.preset, style: dna.style, headingFont, dna: dna.key };
    return { tokens, verdicts };
  }

  check(doc: SiteDocument): RulesVerdict[] {
    const verdicts: RulesVerdict[] = [];
    const { primary, accent } = doc.theme;

    // Rule: primary buttons must keep their label legible (WCAG AA ≈ 4.5:1).
    if (isHex(primary)) {
      const ratio = contrastRatio(primary, onColor(primary));
      if (ratio < 4.5) {
        verdicts.push({
          code: 'button-contrast-low',
          severity: 'warn',
          message: `primary/on-color contrast ${ratio.toFixed(2)} is below 4.5:1`,
          target: 'theme.primary',
        });
      }
    }

    // Rule: accent should be distinguishable from primary (else the palette
    // reads as a single flat color with no hierarchy).
    if (isHex(primary) && isHex(accent) && contrastRatio(primary, accent) < 1.15 && primary.toLowerCase() !== accent.toLowerCase()) {
      verdicts.push({
        code: 'accent-indistinct',
        severity: 'warn',
        message: 'accent is nearly identical to primary; no visual hierarchy',
        target: 'theme.accent',
      });
    }

    return verdicts;
  }
}
