import { DesignRulesService } from '../../pipeline/design-rules.service';
import { SiteBrainService } from '../../pipeline/site-brain.service';
import { SiteBlock, SiteDocument } from '../../schema/site-document';
import { PROFILE, WARM_DESIGN, buildComposition } from '../../__fixtures__/composition.fixture';
import { fixtureContext } from '../../__fixtures__/site-doc.fixture';
import { composeSite } from './compile';
import { allPatterns } from './registry';
import './patterns';

/**
 * The composition system gives the model far more to say. This is the file that
 * proves it did not also give it more to break.
 *
 * The guarantee is structural rather than defensive: there is no field in a
 * composition that can hold markup, a class name, a URL or code, and every piece
 * of prose passes through escapeHtml on its way into the page. These tests hold
 * that property in place as the vocabulary grows.
 */

const brain = new SiteBrainService(new DesignRulesService());
const ctx = fixtureContext();
const render = (doc: SiteDocument) => composeSite(brain.compose(doc, PROFILE), ctx);

const PAYLOADS = [
  '<script>alert(1)</script>',
  '"><script>alert(1)</script>',
  '" onload="alert(1)',
  "' onerror='alert(1)",
  '</style><script>alert(1)</script>',
  'javascript:alert(1)',
  '<img src=x onerror=alert(1)>',
  '"></div><iframe src="//evil.test">',
];
const hostile = PAYLOADS.join(' ');
const lt = (s: string) => ({ ar: s, en: s });

