import { Archetype } from '../generation/planning.schema';
import { SiteDocument } from '../schema/site-document';
import { VariantSelectionContext } from '../renderer/variants';
import { buildFixtureDoc } from '../__fixtures__/site-doc.fixture';
import { DesignRulesService } from './design-rules.service';
import { SiteBrainService } from './site-brain.service';

/**
 * The Site Brain is the only thing that decides what a page looks like: which
 * sections appear, in what order, and which layout each one uses. The renderer
 * executes that decision without questioning it, so a mistake here is invisible
 * until a teacher sees their page.
 */

const brain = new SiteBrainService(new DesignRulesService());

const order = (doc: SiteDocument) => doc.blocks.map((b) => b.type);

function doc(over: Parameters<typeof buildFixtureDoc>[0]): SiteDocument {
  return buildFixtureDoc(over);
}

function ctx(over: Partial<VariantSelectionContext> = {}): VariantSelectionContext {
  return {
    dna: 'warm_mentor',
    archetype: 'general',
    preset: 'warm',
    hasHeroImage: false,
    hasAboutImage: false,
    bioLength: 120,
    subjectsCount: 5,
    achievementsCount: 3,
    galleryCount: 0,
    ...over,
  };
}

describe('SiteBrainService.arrange — section order', () => {
  it('opens with the hero and closes with contact, whatever the archetype', () => {
    for (const a of ['programming', 'math_science', 'languages', 'exam_prep', 'university', 'general'] as Archetype[]) {
      const d = doc({ dna: 'warm_mentor', persona: 'programming', hasGallery: true, withStats: true, withCta: true });
      brain.arrange(d, a);
      expect(order(d)[0]).toBe('hero');
      expect(order(d).slice(-2)).toEqual(['contact', 'cta']);
    }
  });

  it('leads a programming page with the courses and the toolkit', () => {
    const d = doc({ dna: 'royal_night', persona: 'programming', hasGallery: true, withStats: true });
    brain.arrange(d, 'programming');
    expect(order(d)).toEqual([
      'hero', 'courses', 'toolkit', 'about', 'credentials', 'stats', 'gallery', 'reviews', 'faq', 'contact',
    ]);
  });

  it('leads an exam-prep page with the track record and social proof', () => {
    const d = doc({ dna: 'bold_energetic', persona: 'math_science', hasGallery: true, withStats: true });
    brain.arrange(d, 'exam_prep');
    const seen = order(d);
    expect(seen.indexOf('credentials')).toBeLessThan(seen.indexOf('courses'));
    expect(seen.indexOf('reviews')).toBeLessThan(seen.indexOf('courses'));
    expect(seen.indexOf('reviews')).toBeLessThan(seen.indexOf('faq'));
  });

  it('leads a languages page with the method and moves reviews up', () => {
    const d = doc({ dna: 'creative_serif', persona: 'languages', hasGallery: true });
    brain.arrange(d, 'languages');
    const seen = order(d);
    expect(seen[1]).toBe('about');
    expect(seen.indexOf('reviews')).toBeLessThan(seen.indexOf('courses'));
  });

  it('keeps the document order when two sections rank equally', () => {
    // exam_prep puts credentials at 10, which is also `about`'s base rank. A
    // sort that is not stable would swap them at random between generations and
    // produce a different page from the same document.
    const d = doc({ dna: 'warm_mentor', persona: 'programming' });
    brain.arrange(d, 'exam_prep');
    const seen = order(d);
    expect(seen.indexOf('about')).toBeLessThan(seen.indexOf('credentials'));
  });

  it('is idempotent — arranging twice changes nothing', () => {
    const d = doc({ dna: 'warm_mentor', persona: 'programming', hasGallery: true, withStats: true });
    brain.arrange(d, 'university');
    const once = order(d);
    brain.arrange(d, 'university');
    expect(order(d)).toEqual(once);
  });

  it('never drops or duplicates a section', () => {
    const d = doc({ dna: 'warm_mentor', persona: 'languages', hasGallery: true, withStats: true, withCta: true });
    const before = [...order(d)].sort();
    brain.arrange(d, 'programming');
    expect([...order(d)].sort()).toEqual(before);
  });
});

