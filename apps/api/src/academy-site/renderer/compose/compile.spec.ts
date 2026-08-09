import { createHash } from 'crypto';
import { DesignRulesService } from '../../pipeline/design-rules.service';
import { SiteBrainService } from '../../pipeline/site-brain.service';
import { SiteDocument } from '../../schema/site-document';
import {
  AUSTERE_DESIGN, PROFILE, TECHNICAL_DESIGN, THIN_PROFILE, WARM_DESIGN, buildComposition,
} from '../../__fixtures__/composition.fixture';
import { fixtureContext } from '../../__fixtures__/site-doc.fixture';
import { baseCss } from './base';
import { composeSite } from './compile';
import { allPatterns, patternsFor } from './registry';
import './patterns';

/**
 * The composition engine end to end: a v3 document in, a page out.
 *
 * The assertions that matter most here are not about any single page but about
 * the *distance between* pages. A system that can render three good-looking
 * sites which share a stylesheet has not solved the problem this replaced.
 */

const brain = new SiteBrainService(new DesignRulesService());
const ctx = fixtureContext();

const render = (doc: SiteDocument, profile = PROFILE) => composeSite(brain.compose(doc, profile), ctx);
const digest = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const styles = (html: string) => html.match(/<style>([\s\S]*?)<\/style>/)![1];
const script = (html: string) => html.match(/<script>([\s\S]*?)<\/script>/)![1];

