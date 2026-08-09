import { ContentSignals } from '../generation/plan-prompt';
import { SitePlanAi } from '../generation/planning.schema';
import { SiteDocument } from '../schema/site-document';
import { buildFixtureDoc } from '../__fixtures__/site-doc.fixture';
import { DESIGN_DNA, DESIGN_DNA_KEYS } from './design-dna';
import { DesignRulesService } from './design-rules.service';

/**
 * "The AI proposes, the Rules Engine validates." These tests pin what that
 * sentence currently means, which is less than it sounds: two guards on the plan
 * and two on the assembled document. Recording the real coverage here is what
 * makes it obvious, later, which rules the richer design model still has to grow.
 */

const rules = new DesignRulesService();

const signals = (over: Partial<ContentSignals> = {}): ContentSignals => ({
  hasCover: true,
  hasLogo: true,
  galleryCount: 4,
  bioLength: 320,
  subjectsCount: 5,
  achievementsCount: 3,
  ...over,
});

const plan = (over: Partial<SitePlanAi> = {}): SitePlanAi => ({
  designDNA: 'warm_mentor',
  theme: { primary: '#D2603A', accent: '#0F766E' },
  archetype: 'general',
  ...over,
});

const codes = (v: { code: string }[]) => v.map((x) => x.code);

describe('DesignRulesService.validatePlan', () => {
  it('resolves the chosen DNA into the tokens the renderer consumes', () => {
    const { tokens } = rules.validatePlan(plan({ designDNA: 'editorial_dark' }), signals());
    expect(tokens).toEqual({ preset: 'premium', style: 'elegant', headingFont: 'serif', dna: 'editorial_dark' });
  });

  it('falls back to the default DNA when the key is unknown', () => {
    const { tokens } = rules.validatePlan(plan({ designDNA: 'no_such_dna' as never }), signals());
    expect(tokens.dna).toBe('warm_mentor');
  });

  it('downgrades a display heading on a minimal, academic direction', () => {
    // A display face fights a precise layout; the rule exists so an academic
    // direction cannot be handed a face that overpowers it.
    const academic = { ...DESIGN_DNA.academic_precise };
    expect(academic.preset).toBe('academic');
    // academic_precise ships `sans`, so the rule only fires for a DNA that pairs
    // an academic preset with a display face. Assert the rule's own condition
    // rather than inventing a DNA that does not exist.
    const { tokens, verdicts } = rules.validatePlan(plan({ designDNA: 'academic_precise' }), signals());
    expect(tokens.headingFont).toBe('sans');
    expect(codes(verdicts)).not.toContain('display-font-downgraded');
  });

  it('flags a page with no cover and no gallery', () => {
    const { verdicts } = rules.validatePlan(plan(), signals({ hasCover: false, galleryCount: 0 }));
    expect(codes(verdicts)).toContain('no-media');
    expect(verdicts.find((v) => v.code === 'no-media')?.severity).toBe('warn');
  });

  it('stays quiet when there is imagery to work with', () => {
    expect(codes(rules.validatePlan(plan(), signals({ hasCover: false, galleryCount: 3 })).verdicts)).not.toContain('no-media');
    expect(codes(rules.validatePlan(plan(), signals({ hasCover: true, galleryCount: 0 })).verdicts)).not.toContain('no-media');
  });

  it('never blocks a generation — every verdict it emits is advisory', () => {
    const { verdicts } = rules.validatePlan(
      plan({ designDNA: 'nonsense' as never }),
      signals({ hasCover: false, galleryCount: 0, bioLength: 0 }),
    );
    expect(verdicts.every((v) => v.severity === 'warn')).toBe(true);
  });

  it('does not yet inspect the design system the model composed', () => {
    // Documents the current boundary: `plan.design` — the palette, geometry and
    // rhythm the model chose — reaches the renderer unexamined. Nothing here
    // checks that the body text is legible on the background it was given.
    const illegible = plan({
      design: {
        background: '#101010', ink: '#121212', surface: '#111111',
        radius: 8, density: 'regular', headingScale: 'balanced', heroTreatment: 'flat',
      },
    });
    const { verdicts } = rules.validatePlan(illegible, signals());
    expect(codes(verdicts)).toEqual([]);
  });
});

describe('DesignRulesService.check — the assembled document', () => {
  const doc = (theme: Partial<SiteDocument['theme']>): SiteDocument => {
    const d = buildFixtureDoc({ dna: 'warm_mentor', persona: 'programming' });
    d.theme = { ...d.theme, ...theme };
    return d;
  };

  it('warns when a primary button cannot keep its own label legible', () => {
    // A mid-tone brand colour is the classic failure: neither black nor white
    // reaches 4.5:1 on top of it.
    const v = rules.check(doc({ primary: '#7F7F7F', accent: '#0F766E' }));
    expect(codes(v)).toContain('button-contrast-low');
  });

  it('stays quiet for a primary that carries its label', () => {
    expect(codes(rules.check(doc({ primary: '#0B3D2E', accent: '#E3B341' })))).not.toContain('button-contrast-low');
  });

  it('warns when the accent is indistinguishable from the primary', () => {
    const v = rules.check(doc({ primary: '#3B82F6', accent: '#3B84F6' }));
    expect(codes(v)).toContain('accent-indistinct');
  });

  it('does not warn when primary and accent are literally the same colour', () => {
    // Deliberate single-colour branding is a choice, not a mistake — the rule
    // targets two colours that are *nearly* identical, which reads as an error.
    expect(codes(rules.check(doc({ primary: '#3B82F6', accent: '#3B82F6' })))).not.toContain('accent-indistinct');
  });

  it('ignores a malformed colour rather than throwing', () => {
    expect(() => rules.check(doc({ primary: 'not-a-color' as never }))).not.toThrow();
  });
});

describe('the shipped Design DNA palettes', () => {
  it('records which signature palettes fail their own button-contrast rule', () => {
    // Several catalogue palettes trip the platform's own accessibility guard, and
    // because the verdict is only logged at debug level nobody sees it. Pinning
    // the list here means the design work in a later phase has a target, and any
    // new DNA that makes it worse fails a test instead of shipping.
    const failing: string[] = [];
    for (const key of [...DESIGN_DNA_KEYS].sort()) {
      const d = buildFixtureDoc({ dna: key, persona: 'programming' });
      if (rules.check(d).some((v) => v.code === 'button-contrast-low')) failing.push(key);
    }
    expect(failing).toMatchSnapshot();
  });
});