describe('SiteBrainService.assignVariants — layout selection', () => {
  const variantOf = (d: SiteDocument, type: string) => d.blocks.find((b) => b.type === type)?.variant;

  it('gives a page with a cover photo the split hero', () => {
    const d = doc({ dna: 'warm_mentor', persona: 'programming', hasCover: true });
    brain.assignVariants(d, ctx({ hasHeroImage: true }));
    expect(variantOf(d, 'hero')).toBe('hero_02');
  });

  it('gives an editorial direction with no photo the statement hero', () => {
    const d = doc({ dna: 'editorial_dark', persona: 'languages' });
    brain.assignVariants(d, ctx({ dna: 'editorial_dark', hasHeroImage: false }));
    expect(variantOf(d, 'hero')).toBe('hero_03');
  });

  it('falls back to the centered hero for a plain direction with no photo', () => {
    const d = doc({ dna: 'warm_mentor', persona: 'math_science' });
    brain.assignVariants(d, ctx({ dna: 'warm_mentor', hasHeroImage: false }));
    expect(variantOf(d, 'hero')).toBe('hero_01');
  });

  it('uses the statement about only when the bio is long enough to carry it', () => {
    const d = doc({ dna: 'creative_serif', persona: 'languages' });
    brain.assignVariants(d, ctx({ dna: 'creative_serif', bioLength: 400 }));
    expect(variantOf(d, 'about')).toBe('about_02');

    const short = doc({ dna: 'creative_serif', persona: 'languages' });
    brain.assignVariants(short, ctx({ dna: 'creative_serif', bioLength: 80 }));
    expect(variantOf(short, 'about')).toBe('about_01');
  });

  it('switches credentials to cards once there are enough of them', () => {
    const few = doc({ dna: 'warm_mentor', persona: 'programming' });
    brain.assignVariants(few, ctx({ achievementsCount: 3 }));
    expect(variantOf(few, 'credentials')).toBe('credentials_01');

    const many = doc({ dna: 'warm_mentor', persona: 'programming' });
    brain.assignVariants(many, ctx({ achievementsCount: 7 }));
    expect(variantOf(many, 'credentials')).toBe('credentials_02');
  });

  it('assigns a registered variant to every block', () => {
    const d = doc({ dna: 'sunrise_warm', persona: 'programming', hasGallery: true, withStats: true, withCta: true });
    brain.assignVariants(d, ctx());
    for (const b of d.blocks) {
      expect(b.variant).toBeTruthy();
      expect(b.variant).toMatch(new RegExp(`^${b.type}_\\d+$`));
    }
  });

  it('makes the same choice every time for the same context', () => {
    const a = doc({ dna: 'editorial_dark', persona: 'programming', hasCover: true });
    const b = doc({ dna: 'editorial_dark', persona: 'programming', hasCover: true });
    brain.assignVariants(a, ctx({ dna: 'editorial_dark', hasHeroImage: true }));
    brain.assignVariants(b, ctx({ dna: 'editorial_dark', hasHeroImage: true }));
    expect(a.blocks.map((x) => x.variant)).toEqual(b.blocks.map((x) => x.variant));
  });
});

describe('SiteBrainService.plan — the renderer contract', () => {
  it('resolves every block to a concrete variant, even an unknown one', () => {
    const d = doc({ dna: 'warm_mentor', persona: 'programming' });
    d.blocks[0].variant = 'hero_does_not_exist';
    const plan = brain.plan(d);
    expect(plan.blocks[0].variant).toBe('hero_01');
    expect(plan.blocks).toHaveLength(d.blocks.length);
  });

  it('carries the theme, the SEO and the rule verdicts through untouched', () => {
    const d = doc({ dna: 'academic_precise', persona: 'math_science' });
    const plan = brain.plan(d);
    expect(plan.theme).toBe(d.theme);
    expect(plan.seo).toBe(d.seo);
    expect(Array.isArray(plan.verdicts)).toBe(true);
  });
});
