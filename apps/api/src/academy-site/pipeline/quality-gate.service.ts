import { Injectable } from '@nestjs/common';
import { SiteBlock, SiteDocument } from '../schema/site-document';
import { DesignRulesService } from './design-rules.service';

/**
 * Pre-publish quality gate (Phase 6). A deterministic lint that runs before a
 * document goes public. Errors block publishing (a genuinely broken page);
 * warnings are advisory. "Never publish average quality" — this is the floor.
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

@Injectable()
export class QualityGateService {
  constructor(private readonly rules: DesignRulesService) {}

  evaluate(doc: SiteDocument): { errors: QualityIssue[]; warnings: QualityIssue[] } {
    const issues: QualityIssue[] = [];
    const blocks = doc.blocks as SiteBlock[];
    const has = (t: SiteBlock['type']) => blocks.find((b) => b.type === t);

    // Structure: a real landing page opens with a hero and has some substance.
    if (!has('hero')) issues.push({ code: 'no-hero', severity: 'error', message: 'the page has no hero section' });
    if (blocks.length < 2) issues.push({ code: 'too-few-sections', severity: 'error', message: 'the page has fewer than two sections' });

    // Content: the hero headline must not be empty.
    const hero = has('hero');
    if (hero && hero.type === 'hero' && !hasText(hero.headline)) {
      issues.push({ code: 'empty-hero-headline', severity: 'error', message: 'the hero has no headline' });
    }
    const about = has('about');
    if (about && about.type === 'about' && !hasText(about.body)) {
      issues.push({ code: 'empty-about', severity: 'warn', message: 'the about section has no body' });
    }

    // SEO: recommended, not required.
    if (!doc.seo || !hasText(doc.seo.title)) {
      issues.push({ code: 'missing-seo-title', severity: 'warn', message: 'no SEO title set' });
    }

    // Design: fold in the Rules Engine verdicts (contrast, palette hierarchy).
    for (const v of this.rules.check(doc)) {
      issues.push({ code: v.code, severity: v.severity, message: v.message });
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
