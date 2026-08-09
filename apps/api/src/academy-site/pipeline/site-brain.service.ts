import { Injectable, Logger } from '@nestjs/common';
import { Archetype } from '../generation/planning.schema';
import { SectionSpec, SectionSurface } from '../schema/design-spec';
import { SiteBlock, SiteDocument } from '../schema/site-document';
import { resolveVariantId, selectVariant, VariantSelectionContext } from '../renderer/variants';
import { choosePattern, getPattern, patternFits, ResolvedSection } from '../renderer/compose';
import { ComposePlan, ComposeSection, RenderPlan, RulesVerdict } from './contracts';
import { ContentProfile, EMPTY_PROFILE, fitFor } from './content-profile';
import { designFor } from './design-lift';
import { repairDesign } from './design-repair';
import { DesignRulesService } from './design-rules.service';
import { blockContentCount, blockHasContent, blockMediaId } from './block-content';

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

  /**
   * Turn an assembled Site Document into an authoritative composition plan.
   *
   * This is where a proposal becomes a decision. Everything the model suggested
   * is either honoured, corrected or replaced here, and the compiler downstream
   * is total: it never has to ask whether a pattern exists, whether a colour is
   * legible or whether a section has enough content to justify its layout.
   */
  compose(doc: SiteDocument, profile: ContentProfile = EMPTY_PROFILE): ComposePlan {
    const archetype = (doc.theme.archetype as Archetype) ?? 'general';
    const { design, verdicts } = repairDesign(designFor(doc));

    // A section that would render to nothing is dropped rather than left to
    // occupy a slot in the numbering and contribute an empty band of padding.
    const kept: SiteBlock[] = [];
    for (const block of doc.blocks) {
      if (blockHasContent(block)) kept.push(block);
      else {
        verdicts.push({
          code: 'section-empty',
          severity: 'warn',
          message: `the ${block.type} section has no content and was left out`,
          target: block.id,
        });
      }
    }

    // Carried down the page rather than held on the service: this is a
    // singleton, and two academies rendering at once must not see each other's
    // sections.
    const recentSurfaces: SectionSurface[] = [];
    const sections: ComposeSection[] = kept.map((block, index) =>
      this.resolveSection(block, index, design, archetype, profile, verdicts, recentSurfaces),
    );

    return { theme: doc.theme, design, seo: doc.seo, sections, verdicts };
  }

  /** Fill in every optional on one section, and hold its pattern to the content. */
  private resolveSection(
    block: SiteBlock,
    index: number,
    design: ComposePlan['design'],
    archetype: string,
    profile: ContentProfile,
    verdicts: RulesVerdict[],
    recentSurfaces: SectionSurface[],
  ): ComposeSection {
    const asked: SectionSpec | undefined = block.section;
    const fit = fitFor(profile, archetype, {
      items: blockContentCount(block),
      hasMedia: !!blockMediaId(block),
      textLength: block.type === 'about' ? profile.bioLength : 0,
    });

    // The pattern the model asked for, if it exists and the content can carry
    // it; otherwise the best one that can. An unknown or unaffordable pattern is
    // a downgrade, never a failed generation.
    let pattern = getPattern(asked?.pattern);
    if (asked?.pattern && !pattern) {
      verdicts.push({
        code: 'pattern-unknown',
        severity: 'warn',
        message: `no pattern named "${asked.pattern}"; the best available one was used instead`,
        target: block.id,
      });
    } else if (pattern && pattern.section !== block.type) {
      verdicts.push({
        code: 'pattern-mismatched',
        severity: 'warn',
        message: `"${pattern.id}" does not lay out a ${block.type} section`,
        target: block.id,
      });
      pattern = undefined;
    } else if (pattern && !patternFits(pattern, fit)) {
      verdicts.push({
        code: 'pattern-unaffordable',
        severity: 'warn',
        message: `"${pattern.id}" needs more content than this ${block.type} section has`,
        target: block.id,
      });
      pattern = undefined;
    }
    const resolved = pattern ?? choosePattern(block.type, fit);

    const spec: ResolvedSection = {
      pattern: resolved?.id ?? '',
      emphasis: asked?.emphasis ?? (index === 0 ? 'feature' : 'normal'),
      width: asked?.width ?? (resolved?.fullBleed ? 'full' : design.rhythm.containerWidth),
      surface: this.surfaceFor(asked?.surface, recentSurfaces, verdicts, block.id),
      align: asked?.align ?? 'start',
      columns: Math.max(1, Math.min(4, asked?.columns ?? 3)),
      accents: (asked?.accents ?? design.decoration.accents).slice(0, 2),
      imageTreatment: asked?.imageTreatment ?? design.decoration.imageTreatment,
      index,
    };

    // A pattern that cannot go full-bleed must not be asked to.
    if (spec.width === 'full' && !resolved?.fullBleed) {
      spec.width = design.rhythm.containerWidth === 'full' ? 'wide' : design.rhythm.containerWidth;
      verdicts.push({
        code: 'fullbleed-unsupported',
        severity: 'warn',
        message: `"${spec.pattern}" is not built to run edge to edge`,
        target: block.id,
      });
    }
    return { block, spec };
  }

  /**
   * The band a section sits on.
   *
   * The one rule worth enforcing is against monotony in either direction: three
   * consecutive sections on the same loud surface stops reading as structure,
   * and a hero is never inverted because it already owns the whole first screen.
   */
  private surfaceFor(
    asked: SectionSurface | undefined,
    recent: SectionSurface[],
    verdicts: RulesVerdict[],
    blockId: string,
  ): SectionSurface {
    // With nothing asked for, the page's own band. `alternating` is then
    // expressed in CSS, so the document stays a description of intent rather
    // than of paint.
    let surface: SectionSurface = asked ?? 'page';
    if (surface !== 'page' && recent.length >= 2 && recent.slice(-2).every((s) => s === surface)) {
      verdicts.push({
        code: 'surface-monotony',
        severity: 'warn',
        message: 'three sections in a row on the same band; this one was returned to the page',
        target: blockId,
      });
      surface = 'page';
    }
    recent.push(surface);
    return surface;
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
