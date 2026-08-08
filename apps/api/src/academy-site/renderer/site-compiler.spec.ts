import { RenderPlan } from '../pipeline/contracts';
import { compileSite } from './site-compiler';
import { RenderContext } from './types';

/**
 * The generated academy site is the first thing a visitor touches, and a link
 * that goes nowhere costs a sale silently. These pin the destinations.
 */

const ctx: RenderContext = {
  academyName: 'أكاديمية خالد',
  slug: 'khaled-academy',
  defaultLang: 'ar',
  media: () => undefined,
};

const lt = (ar: string) => ({ ar, en: ar });

function heroBlock(id = 'blk-hero') {
  return {
    id,
    type: 'hero' as const,
    headline: lt('اتعلم صح'),
    subheadline: lt('مع أفضل المدرسين'),
    ctaLabel: lt('ابدأ الآن'),
  };
}

function coursesBlock(id = 'blk-courses') {
  return { id, type: 'courses' as const, heading: lt('الدورات'), limit: 6 };
}

function contactBlock(id = 'blk-contact') {
  return { id, type: 'contact' as const, heading: lt('تواصل معنا'), socials: [] };
}

function plan(blocks: any[]): RenderPlan {
  return {
    blocks: blocks.map((block) => ({ block, variant: undefined })),
    theme: { defaultLang: 'ar', preset: 'warm' },
  } as unknown as RenderPlan;
}

describe('compileSite — call-to-action destinations', () => {
  it('sends the hero CTA to the teacher course gallery', () => {
    const html = compileSite(plan([heroBlock(), coursesBlock()]), ctx);

    // A visitor who taps "start" is ready to enrol, so they land in the gallery
    // (sign-in gated) rather than being scrolled down the marketing page.
    expect(html).toContain('href="/t/khaled-academy"');
    // The anchor used to be built from the HERO block's id, so it referenced an
    // element that was never rendered and the button did nothing at all.
    expect(html).not.toContain('href="#courses-blk-hero"');
  });

  it('uses the same destination whether or not the page lists courses', () => {
    const withCourses = compileSite(plan([heroBlock(), coursesBlock()]), ctx);
    const without = compileSite(plan([heroBlock()]), ctx);

    expect(withCourses).toContain('href="/t/khaled-academy"');
    expect(without).toContain('href="/t/khaled-academy"');
  });

  it('still gives the courses section a stable anchor for in-page links', () => {
    expect(compileSite(plan([heroBlock(), coursesBlock()]), ctx)).toContain('id="courses"');
  });

  it('breaks out of the iframe the app renders it in', () => {
    const html = compileSite(plan([heroBlock(), coursesBlock()]), ctx);
    // Without target="_top" the click navigates the frame, the address bar keeps
    // saying /a/<slug>, and the next refresh throws the visitor back here.
    expect(html).toContain('target="_top" href="/t/khaled-academy"');
    // In-page anchors must NOT break out — that would navigate the parent window
    // to this raw HTML document.
    expect(html).not.toContain('target="_top" href="#');
  });

  it('never emits a dead anchor built from a block id', () => {
    const html = compileSite(plan([heroBlock(), coursesBlock()]), ctx);
    expect(html).not.toMatch(/href="#courses-[^"]+"/);
  });
});

describe('compileSite — the AI-composed design system', () => {
  const design = {
    background: '#0B1020',
    ink: '#F2F5FF',
    surface: '#141B33',
    radius: 4,
    density: 'airy' as const,
    headingScale: 'dramatic' as const,
    heroTreatment: 'mesh' as const,
    bodyFont: 'serif' as const,
  };

  function themed(extra: Record<string, unknown>): RenderPlan {
    return {
      blocks: [{ block: heroBlock(), variant: undefined }],
      theme: { defaultLang: 'ar', preset: 'warm', ...extra },
    } as unknown as RenderPlan;
  }

  it('renders the palette, geometry and rhythm the model chose', () => {
    const html = compileSite(themed({ design }), ctx);

    expect(html).toContain('--bg:#0B1020');
    expect(html).toContain('--ink:#F2F5FF');
    expect(html).toContain('--surface:#141B33');
    expect(html).toContain('--rad:4px');
    expect(html).toContain('--pad:148px'); // airy
    expect(html).toContain('Fraunces'); // serif body
  });

  it('overrides the preset it was generated alongside', () => {
    // The DNA preset still sets a palette; the model's must win the cascade, or a
    // composed design would render as whichever catalogue entry came with it.
    const html = compileSite(themed({ design }), ctx);
    const presetAt = html.indexOf('data-preset=warm]{--bg:');
    const aiAt = html.lastIndexOf('--bg:#0B1020');
    expect(presetAt).toBeGreaterThan(-1);
    expect(aiAt).toBeGreaterThan(presetAt);
  });

  it('falls back to the preset when the model composed nothing', () => {
    // An older document, or a response that failed validation, must still render
    // a competent page rather than an unstyled one.
    const html = compileSite(themed({}), ctx);
    expect(html).toContain('--pad:104px');
    expect(html).not.toContain('#0B1020');
    expect(html).toContain('data-preset=');
  });

  it('varies the hero backdrop with the chosen treatment', () => {
    const mesh = compileSite(themed({ design }), ctx);
    const flat = compileSite(themed({ design: { ...design, heroTreatment: 'flat' as const } }), ctx);
    expect(mesh).not.toEqual(flat);
    expect(mesh).toContain('radial-gradient(46% 52% at 12% 8%');
  });
});

