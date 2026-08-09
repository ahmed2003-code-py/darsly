import { SiteDocument } from '../schema/site-document';
import { buildFixtureDoc } from '../__fixtures__/site-doc.fixture';
import { WARM_DESIGN, buildComposition } from '../__fixtures__/composition.fixture';
import { DesignRulesService } from './design-rules.service';
import { QualityGateService } from './quality-gate.service';

/**
 * The last thing between a draft and the public internet. Errors block a
 * publish; warnings are advisory and — today — are computed and then discarded,
 * because nothing surfaces them to the teacher. Both halves are pinned here.
 */

const gate = new QualityGateService(new DesignRulesService());

const doc = (): SiteDocument => buildFixtureDoc({ dna: 'academic_precise', persona: 'math_science' });
const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe('QualityGateService — what blocks a publish', () => {
  it('passes a page the generator actually produces', () => {
    expect(gate.blockingErrors(doc())).toEqual([]);
  });

  it('blocks a page with no hero', () => {
    const d = doc();
    d.blocks = d.blocks.filter((b) => b.type !== 'hero');
    expect(codes(gate.blockingErrors(d))).toContain('no-hero');
  });

  it('blocks a page that is barely a page', () => {
    const d = doc();
    d.blocks = [d.blocks.find((b) => b.type === 'hero')!];
    expect(codes(gate.blockingErrors(d))).toContain('too-few-sections');
  });

  it('blocks a hero with no headline in either language', () => {
    const d = doc();
    const hero = d.blocks.find((b) => b.type === 'hero')!;
    if (hero.type === 'hero') hero.headline = { ar: '   ', en: '' };
    expect(codes(gate.blockingErrors(d))).toContain('empty-hero-headline');
  });

  it('accepts a headline written in only one language', () => {
    // English is optional by design — an Arabic-only page is a legitimate page.
    const d = doc();
    const hero = d.blocks.find((b) => b.type === 'hero')!;
    if (hero.type === 'hero') hero.headline = { ar: 'اتعلم صح', en: '' };
    expect(codes(gate.blockingErrors(d))).not.toContain('empty-hero-headline');
  });
});

describe('QualityGateService — what only warns', () => {
  it('warns about an empty about section without blocking', () => {
    const d = doc();
    const about = d.blocks.find((b) => b.type === 'about')!;
    if (about.type === 'about') about.body = { ar: '', en: '' };
    const { errors, warnings } = gate.evaluate(d);
    expect(codes(warnings)).toContain('empty-about');
    expect(codes(errors)).not.toContain('empty-about');
  });

  it('warns when there is no SEO title', () => {
    const d = doc();
    delete d.seo;
    expect(codes(gate.evaluate(d).warnings)).toContain('missing-seo-title');
  });

  it('folds the design rule verdicts in as warnings', () => {
    const d = doc();
    d.theme.primary = '#7F7F7F';
    expect(codes(gate.evaluate(d).warnings)).toContain('button-contrast-low');
  });

  it('never lets a design verdict block a publish', () => {
    const d = doc();
    d.theme.primary = '#7F7F7F';
    d.theme.accent = '#7F7F80';
    expect(gate.blockingErrors(d)).toEqual([]);
  });
});

describe('QualityGateService — legibility', () => {
  it('blocks a legacy page whose body text is illegible on its own background', () => {
    // The legacy renderer paints the stored palette exactly as it is, with no
    // repair, so this page really would go live effectively blank. Nothing
    // checked it before.
    const d = doc();
    d.theme.design = {
      background: '#101010', ink: '#141414', surface: '#111111',
      radius: 8, density: 'regular', headingScale: 'balanced', heroTreatment: 'flat',
    };
    expect(codes(gate.blockingErrors(d))).toContain('body-contrast');
  });

  it('does not block a composed page for a contrast the renderer repairs', () => {
    // A composed document is repaired on its way to the compiler, so the same
    // palette is corrected before it is painted. Blocking here would stop a
    // publish over a problem that no longer exists on the page.
    const d = buildComposition({ design: structuredClone(WARM_DESIGN) });
    d.theme.designSpec!.palette.ink = '#F7F0E6';
    expect(codes(gate.blockingErrors(d))).not.toContain('body-contrast');
  });

  it('blocks a legacy page whose card text is unreadable', () => {
    // The background is fine and the ink is fine against it; the cards are the
    // problem. Checking only body-on-background would let this through.
    const d = doc();
    d.theme.design = {
      background: '#FFFFFF', ink: '#111111', surface: '#1A1A1A',
      radius: 8, density: 'regular', headingScale: 'balanced', heroTreatment: 'flat',
    };
    expect(codes(gate.blockingErrors(d))).toContain('surface-contrast');
  });

  it('leaves a composed page alone, because repair has already pulled the card back', () => {
    const d = buildComposition({ design: structuredClone(WARM_DESIGN) });
    d.theme.designSpec!.palette.surface = '#241A12';
    expect(gate.blockingErrors(d)).toEqual([]);
  });
});

describe('QualityGateService — sections that render to nothing', () => {
  it('warns about a section that will compile to blank space', () => {
    const d = doc();
    const toolkit = d.blocks.find((b) => b.type === 'toolkit')!;
    if (toolkit.type === 'toolkit') toolkit.items = [];
    const { warnings } = gate.evaluate(d);
    expect(codes(warnings)).toContain('empty-sections');
  });

  it('blocks a page where almost nothing is left to render', () => {
    const d = doc();
    for (const b of d.blocks) {
      if (b.type === 'toolkit' || b.type === 'credentials') b.items = [];
      if (b.type === 'faq') b.items = [];
      if (b.type === 'about') b.body = { ar: '', en: '' };
    }
    d.blocks = d.blocks.filter((b) => b.type !== 'courses' && b.type !== 'reviews' && b.type !== 'contact');
    expect(codes(gate.blockingErrors(d))).toContain('empty-sections');
  });
});

describe('QualityGateService — composition', () => {
  it('accepts a composed page the pipeline actually produces', () => {
    expect(gate.blockingErrors(buildComposition({ design: WARM_DESIGN }))).toEqual([]);
  });

  it('warns when a section names a layout that does not exist', () => {
    const d = buildComposition({ design: WARM_DESIGN, sections: { hero: { pattern: 'hero.invented' } } });
    expect(codes(gate.evaluate(d).warnings)).toContain('unknown-pattern');
  });

  it('warns when a section names a layout built for something else', () => {
    const d = buildComposition({ design: WARM_DESIGN, sections: { about: { pattern: 'courses.grid' } } });
    expect(codes(gate.evaluate(d).warnings)).toContain('mismatched-pattern');
  });

  it('never blocks a page merely for being unusual', () => {
    // The whole point of the composition system is that a teacher can be given
    // something unconventional. Only broken pages are stopped.
    const d = buildComposition({
      design: WARM_DESIGN,
      sections: {
        hero: { pattern: 'hero.image-full', surface: 'inverted', emphasis: 'feature', width: 'full' },
        about: { pattern: 'about.statement', surface: 'accent', align: 'center' },
        toolkit: { pattern: 'toolkit.marquee', surface: 'inverted' },
      },
    });
    expect(gate.blockingErrors(d)).toEqual([]);
  });
});
