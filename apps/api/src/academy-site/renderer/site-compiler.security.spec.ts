import { RenderPlan } from '../pipeline/contracts';
import { SiteBlock, SiteTheme } from '../schema/site-document';
import { fixtureContext } from '../__fixtures__/site-doc.fixture';
import { compileSite } from './site-compiler';

/**
 * Everything the model writes is untrusted, and so is everything the teacher
 * pastes into their facts. Both end up inside the same HTML document as the
 * page's own script.
 *
 * The current design keeps that safe structurally: the model emits enums,
 * bounded numbers and hex, and every piece of prose passes through escapeHtml on
 * its way into markup. These tests pin that property in place, so the richer
 * composition model cannot quietly acquire a field whose value reaches the page
 * unescaped.
 */

const PAYLOADS = [
  '<script>alert(1)</script>',
  '"><script>alert(1)</script>',
  '" onload="alert(1)',
  "' onerror='alert(1)",
  '</title><script>alert(1)</script>',
  '</style><script>alert(1)</script>',
  'javascript:alert(1)',
  '<img src=x onerror=alert(1)>',
];

const hostile = PAYLOADS.join(' ');
const lt = (s: string) => ({ ar: s, en: s });

function planWith(
  blocks: SiteBlock[],
  theme: Partial<SiteTheme> = {},
  seo?: RenderPlan['seo'],
): RenderPlan {
  return {
    theme: { primary: '#4A32C9', accent: '#E3B341', defaultLang: 'ar', preset: 'warm', ...theme } as SiteTheme,
    seo: seo ?? { title: lt('عنوان'), description: lt('وصف') },
    blocks: blocks.map((block) => ({ block, variant: '' })),
    verdicts: [],
  };
}

/** The page's own script, which is the only script the document may contain. */
function pageScripts(html: string): string[] {
  return html.match(/<script\b[^>]*>/gi) ?? [];
}

/**
 * The document with the platform's own inline script removed.
 *
 * That script legitimately contains markup as *string data* — it builds course
 * cards at view time — so scanning the raw document for `href="` or an event
 * handler finds the platform's own template and reports it as an injection.
 * Every assertion about what reached the page as markup runs on this instead.
 */
function markup(html: string): string {
  return html.replace(/<script>[\s\S]*?<\/script>/g, '<script></script>');
}

/**
 * Every tag in the emitted markup, with its attribute *values* blanked out.
 *
 * Escaped copy legitimately contains strings like `onerror=` and `javascript:`
 * — a teacher may write about them — and once escaped they sit harmlessly
 * inside a quoted value. What matters is the attribute *names* and the URL
 * attributes, so those are what these tests look at.
 */
function tags(html: string): string[] {
  return (markup(html).match(/<[a-z][a-z0-9]*\b[^>]*>/gi) ?? []).map((t) =>
    t.replace(/="[^"]*"/g, '=""'),
  );
}

/** Every href/src value in the emitted markup. */
function urls(html: string): string[] {
  return [...markup(html).matchAll(/\b(?:href|src)="([^"]*)"/gi)].map((m) => m[1]);
}

describe('compileSite — hostile copy cannot become markup', () => {
  const blocks: SiteBlock[] = [
    { type: 'hero', id: 'h', headline: lt(hostile), subheadline: lt(hostile), ctaLabel: lt(hostile) },
    { type: 'about', id: 'a', heading: lt(hostile), body: lt(hostile) },
    { type: 'toolkit', id: 't', heading: lt(hostile), items: [lt(hostile), hostile] },
    { type: 'credentials', id: 'c', heading: lt(hostile), items: [lt(hostile), hostile] },
    { type: 'stats', id: 's', heading: lt(hostile), items: [{ label: lt(hostile), value: hostile }] },
    { type: 'faq', id: 'f', heading: lt(hostile), items: [{ q: lt(hostile), a: lt(hostile) }] },
    { type: 'cta', id: 'x', headline: lt(hostile), buttonLabel: lt(hostile) },
    { type: 'courses', id: 'co', heading: lt(hostile), mode: 'auto', limit: 6 },
    { type: 'reviews', id: 'r', heading: lt(hostile), mode: 'auto', limit: 6 },
    { type: 'contact', id: 'ct', heading: lt(hostile), socials: [{ platform: hostile.slice(0, 30), url: 'https://example.com/x' }] },
  ];

  const html = compileSite(
    planWith(blocks, {}, { title: lt(hostile), description: lt(hostile) }),
    fixtureContext(),
  );

  it('emits exactly one script tag — the page\'s own', () => {
    expect(pageScripts(html)).toHaveLength(1);
    expect(pageScripts(html)[0]).toBe('<script>');
  });

  it('never emits an injected script, anywhere', () => {
    expect(markup(html)).not.toContain('<script>alert(1)</script>');
    expect(markup(html)).not.toContain('<img src=x');
  });

  it('gives no element an event handler', () => {
    // The payload survives as escaped *text*, where `onerror=` is just letters.
    // What must never happen is one becoming an attribute of a real element.
    expect(tags(html).filter((t) => / on[a-z]+\s*=/i.test(t))).toEqual([]);
  });

  it('never routes a url attribute through a script scheme', () => {
    expect(urls(html).filter((u) => /^\s*javascript:/i.test(u))).toEqual([]);
  });

  it('escapes the payload rather than dropping it', () => {
    // Silently discarding hostile-looking text would mangle legitimate copy that
    // happens to contain a quote or an angle bracket. It must survive, escaped.
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('keeps quotes out of attribute position', () => {
    // The bilingual span carries both languages in data-ar/data-en. An unescaped
    // quote there breaks out of the attribute and is the shortest path to script.
    for (const m of html.matchAll(/data-(?:ar|en)="([^"]*)"/g)) {
      expect(m[1]).not.toContain('<');
      expect(m[1]).not.toContain('"');
    }
  });

  it('escapes the SEO title and description', () => {
    const title = html.match(/<title>([\s\S]*?)<\/title>/)![1];
    expect(title).not.toContain('<');
    const desc = html.match(/<meta name="description" content="([^"]*)"/)![1];
    expect(desc).not.toContain('"');
  });
});

