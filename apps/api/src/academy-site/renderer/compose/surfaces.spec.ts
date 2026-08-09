import { SECTION_SURFACES } from '../../schema/design-spec';
import { DesignRulesService } from '../../pipeline/design-rules.service';
import { SiteBrainService } from '../../pipeline/site-brain.service';
import { PROFILE, TECHNICAL_DESIGN, WARM_DESIGN, buildComposition } from '../../__fixtures__/composition.fixture';
import { fixtureContext } from '../../__fixtures__/site-doc.fixture';
import { baseCss } from './base';
import { composeSite } from './compile';
import { allPatterns } from './registry';
import './patterns';

/**
 * Section surfaces, and the text that painted itself out of existence.
 *
 * A credentials list sat on an `inverted` band — background `--ink` — and
 * coloured its own text `--ink`, because that is what "the page's text colour"
 * is called. Ink on ink. The words were there, the layout was there, and the
 * section read as seven numbered rules with nothing beside them.
 *
 * The surfaces used to re-colour a hand-written list of element types
 * (`h1,h2,h3`, `p,.lead`) which no pattern's own classes were on. They now
 * restate a set of *roles*, and patterns paint with the role rather than the
 * token — so a pattern written today is still correct on a band invented
 * tomorrow. This file is what keeps that true.
 */

const brain = new SiteBrainService(new DesignRulesService());
const styles = (html: string) => html.match(/<style>([\s\S]*?)<\/style>/)![1];

/** Palette tokens that mean something different once a section changes band. */
const BANNED = ['--ink', '--line', '--surface', '--mut', '--body', '--a-text', '--a-surface'];

describe('no pattern paints with a raw palette token', () => {
  it.each(allPatterns().map((p) => [p.id, p] as const))('%s', (_id, pattern) => {
    // `--ink` IS the background on an inverted band, `--line` is invisible on
    // it, and `--surface` is the band itself on a raised one. A pattern that
    // reaches for any of them is correct on exactly one surface out of five.
    const css = pattern.css();
    for (const token of BANNED) {
      const used = new RegExp(`var\\(${token}\\)`).test(css);
      expect({ pattern: pattern.id, token, used }).toEqual({ pattern: pattern.id, token, used: false });
    }
  });
});

describe('every surface restates every role', () => {
  const css = baseCss();
  const roles = ['--fg', '--fg-soft', '--fg-mut', '--rule', '--panel', '--acc', '--band'];

  it('defines them all on the page to begin with', () => {
    const body = css.match(/body\{--band[^}]*\}/)![0];
    for (const role of roles) expect(body).toContain(`${role}:`);
  });

  it.each(SECTION_SURFACES.filter((s) => s !== 'page'))('%s says which band it is', (surface) => {
    const rule = css.match(new RegExp(`\\.block\\[data-surface=${surface}\\]\\{[^}]*\\}`))![0];
    expect(rule).toContain('--band:');
  });

  // `raised` is a tint of the page, so ink and hairlines still read on it and it
  // has nothing to restate. These three replace the background outright, and
  // are exactly the ones text and rules disappear on.
  it.each(['inverted', 'accent', 'image'] as const)('%s restates the ink and the hairline', (surface) => {
    const rule = css.match(new RegExp(`\\.block\\[data-surface=${surface}\\]\\{[^}]*\\}`))![0];
    expect(rule).toContain('--fg:');
    expect(rule).toContain('--rule:');
    expect(rule).toContain('--panel:');
    expect(rule).toContain('--acc:');
  });
});

describe('a section reads on whatever band it lands on', () => {
  const render = (surface: (typeof SECTION_SURFACES)[number]) =>
    composeSite(
      brain.compose(
        buildComposition({
          design: TECHNICAL_DESIGN,
          sections: {
            credentials: { pattern: 'credentials.record', surface },
            toolkit: { pattern: 'toolkit.skill-matrix', surface },
            faq: { pattern: 'faq.accordion', surface },
          },
        }),
        PROFILE,
      ),
      fixtureContext(),
    );

  it.each([...SECTION_SURFACES])('%s renders without throwing', (surface) => {
    expect(() => render(surface)).not.toThrow();
  });

  it('gives the same markup on every band — only the roles change', () => {
    // The proof that this is a colour system and not a set of special cases:
    // switching the band must not change a single element.
    const strip = (html: string) => html.replace(/data-surface="[a-z]+"/g, '');
    const page = strip(render('page').replace(/<style>[\s\S]*?<\/style>/, ''));
    for (const surface of SECTION_SURFACES) {
      expect(strip(render(surface).replace(/<style>[\s\S]*?<\/style>/, ''))).toBe(page);
    }
  });
});

describe('the alternating rhythm actually alternates', () => {
  it('targets the band sections are really given', () => {
    // The rule read `.block:not([data-surface])`, and every section carries a
    // `data-surface` attribute, so it matched nothing and the rhythm was a
    // setting with no effect.
    const css = baseCss();
    expect(css).toContain('[data-rhythm=alternating] .block[data-surface=page]:nth-of-type(even)');
    expect(css).not.toContain(':not([data-surface])');
  });

  it('reaches the page when the design asks for it', () => {
    const design = structuredClone(WARM_DESIGN);
    design.rhythm.sectionRhythm = 'alternating';
    const html = composeSite(brain.compose(buildComposition({ design }), PROFILE), fixtureContext());
    expect(html).toContain('data-rhythm="alternating"');
    expect(styles(html)).toContain('[data-rhythm=alternating]');
  });
});
