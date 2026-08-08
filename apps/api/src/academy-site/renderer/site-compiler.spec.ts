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
  it('points the hero CTA at the courses section that actually exists', () => {
    const html = compileSite(plan([heroBlock(), coursesBlock()]), ctx);

    // The anchor used to be built from the HERO block's id, so it referenced an
    // element that was never rendered and the button did nothing at all.
    expect(html).toContain('href="#courses"');
    expect(html).toContain('id="courses"');
    expect(html).not.toContain('href="#courses-blk-hero"');
  });

  it('leaves the page when there is no courses section to scroll to', () => {
    const html = compileSite(plan([heroBlock()]), ctx);

    expect(html).not.toContain('href="#courses"');
    expect(html).toContain('href="/a/khaled-academy"');
  });

  it('never emits a dead anchor built from a block id', () => {
    const html = compileSite(plan([heroBlock(), coursesBlock()]), ctx);
    expect(html).not.toMatch(/href="#courses-[^"]+"/);
  });
});