describe('compileSite — the page script is valid JavaScript', () => {
  /**
   * The script is assembled inside a server-side template literal, so any regex
   * literal in it has to survive a second round of escape processing. It did not:
   * `/\/a\/([^/?#]+)/` shipped as `//a/([^/?#]+)/`, a syntax error that took the
   * entire script down — no language toggle, and the course and review sections
   * stuck on their loading skeletons on every published page.
   *
   * Parsing the emitted source is the only check that catches this class of bug;
   * every string assertion in this file passed while the page was broken.
   */
  function script(html: string): string {
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    if (!m) throw new Error('the page emitted no script');
    return m[1];
  }

  it('parses', () => {
    const src = script(compileSite(plan([heroBlock(), coursesBlock()]), ctx));
    expect(() => new Function(src)).not.toThrow();
  });

  it('reads the academy slug out of its own URL', () => {
    const src = script(compileSite(plan([heroBlock()]), ctx));
    // A rename has to take effect on the next load, with no recompile — so the
    // slug is derived, and the baked-in one is only a fallback.
    // Just the slug resolver — running the whole script would need a DOM, and
    // this test is about the regex, not the page.
    const start = src.indexOf('var SLUG=');
    const decl = src.slice(start, src.indexOf('})();', start) + 5).replace('location.pathname', 'pathname');
    const read = new Function('pathname', `${decl}return SLUG;`);
    expect(read('/a/ahmed-elsayed')).toBe('ahmed-elsayed');
    expect(read('/a/ahmed-elsayed?lang=en')).toBe('ahmed-elsayed');
    expect(read('/somewhere/else')).toBe('khaled-academy');
  });
});

describe('compileSite — the page is designed, not just typeset', () => {
  it('accents the closing words of a headline', () => {
    const html = compileSite(plan([heroBlock()]), ctx);
    // "اتعلم صح" is two words — too short to split without looking like a
    // mistake — so a longer headline is what proves the gradient is applied.
    const long = compileSite(
      plan([{ ...heroBlock(), headline: lt('اتعلم الرياضيات مع خالد') }]),
      ctx,
    );
    expect(long).toContain('class="grad"');
    expect(html).not.toContain('class="grad"');
  });

  it('gives the hero a second action for visitors who are not ready to enrol', () => {
    const html = compileSite(plan([heroBlock(), contactBlock()]), ctx);
    expect(html).toContain('href="#contact"');
    expect(html).toContain('id="contact"');
  });

  it('honours a visitor who asked for less motion', () => {
    const html = compileSite(plan([heroBlock()]), ctx);
    const calm = html.slice(html.indexOf('@media(prefers-reduced-motion:reduce)'));
    // The gradient headline is animated but its fill is not decoration — killing
    // the animation without pinning the background position renders it invisible.
    expect(calm).toContain('.grad{animation:none;background-position:0 50%}');
    expect(calm).toContain('.hero-aura i');
  });
});

describe('compileSite — motion is the model\'s decision', () => {
  const design = {
    background: '#0B1020', ink: '#EEF2FF', surface: '#141B33',
    radius: 8, density: 'airy' as const, headingScale: 'dramatic' as const,
    heroTreatment: 'mesh' as const, bodyFont: 'sans' as const,
  };
  const withMotion = (motion?: 'calm' | 'lively' | 'cinematic') =>
    compileSite(
      {
        blocks: [{ block: heroBlock(), variant: undefined }],
        theme: { defaultLang: 'ar', preset: 'warm', primary: '#4A32C9', accent: '#F0A', design: { ...design, ...(motion ? { motion } : {}) } },
      } as unknown as RenderPlan,
      ctx,
    );

  it('carries the chosen intensity to the page', () => {
    expect(withMotion('calm')).toContain('data-motion="calm"');
    expect(withMotion('cinematic')).toContain('data-motion="cinematic"');
  });

  it('leaves a document written before the choice existed exactly as it was', () => {
    // `lively` is what every page already did; defaulting anywhere else would
    // silently restyle every site published so far.
    expect(withMotion()).toContain('data-motion="lively"');
  });

  it('keeps a calm page designed rather than stripped', () => {
    const calm = withMotion('calm');
    // Dimmed and slowed, never stopped. Asked to choose, the model answers calm
    // almost every time, so calm decides how most pages look — and a calm that
    // switched the motion off is exactly the unfinished look this replaced.
    // Only prefers-reduced-motion stops anything.
    expect(calm).toContain('[data-motion=calm] .hero-aura{opacity:.42');
    expect(calm).not.toMatch(/\[data-motion=calm\][^\n]*animation:none/);
  });
});
