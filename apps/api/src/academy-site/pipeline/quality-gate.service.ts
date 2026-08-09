import { Injectable } from '@nestjs/common';
import { contrastRatio } from '../renderer/color.util';
import { getPattern } from '../renderer/compose';
import { usesComposition } from '../renderer/site-render.service';
import { SiteBlock, SiteDocument } from '../schema/site-document';
import { blockHasContent } from './block-content';
import { designFor } from './design-lift';
import { repairDesign } from './design-repair';
import { DesignRulesService } from './design-rules.service';

/**
 * The pre-publish quality gate: the last thing between a draft and the public
 * internet.
 *
 * Errors block a publish, warnings are advisory, and the split is deliberate. A
 * page that is merely unusual must always be publishable — the whole point of
 * the composition system is that a teacher can get something unconventional. A
 * page that is *broken* must not be, and broken now includes what it always
 * should have: text nobody can read, and sections that render to nothing.
 */
export interface QualityIssue {
  code: string;
  severity: 'error' | 'warn';
  message: string;
}

const hasText = (lt: unknown): boolean => {
  const o = lt as { ar?: unknown; en?: unknown } | null;
  return !!o && ((typeof o.ar === 'string' && o.ar.trim() !== '') || (typeof o.en === 'string' && o.en.trim() !== ''));
};

/** WCAG AA for large text — the floor for a headline, not the target. */
const MIN_HEADING_CONTRAST = 4.5;
/** WCAG AA for body text. */
const MIN_BODY_CONTRAST = 4.5;

@Injectable()
export class QualityGateService {
  constructor(private readonly rules: DesignRulesService) {}

  evaluate(doc: SiteDocument): { errors: QualityIssue[]; warnings: QualityIssue[] } {
    const issues: QualityIssue[] = [];
    const blocks = doc.blocks as SiteBlock[];
    const has = (t: SiteBlock['type']) => blocks.find((b) => b.type === t);
    const push = (code: string, severity: QualityIssue['severity'], message: string) =>
      issues.push({ code, severity, message });

    // ── Structure ─────────────────────────────────────────────────────────────
    if (!has('hero')) push('no-hero', 'error', 'the page has no hero section');
    if (blocks.length < 2) push('too-few-sections', 'error', 'the page has fewer than two sections');
    if (blocks.length > 14) push('too-many-sections', 'warn', 'the page has more sections than a visitor will scroll');

    // A section that renders to an empty string still occupies a slot in the
    // numbering and still contributes its padding, so the page grows a silent
    // gap. The old gate counted blocks rather than rendered sections and could
    // not see this at all.
    const empty = blocks.filter((b) => !blockHasContent(b));
    if (empty.length) {
      const rendered = blocks.length - empty.length;
      push(
        'empty-sections',
        rendered < 2 ? 'error' : 'warn',
        `${empty.length} section(s) have no content and will render as blank space: ${empty.map((b) => b.type).join(', ')}`,
      );
    }

    // ── Content ───────────────────────────────────────────────────────────────
    const hero = has('hero');
    if (hero && hero.type === 'hero' && !hasText(hero.headline)) {
      push('empty-hero-headline', 'error', 'the hero has no headline');
    }
    const about = has('about');
    if (about && about.type === 'about' && !hasText(about.body)) {
      push('empty-about', 'warn', 'the about section has no body');
    }
    if (!doc.seo || !hasText(doc.seo.title)) {
      push('missing-seo-title', 'warn', 'no SEO title set');
    }

    // ── Accessibility ─────────────────────────────────────────────────────────
    // Measured against the colours that will actually be painted, which is not
    // the same question for the two engines. A composed page is repaired on its
    // way to the renderer, so warning about a contrast the compiler already
    // fixes would be noise. A legacy page is not repaired at all — its palette
    // goes into the stylesheet exactly as stored — so it is checked raw, and a
    // legacy document with unreadable text is blocked rather than published.
    const composed = usesComposition(doc);
    const lifted = designFor(doc);
    const design = composed ? repairDesign(lifted).design : lifted;
    const p = design.palette;
    const body = contrastRatio(p.ink, p.background);
    if (body < MIN_BODY_CONTRAST) {
      push('body-contrast', 'error', `body text contrast is ${body.toFixed(1)}:1 against the background`);
    }
    const onSurface = contrastRatio(p.ink, p.surface);
    if (onSurface < MIN_BODY_CONTRAST) {
      push('surface-contrast', 'error', `text on cards has only ${onSurface.toFixed(1)}:1 contrast`);
    }
    const heading = contrastRatio(p.ink, p.background);
    if (heading < MIN_HEADING_CONTRAST) {
      push('heading-contrast', 'warn', 'headings are hard to read against the background');
    }

    // ── Composition ───────────────────────────────────────────────────────────
    for (const block of blocks) {
      const id = block.section?.pattern;
      if (!id) continue;
      const pattern = getPattern(id);
      if (!pattern) {
        push('unknown-pattern', 'warn', `"${id}" is not a layout this platform has; a default will be used`);
      } else if (pattern.section !== block.type) {
        push('mismatched-pattern', 'warn', `"${id}" does not lay out a ${block.type} section`);
      }
    }
    const surfaces = blocks.map((b) => b.section?.surface ?? 'page');
    for (let i = 2; i < surfaces.length; i++) {
      if (surfaces[i] !== 'page' && surfaces[i] === surfaces[i - 1] && surfaces[i] === surfaces[i - 2]) {
        push('surface-monotony', 'warn', 'three sections in a row sit on the same band');
        break;
      }
    }

    // ── Motion and performance ────────────────────────────────────────────────
    if (design.motion.scrollFx.length > 3) {
      push('motion-budget', 'warn', 'more scroll effects than the page can carry gracefully');
    }

    // ── Design rules ──────────────────────────────────────────────────────────
    for (const v of this.rules.check(doc)) {
      push(v.code, v.severity, v.message);
    }

    return {
      errors: issues.filter((i) => i.severity === 'error'),
      warnings: issues.filter((i) => i.severity === 'warn'),
    };
  }

  /** Returns the blocking errors (empty = safe to publish). */
  blockingErrors(doc: SiteDocument): QualityIssue[] {
    return this.evaluate(doc).errors;
  }
}
