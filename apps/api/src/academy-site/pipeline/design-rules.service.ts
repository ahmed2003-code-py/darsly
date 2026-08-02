import { Injectable } from '@nestjs/common';
import { SiteDocument } from '../schema/site-document';
import { contrastRatio, isHex, onColor } from '../renderer/color.util';
import { RulesVerdict } from './contracts';

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