const markup = (html: string) => html.replace(/<script>[\s\S]*?<\/script>/g, '<script></script>');
const tags = (html: string) =>
  (markup(html).match(/<[a-z][a-z0-9]*\b[^>]*>/gi) ?? []).map((t) => t.replace(/="[^"]*"/g, '=""'));
const urls = (html: string) =>
  [...markup(html).matchAll(/\b(?:href|src)="([^"]*)"/gi)].map((m) => m[1]);

/** Every text-bearing field on the page, filled with the payload. */
function hostileDoc(): SiteDocument {
  const doc = buildComposition({ design: WARM_DESIGN });
  for (const b of doc.blocks as SiteBlock[]) {
    switch (b.type) {
      case 'hero':
        b.headline = lt(hostile); b.subheadline = lt(hostile); b.ctaLabel = lt(hostile); break;
      case 'about':
        b.heading = lt(hostile); b.body = lt(hostile); break;
      case 'toolkit':
      case 'credentials':
        b.heading = lt(hostile); b.items = [lt(hostile), hostile]; break;
      case 'stats':
        b.heading = lt(hostile); b.items = [{ label: lt(hostile), value: hostile }]; break;
      case 'timeline':
        b.heading = lt(hostile);
        b.items = [{ marker: lt(hostile), title: lt(hostile), body: lt(hostile) }]; break;
      case 'process':
        b.heading = lt(hostile); b.steps = [{ title: lt(hostile), body: lt(hostile) }]; break;
      case 'quote':
        b.text = lt(hostile); b.attribution = lt(hostile); break;
      case 'faq':
        b.heading = lt(hostile); b.items = [{ q: lt(hostile), a: lt(hostile) }]; break;
      case 'contact':
        b.heading = lt(hostile);
        b.socials = [{ platform: hostile.slice(0, 30), url: 'https://example.com/ok' }]; break;
      case 'courses':
      case 'reviews':
      case 'gallery':
        b.heading = lt(hostile); break;
    }
  }
  doc.seo = { title: lt(hostile), description: lt(hostile) };
  doc.rationale = hostile;
  return doc;
}

describe('hostile copy cannot become markup in a composed page', () => {
  const html = render(hostileDoc());

  it('emits exactly one script — the page\'s own', () => {
    expect(html.match(/<script\b[^>]*>/gi)).toEqual(['<script>']);
  });

  it('gives no element an event handler', () => {
    expect(tags(html).filter((t) => / on[a-z]+\s*=/i.test(t))).toEqual([]);
  });

  it('opens no tag the platform did not write', () => {
    expect(markup(html)).not.toContain('<iframe');
    expect(markup(html)).not.toContain('<img src=x');
  });

  it('escapes the payload rather than discarding it', () => {
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('keeps quotes and angle brackets out of attribute position', () => {
    for (const m of html.matchAll(/data-(?:ar|en)="([^"]*)"/g)) {
      expect(m[1]).not.toContain('<');
      expect(m[1]).not.toContain('"');
    }
  });

  it('never renders the design rationale at all', () => {
    // It is a note to the teacher in the Studio, not page content — the safest
    // treatment of a free-text field is for it never to reach the document.
    expect(html).not.toContain('rationale');
  });
});

describe('a composed page cannot point a visitor anywhere the platform did not choose', () => {
  it('routes every url attribute to a scheme we allow', () => {
    const doc = buildComposition({ design: WARM_DESIGN });
    const contact = doc.blocks.find((b) => b.type === 'contact');
    if (contact?.type === 'contact') {
      contact.socials = [
        { platform: 'evil', url: 'javascript:alert(1)' },
        { platform: 'ok', url: 'https://example.com/good' },
      ];
    }
    const html = render(doc);
    expect(urls(html).filter((u) => /^\s*javascript:/i.test(u))).toEqual([]);
    expect(html).toContain('https://example.com/good');
  });

  it('drops a media url that is not a url', () => {
    const doc = buildComposition({ design: WARM_DESIGN });
    const html = composeSite(
      brain.compose(doc, PROFILE),
      fixtureContext({ media: () => ({ url: 'javascript:alert(1)' }) }),
    );
    expect(markup(html)).not.toContain('javascript:');
  });

  it('sends every call to action to the platform-owned destination', () => {
    const html = render(buildComposition({ design: WARM_DESIGN }));
    const bad = [...markup(html).matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)]
      .map((m) => m[1])
      .filter((h) => !(h.startsWith('#') || h === '/t/khaled-academy' || h.startsWith('https://')));
    expect(bad).toEqual([]);
  });

  it('gives every outbound link the safe rel attributes', () => {
    const html = render(buildComposition({ design: WARM_DESIGN }));
    for (const tag of markup(html).match(/<a\b[^>]*href="https:[^"]*"[^>]*>/g) ?? []) {
      expect(tag).toContain('rel="noopener noreferrer nofollow"');
    }
  });
});

describe('a composition cannot escape into the stylesheet', () => {
  const styled = (mutate: (d: SiteDocument) => void) => {
    const doc = buildComposition({ design: structuredClone(WARM_DESIGN) });
    mutate(doc);
    return render(doc);
  };

  it('ignores a palette value that is not a colour', () => {
    const html = styled((d) => {
      d.theme.designSpec!.palette.background = 'red;} body{display:none' as never;
    });
    expect(html).not.toContain('body{display:none');
  });

  it('closes no rule from a geometry value', () => {
    const html = styled((d) => { d.theme.designSpec!.geometry.radius = 1e9; });
    expect(html).not.toContain('--rad:1000000000px');
  });

  it('ignores a pattern id that is not a pattern', () => {
    const html = styled((d) => {
      const hero = d.blocks.find((b) => b.type === 'hero');
      if (hero) hero.section = { pattern: '../../etc/passwd' };
    });
    expect(html).not.toContain('etc/passwd');
    expect(html).toContain('class="block hero');
  });

  it('emits no stylesheet for a pattern the page never rendered', () => {
    const html = render(buildComposition({
      design: WARM_DESIGN,
      sections: { hero: { pattern: 'hero.centered' } },
    }));
    const css = html.match(/<style>([\s\S]*?)<\/style>/)![1];
    expect(css).not.toContain('.hero-bento');
  });
});

describe('the pattern library holds the escaping invariant', () => {
  it('never interpolates block text without escaping it', () => {
    // A pattern that reaches for a raw value is the one way this system could
    // acquire an injection, and it would be invisible until a teacher pasted the
    // wrong thing into their bio. Rendering every pattern with the payload is
    // what catches it.
    for (const p of allPatterns()) {
      const doc = hostileDoc();
      const block = doc.blocks.find((b) => b.type === p.section);
      if (!block) continue;
      block.section = { pattern: p.id };
      const html = render(doc);
      expect(html.match(/<script\b[^>]*>/gi)).toEqual(['<script>']);
      expect(tags(html).filter((t) => / on[a-z]+\s*=/i.test(t))).toEqual([]);
    }
  });
});
