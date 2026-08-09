import { DesignRulesService } from '../../pipeline/design-rules.service';
import { SiteBrainService } from '../../pipeline/site-brain.service';
import { ENTRANCES } from '../../schema/design-spec';
import { PROFILE, WARM_DESIGN, buildComposition } from '../../__fixtures__/composition.fixture';
import { fixtureContext } from '../../__fixtures__/site-doc.fixture';
import { baseCss } from './base';
import { composeSite } from './compile';
import './patterns';

/**
 * The scroll entrance, and the blank page it once produced.
 *
 * A published academy served a header, a footer and roughly four thousand pixels
 * of nothing. Every section was in the HTML with all of its content; every one
 * was invisible.
 *
 * The cause was a deadlock. `mask-reveal` clipped each section to zero height
 * until an IntersectionObserver marked it on screen — and an observer computes
 * visibility from the target's *clipped* box, so a section that clips itself
 * reports that it is not on screen, and the observer that would un-clip it never
 * fires. It only happened on pages where the model chose that one entrance,
 * which is why it looked intermittent.
 *
 * Two rules came out of it, and these tests hold both:
 *   1. Never clip the element the observer is watching.
 *   2. Content must never depend on the observer succeeding at all.
 */

const brain = new SiteBrainService(new DesignRulesService());
const render = (entrance: (typeof ENTRANCES)[number]) => {
  const design = structuredClone(WARM_DESIGN);
  design.motion.entrance = entrance;
  return composeSite(brain.compose(buildComposition({ design }), PROFILE), fixtureContext());
};

const styles = (html: string) => html.match(/<style>([\s\S]*?)<\/style>/)![1];
const script = (html: string) => html.match(/<script>([\s\S]*?)<\/script>/)![1];

describe('no entrance may clip the element the observer watches', () => {
  it.each([...ENTRANCES])('%s leaves the section box intact', (entrance) => {
    const css = styles(render(entrance));
    // Any rule that clips or hides the section's own box would deadlock the
    // observer. Clipping its children is safe and looks identical.
    for (const rule of css.split('\n')) {
      const [selector, body = ''] = rule.split('{');
      if (!selector.includes('.block')) continue;
      // Declarations only — `clip-path` named inside a `transition` shorthand is
      // not a clip, and matching it would make this test meaningless.
      const clips = body
        .split(';')
        .some((d) =>
          // Only declarations that HIDE. `clip-path:none` is how the
          // reduced-motion block reveals everything, and flagging it would be
          // backwards.
          /^\s*clip-path\s*:\s*inset\((?!0 0 0 0\))/.test(d) ||
          /^\s*content-visibility\s*:\s*hidden/.test(d) ||
          /^\s*display\s*:\s*none/.test(d));
      if (!clips) continue;
      expect(selector).toMatch(/\.block[^{]*>/);
    }
  });

  it('still masks the content, so the effect survives the fix', () => {
    const css = styles(render('mask-reveal'));
    expect(css).toContain('.block:not(.hero)>*{clip-path:inset(0 0 100% 0)');
    expect(css).toContain('.block.in>*{clip-path:inset(0 0 0 0)}');
  });
});

describe('the page does not depend on the observer working', () => {
  const src = script(render('mask-reveal'));

  it('reveals whatever is already on screen without waiting to be told', () => {
    expect(src).toContain('getBoundingClientRect');
    expect(src).toContain('revealOnScreen()');
  });

  it('keeps revealing on scroll even if the observer never fires', () => {
    expect(src).toMatch(/addEventListener\('scroll'[\s\S]{0,200}revealOnScreen/);
  });

  it('survives an environment with no IntersectionObserver at all', () => {
    // Constructing one is wrapped on its own, so a browser or embedding without
    // it loses the animation and keeps the page.
    const i = src.indexOf('new IntersectionObserver');
    expect(src.slice(Math.max(0, i - 60), i)).toContain('try{');
  });

  it('abandons the effect rather than serve a page nobody can read', () => {
    expect(src).toContain("classList.remove('reveal-on')");
    expect(src).toMatch(/setTimeout\([\s\S]{0,260}reveal-on/);
  });

  it('observes at a threshold a tall section can actually reach', () => {
    // A section taller than roughly twelve screens never reaches an 8% ratio, so
    // the old threshold could strand a long page on its own.
    expect(src).toContain('threshold:0');
  });

  it('parses', () => {
    expect(() => new Function(src)).not.toThrow();
  });
});

describe('the hidden state is only ever added by script', () => {
  it('is absent from the stylesheet on its own', () => {
    // `.reveal-on` is added by JavaScript, so a visitor whose script never runs
    // gets a fully visible page rather than an empty one.
    const css = baseCss();
    for (const rule of css.split('\n')) {
      if (/opacity:0|clip-path:inset\(0 0 100%/.test(rule)) {
        expect(rule).toContain('.reveal-on');
      }
    }
  });
});