describe('compileSite — hostile URLs never become links', () => {
  it('drops a javascript: social link', () => {
    const html = compileSite(
      planWith([
        {
          type: 'contact',
          id: 'ct',
          heading: lt('تواصل'),
          socials: [
            { platform: 'evil', url: 'javascript:alert(1)' },
            { platform: 'ok', url: 'https://example.com/good' },
          ],
        },
      ]),
      fixtureContext(),
    );
    expect(markup(html)).not.toContain('javascript:');
    expect(html).toContain('https://example.com/good');
  });

  it('drops a javascript: media url on the hero and the gallery', () => {
    const ctx = fixtureContext({ media: () => ({ url: 'javascript:alert(1)' }) });
    const html = compileSite(
      planWith([
        { type: 'hero', id: 'h', headline: lt('x y z'), subheadline: lt('s'), ctaLabel: lt('c'), mediaId: 'm' },
        { type: 'gallery', id: 'g', heading: lt('g'), mediaIds: ['m'] },
      ]),
      ctx,
    );
    expect(markup(html)).not.toContain('javascript:');
  });

  it('sends every call to action to the platform-owned destination', () => {
    // No variant may invent a href. The compiler resolves one destination and
    // every button uses it, so a composition can never point a visitor elsewhere.
    const html = compileSite(
      planWith([
        { type: 'hero', id: 'h', headline: lt('a b c'), subheadline: lt('s'), ctaLabel: lt('go') },
        { type: 'cta', id: 'x', headline: lt('h'), buttonLabel: lt('b') },
      ]),
      fixtureContext(),
    );
    const hrefs = [...markup(html).matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((m) => m[1]);
    const unexpected = hrefs.filter(
      (h) => !(h.startsWith('#') || h === '/t/khaled-academy' || h.startsWith('https://')),
    );
    expect(unexpected).toEqual([]);
  });
});

describe('compileSite — the design system cannot escape into CSS', () => {
  const inject = (over: Partial<NonNullable<SiteTheme['design']>>) =>
    compileSite(
      planWith([{ type: 'hero', id: 'h', headline: lt('a b c'), subheadline: lt('s'), ctaLabel: lt('go') }], {
        design: {
          background: '#0B1020', ink: '#F2F5FF', surface: '#141B33',
          radius: 6, density: 'airy', headingScale: 'dramatic', heroTreatment: 'mesh',
          ...over,
        } as NonNullable<SiteTheme['design']>,
      }),
      fixtureContext(),
    );

  it('ignores a colour that is not six-digit hex', () => {
    // The document schema enforces hex, but recompilePublished() casts a stored
    // JSON column straight into the renderer without re-parsing it. The renderer
    // is the last line of defence and has to hold on its own.
    const html = inject({ background: 'red;} body{display:none' as never });
    expect(html).not.toContain('body{display:none');
    expect(html).not.toContain('--bg:red');
  });

  it('closes no rule and opens no tag from a palette value', () => {
    const html = inject({ ink: '</style><script>alert(1)</script>' as never });
    expect(pageScripts(html)).toHaveLength(1);
    expect(html).not.toContain('</style><script>');
  });

  it('clamps a radius outside the supported range', () => {
    const html = inject({ radius: 9999 as never });
    expect(html).not.toContain('--rad:9999px');
  });

  it('falls back when an enum is not one we know', () => {
    const html = inject({ density: 'enormous' as never, headingScale: 'huge' as never });
    expect(html).toContain('--pad:104px');
    expect(html).toContain('--h2:clamp(1.9rem,4vw,2.9rem)');
  });

  it('leaves a valid design completely untouched', () => {
    const html = inject({});
    expect(html).toContain('--bg:#0B1020');
    expect(html).toContain('--ink:#F2F5FF');
    expect(html).toContain('--surface:#141B33');
    expect(html).toContain('--rad:6px');
  });
});
