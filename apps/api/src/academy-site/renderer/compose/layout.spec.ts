import { ACCENT_MARKS } from '../../schema/design-spec';
import { contrastRatio } from '../color.util';
import { repairDesign } from '../../pipeline/design-repair';
import { DesignRulesService } from '../../pipeline/design-rules.service';
import { SiteBrainService } from '../../pipeline/site-brain.service';
import { PROFILE, WARM_DESIGN, buildComposition } from '../../__fixtures__/composition.fixture';
import { fixtureContext } from '../../__fixtures__/site-doc.fixture';
import { ACCENT_CSS } from './effects';
import { composeSite } from './compile';
import { allPatterns } from './registry';
import './patterns';

/**
 * Decoration must not move the furniture.
 *
 * `rule-lines` drew a short accent rule by putting a `::before` on the section's
 * container. Several patterns make that container a grid — and a pseudo-element
 * in a grid container is a grid *item*. The rule silently took the first cell,
 * so the hero copy moved into the second and the teacher's photograph dropped
 * onto a row of its own, a screen below where it belonged.
 *
 * Nothing in the markup was wrong, which is why it read as a design problem
 * rather than a bug.
 */

const brain = new SiteBrainService(new DesignRulesService());
const render = (accents: (typeof ACCENT_MARKS)[number][], pattern: string) =>
  composeSite(
    brain.compose(
      buildComposition({
        design: { ...structuredClone(WARM_DESIGN), decoration: { ...WARM_DESIGN.decoration, accents } },
        sections: { hero: { pattern, accents } },
      }),
      PROFILE,
    ),
    fixtureContext(),
  );

describe('an accent never consumes a layout cell', () => {
  it.each(ACCENT_MARKS.map((m) => [m] as const))('%s stays out of the grid flow', (mark) => {
    const css = ACCENT_CSS[mark];
    // A pseudo-element on the container is only safe if it is taken out of flow
    // or told to span the whole row.
    const rules = css.split('\n').filter((r) => /\.wrap::(before|after)/.test(r) && r.includes('content:'));
    for (const rule of rules) {
      const safe = rule.includes('position:absolute') || rule.includes('grid-column:1/-1');
      expect({ mark, rule: rule.slice(0, 80), safe }).toEqual({ mark, rule: rule.slice(0, 80), safe: true });
    }
  });

  it('leaves a two-column hero as two columns', () => {
    // The bug in one assertion: with the accent on, the hero laid out as three
    // items instead of two.
    const withRule = render(['rule-lines'], 'hero.split-portrait');
    const without = render([], 'hero.split-portrait');
    const cells = (html: string) =>
      (html.match(/<section[^>]*class="block hero[\s\S]*?<\/section>/)![0].match(/<div class="hero-(copy|media)"/g) ?? []).length;
    expect(cells(withRule)).toBe(cells(without));
    expect(withRule).toContain('grid-column:1/-1');
  });

  it('renders every hero with every accent without reordering it', () => {
    const heroes = allPatterns().filter((p) => p.section === 'hero');
    for (const hero of heroes) {
      for (const mark of ACCENT_MARKS) {
        expect(() => render([mark], hero.id)).not.toThrow();
      }
    }
  });
});

describe('brand colours have to read on the page they are on', () => {
  const dark = (primary: string, accent: string) => {
    const d = structuredClone(WARM_DESIGN);
    d.palette = { ...d.palette, background: '#0B0B10', ink: '#EDEAE3', surface: '#141418', surfaceAlt: '#1A1A20', primary, accent, mode: 'dark' };
    return repairDesign(d);
  };

  it('lifts a primary that barely separates from the page', () => {
    // A forest green button on near-black passes every text check — its white
    // label is perfectly legible — and still looks like a rectangle of nothing.
    const { design, verdicts } = dark('#14532D', '#C8A96A');
    expect(verdicts.map((v) => v.code)).toContain('primary-indistinct');
    expect(contrastRatio(design.palette.primary, design.palette.background)).toBeGreaterThanOrEqual(2);
  });

  it('lifts an accent that disappears into the page', () => {
    const { design, verdicts } = dark('#3B82F6', '#101018');
    expect(verdicts.map((v) => v.code)).toContain('accent-indistinct-on-page');
    expect(contrastRatio(design.palette.accent, design.palette.background)).toBeGreaterThanOrEqual(1.6);
  });

  it('leaves a palette that already reads exactly as it was', () => {
    const { design, verdicts } = dark('#FB3B6C', '#22D3EE');
    expect(design.palette.primary).toBe('#FB3B6C');
    expect(design.palette.accent).toBe('#22D3EE');
    expect(verdicts.map((v) => v.code)).not.toContain('primary-indistinct');
  });

  it('respects a deliberately monochrome brand', () => {
    const { design } = dark('#C8A96A', '#C8A96A');
    expect(design.palette.accent).toBe(design.palette.primary);
  });
});

describe('the headline accent is readable on its own band', () => {
  it('paints the gradient with the band-aware roles, not the raw palette', () => {
    // `.grad` used --a and --p directly, so a deep brand colour on a dark page
    // rendered the accented words of the headline nearly invisible — and on an
    // inverted band it was the background colour.
    const css = render([], 'hero.centered').match(/<style>([\s\S]*?)<\/style>/)![1];
    const grad = css.match(/\.grad\{[^}]*\}/)![0];
    expect(grad).toContain('var(--acc)');
    expect(grad).toContain('var(--acc-2)');
    expect(grad).not.toMatch(/var\(--a\)|var\(--p\)/);
  });
});