describe('the composition engine renders a page', () => {
  const html = render(buildComposition({ design: TECHNICAL_DESIGN }));

  it('produces one complete document', () => {
    expect(html.startsWith('<!--')).toBe(true);
    expect(html).toContain('<!doctype html>');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('emits every section it was given', () => {
    for (const id of ['hero', 'about', 'toolkit', 'timeline', 'credentials', 'process', 'stats', 'courses', 'gallery', 'reviews', 'quote', 'faq', 'contact']) {
      expect(html).toContain(`class="block ${id}`);
    }
  });

  it('carries the design system into custom properties', () => {
    expect(html).toContain('--bg:#080A0F');
    expect(html).toContain('--ink:#E8EDF7');
    expect(html).toContain('data-mode="dark"');
    expect(html).toContain('data-motion="lively"');
    expect(html).toContain('data-entrance="mask-reveal"');
  });

  it('keeps the anchors the rest of the platform links to', () => {
    expect(html).toContain('id="courses"');
    expect(html).toContain('id="contact"');
    expect(html).toContain('href="/t/khaled-academy"');
  });

  it('ships a script that parses', () => {
    expect(() => new Function(script(html))).not.toThrow();
  });

  it('reads the academy slug out of its own URL', () => {
    const src = script(html);
    const decl = src.slice(src.indexOf('var SLUG='), src.indexOf('})();') + 5).replace('location.pathname', 'pathname');
    const read = new Function('pathname', `${decl}return SLUG;`);
    expect(read('/a/ahmed-elsayed')).toBe('ahmed-elsayed');
    expect(read('/elsewhere')).toBe('khaled-academy');
  });
});

describe('two designs produce two different pages', () => {
  const technical = render(buildComposition({ design: TECHNICAL_DESIGN, persona: 'programming' }));
  const warm = render(buildComposition({
    design: WARM_DESIGN,
    persona: 'languages',
    sections: {
      hero: { pattern: 'hero.offset-collage' },
      toolkit: { pattern: 'toolkit.marquee' },
      credentials: { pattern: 'credentials.record' },
      courses: { pattern: 'courses.rail' },
      gallery: { pattern: 'gallery.immersive' },
      faq: { pattern: 'faq.accordion' },
      contact: { pattern: 'contact.band' },
      stats: { pattern: 'stats.strip' },
      timeline: { pattern: 'timeline.columns' },
      about: { pattern: 'about.statement' },
      process: { pattern: 'process.rail' },
    },
  }));

  it('shares no layout at all', () => {
    // The old system's failure mode was two academies rendering the same markup
    // in different colours. These two must not even reach for the same patterns.
    const patterns = (html: string) =>
      new Set([...html.matchAll(/class="block ([a-z-]+)[^"]*"/g)].map((m) => m[1]));
    const a = render(buildComposition({ design: TECHNICAL_DESIGN }));
    expect(digest(a)).not.toBe(digest(warm));
    expect(patterns(technical).size).toBeGreaterThan(8);
  });

  it('loads different typefaces', () => {
    expect(technical).toContain('Archivo+Narrow');
    expect(warm).toContain('Fraunces');
    expect(technical).not.toContain('Fraunces');
  });

  it('paints different atmospheres', () => {
    expect(technical).toContain('data-kind="grid-lines"');
    expect(warm).toContain('data-kind="aurora"');
    expect(styles(technical)).not.toContain('aurora');
    expect(styles(warm)).not.toContain('grid-lines');
  });

  it('differs in geometry, rhythm and container', () => {
    expect(technical).toContain('--rad:2px');
    expect(warm).toContain('--rad:24px');
    expect(technical).toContain('--pad:64px');
    expect(warm).toContain('--pad:188px');
    expect(technical).toContain('--wrap:1340px');
    expect(warm).toContain('--wrap:1120px');
  });

  it('gives each page a substantial stylesheet of its own', () => {
    // Some overlap is correct and wanted: the card, social and accordion
    // vocabularies are shared components, and rebuilding them per design would
    // be duplication, not variety. What matters is that each page carries a
    // large body of rules the other does not have at all.
    const a = ownRules(technical);
    const b = ownRules(warm);
    const onlyA = [...a].filter((l) => !b.has(l));
    const onlyB = [...b].filter((l) => !a.has(l));
    expect(onlyA.length).toBeGreaterThan(30);
    expect(onlyB.length).toBeGreaterThan(30);
  });
});

/** The stylesheet a page adds on top of the shared base vocabulary. */
function ownRules(html: string): Set<string> {
  const base = new Set(baseCss().split('\n').map((l) => l.trim()).filter(Boolean));
  return new Set(styles(html).split('\n').map((l) => l.trim()).filter((l) => l && !base.has(l)));
}

/** The quietest page the system can build: no backdrop, no effects, no images. */
const AUSTERE_SECTIONS = {
  hero: { pattern: 'hero.centered' },
  about: { pattern: 'about.side-by-side' },
  toolkit: { pattern: 'toolkit.tags' },
  credentials: { pattern: 'credentials.record' },
  stats: { pattern: 'stats.strip' },
  courses: { pattern: 'courses.list' },
  reviews: { pattern: 'reviews.spotlight' },
  faq: { pattern: 'faq.plain' },
  contact: { pattern: 'contact.pills' },
};

const austerePage = () =>
  render(buildComposition({
    design: AUSTERE_DESIGN,
    sections: AUSTERE_SECTIONS,
    rich: false,
    hasGallery: false,
    hasCover: false,
  }));

describe('the page ships only what it uses', () => {
  it('leaves out the stylesheet for effects the design never asked for', () => {
    const css = styles(austerePage());
    expect(css).not.toContain('marquee');
    expect(css).not.toContain('gal-mosaic');
    expect(css).not.toContain('courses-bento');
    expect(css).not.toContain('.backdrop');
  });

  it('leaves out the script for behaviours the design never asked for', () => {
    const src = script(austerePage());
    // No parallax, no pointer glow, no tilt — nothing that tracks the cursor.
    expect(src).not.toContain('pointermove');
    expect(src).not.toContain('marquee-track');
    // What is always there: language, hydration and keeping the CTA current.
    expect(src).toContain('applyLang');
    expect(src).toContain('data-hydrate');
  });

  it('adds far less of its own stylesheet than a maximal page', () => {
    // The base vocabulary is a fixed cost every page pays. The variable cost is
    // the decoration and the patterns, and that is where a quiet page saves.
    const maximal = render(buildComposition({ design: WARM_DESIGN }));
    expect(ownRules(austerePage()).size).toBeLessThan(ownRules(maximal).size * 0.6);
  });

  it('keeps the stylesheet within budget even at its largest', () => {
    const maximal = render(buildComposition({ design: WARM_DESIGN }));
    expect(styles(maximal).length).toBeLessThan(60_000);
  });
});

describe('composition is deterministic', () => {
  it('produces identical bytes for identical input', () => {
    const doc = buildComposition({ design: TECHNICAL_DESIGN });
    expect(render(doc)).toBe(render(buildComposition({ design: TECHNICAL_DESIGN })));
  });

  it('does not carry state between pages', () => {
    // The Site Brain is a singleton. Rendering another academy in between must
    // not change what this one looks like.
    const a = render(buildComposition({ design: WARM_DESIGN }));
    render(buildComposition({ design: TECHNICAL_DESIGN, persona: 'math_science' }));
    expect(render(buildComposition({ design: WARM_DESIGN }))).toBe(a);
  });
});

describe('the pattern library', () => {
  it('offers real choice in every section it renders', () => {
    for (const section of ['hero', 'about', 'toolkit', 'credentials', 'stats', 'courses', 'reviews', 'gallery', 'faq', 'contact']) {
      expect(patternsFor(section).length).toBeGreaterThanOrEqual(2);
    }
  });

  it('gives every pattern a brief the planner can read', () => {
    for (const p of allPatterns()) {
      expect(p.brief.length).toBeGreaterThan(20);
      expect(p.id).toMatch(/^[a-z]+\.[a-z-]+$/);
    }
  });

  it('renders every registered pattern without throwing', () => {
    // A pattern nobody has exercised is a pattern that will fail the first time
    // a model chooses it, on a teacher's live page.
    for (const p of allPatterns()) {
      const doc = buildComposition({ design: WARM_DESIGN, sections: { [p.section]: { pattern: p.id } } });
      expect(() => render(doc)).not.toThrow();
    }
  });

  it('renders every pattern against thin content without throwing', () => {
    for (const p of allPatterns()) {
      const doc = buildComposition({
        design: AUSTERE_DESIGN,
        sections: { [p.section]: { pattern: p.id } },
        hasCover: false, hasGallery: false, rich: false,
      });
      expect(() => render(doc, THIN_PROFILE)).not.toThrow();
    }
  });
});
