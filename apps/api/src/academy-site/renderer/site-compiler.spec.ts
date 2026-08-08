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
