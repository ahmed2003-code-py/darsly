import { randomUUID } from 'crypto';
import { SectionSpec } from '../schema/design-spec';
import { RENDERER_COMPOSITION, SiteBlock, SiteDocument } from '../schema/site-document';
import { ListItem } from '../text.util';
import { ComposedSection, SiteComposition } from './composition.schema';
import { AiCopy } from './ai-copy.schema';

/**
 * Turning a composition and a body of copy into a Site Document.
 *
 * The old assembler emitted a fixed list of blocks in a fixed order and let the
 * Site Brain permute it. This one builds the page the composition asked for —
 * but only the parts of it the teacher actually has content for, which is why
 * the composition can be ambitious without producing empty bands.
 *
 * Everything here is deterministic. Given the same composition and the same
 * copy, it produces the same document, right down to the order of the blocks;
 * only the block ids are fresh.
 */

const bilingual = (ar: string, en: string) => ({ ar, en });
const filled = (lt: { ar?: string; en?: string } | undefined) =>
  !!(lt && ((lt.ar ?? '').trim() || (lt.en ?? '').trim()));

const DEFAULT_HEADINGS: Record<string, { ar: string; en: string }> = {
  toolkit: { ar: 'ما ستتعلمه', en: 'What you’ll learn' },
  credentials: { ar: 'لماذا تثق بنا', en: 'Track record' },
  stats: { ar: 'أرقام', en: 'By the numbers' },
  timeline: { ar: 'المسيرة', en: 'Journey' },
  process: { ar: 'الطريقة', en: 'How it works' },
  courses: { ar: 'الدورات', en: 'Courses' },
  gallery: { ar: 'معرض الصور', en: 'Gallery' },
  reviews: { ar: 'آراء الطلاب', en: 'Student Reviews' },
  faq: { ar: 'الأسئلة الشائعة', en: 'FAQ' },
  contact: { ar: 'تواصل معنا', en: 'Contact' },
};

const headingFor = (type: string, given?: { ar: string; en: string }) =>
  filled(given) ? given! : bilingual(DEFAULT_HEADINGS[type]?.ar ?? '', DEFAULT_HEADINGS[type]?.en ?? '');

export interface AssembleInput {
  composition: SiteComposition;
  copy: AiCopy;
  media: { logoId?: string; coverId?: string; galleryIds: string[] };
  lists: { toolkit: ListItem[]; credentials: ListItem[] };
  socials: { platform: string; url: string }[];
  defaultLang?: 'ar' | 'en';
}

/** The section spec for a block, carried straight from the composition. */
function specOf(s: ComposedSection): SectionSpec {
  return {
    pattern: s.pattern,
    emphasis: s.emphasis,
    width: s.width,
    surface: s.surface,
    align: s.align,
    columns: s.columns,
    accents: s.accents.slice(0, 2),
    imageTreatment: s.imageTreatment,
  };
}

/**
 * Build the document.
 *
 * A section the composition asked for but the teacher cannot fill is simply not
 * emitted — silently, because the composition stage was already told what was
 * available and the alternative is a page with a heading and nothing under it.
 */
export function assembleComposition(input: AssembleInput): SiteDocument {
  const { composition, copy, media, lists, socials, defaultLang } = input;
  const blocks: SiteBlock[] = [];
  const seen = new Set<string>();

  for (const section of composition.sections) {
    // One of each. A composition that asks for two hero sections gets one.
    if (seen.has(section.type)) continue;
    const block = buildBlock(section, input);
    if (!block) continue;
    seen.add(section.type);
    blocks.push(block);
  }

  // Anything the page needs and the composition left out. `about` goes straight
  // under the hero, where a visitor asks "who is this?"; the rest join the end of
  // the middle band. Appending everything would put the teacher's introduction
  // after the FAQ, which is worse than the omission it fixes.
  for (const section of missingEssentials(seen, input)) {
    const block = buildBlock(section, input);
    if (!block) continue;
    seen.add(section.type);
    if (section.type === 'about') {
      const heroAt = blocks.findIndex((b) => b.type === 'hero');
      blocks.splice(heroAt + 1, 0, block);
    } else {
      blocks.push(block);
    }
  }

  // The hero opens the page and contact closes it, whatever order was proposed.
  // These two are navigation, not composition: the CTA scroll target and the
  // in-page contact anchor both depend on them being where visitors expect.
  const hero = blocks.find((b) => b.type === 'hero');
  const contact = blocks.find((b) => b.type === 'contact');
  const middle = blocks.filter((b) => b !== hero && b !== contact);
  const ordered = [...(hero ? [hero] : []), ...middle, ...(contact ? [contact] : [])];

  return {
    version: 1,
    renderer: { version: RENDERER_COMPOSITION },
    theme: {
      primary: composition.design.palette.primary,
      accent: composition.design.palette.accent,
      ...(media.logoId ? { logoMediaId: media.logoId } : {}),
      archetype: composition.archetype,
      ...(defaultLang ? { defaultLang } : {}),
      designSpec: composition.design,
    },
    seo: { title: copy.seo.metaTitle, description: copy.seo.metaDescription },
    rationale: composition.rationale.slice(0, 400),
    blocks: ordered,
  };
}

/**
 * The sections a landing page does not get to skip.
 *
 * The composition stage is free to design the page, but it is not free to leave
 * out the things a visitor came for. Given the choice it will happily return
 * eight handsome sections with no course list, no social proof and no answer to
 * "how do I start?" — a page that looks designed and sells nothing.
 *
 * So anything essential the teacher has content for and the composition did not
 * ask for is appended here, laid out by the best pattern that content can carry.
 * Ordered by how much each one is missed.
 */
function missingEssentials(present: Set<string>, input: AssembleInput): ComposedSection[] {
  const { copy, media, lists, socials } = input;
  const wanted: { type: ComposedSection['type']; has: boolean }[] = [
    { type: 'about', has: filled(copy.about.body) },
    { type: 'courses', has: true },
    { type: 'credentials', has: lists.credentials.length > 0 },
    { type: 'toolkit', has: lists.toolkit.length > 0 },
    { type: 'reviews', has: true },
    { type: 'faq', has: copy.faq.length > 0 },
    { type: 'gallery', has: media.galleryIds.length > 0 },
    { type: 'contact', has: socials.length > 0 },
  ];

  const out: ComposedSection[] = [];
  for (const { type, has } of wanted) {
    if (present.has(type) || !has) continue;
    out.push({
      type,
      // Deliberately empty: the Site Brain resolves it against the registry with
      // the real content profile at render time, which knows more here than a
      // guess made during assembly ever could.
      pattern: '',
      emphasis: 'normal',
      width: 'standard',
      surface: 'page',
      align: type === 'contact' ? 'center' : 'start',
      columns: 3,
      accents: [],
      imageTreatment: 'rounded',
    });
  }
  return out;
}

function buildBlock(section: ComposedSection, input: AssembleInput): SiteBlock | null {
  const { composition, copy, media, lists, socials } = input;
  const spec = specOf(section);
  const id = randomUUID();
  const plan = composition.content;

  switch (section.type) {
    case 'hero':
      return {
        type: 'hero', id, section: spec,
        headline: copy.hero.headline,
        subheadline: copy.hero.subheadline,
        ctaLabel: copy.hero.ctaLabel,
        ...(media.coverId ? { mediaId: media.coverId } : {}),
      };

    case 'about':
      return filled(copy.about.body)
        ? { type: 'about', id, section: spec, heading: copy.about.heading, body: copy.about.body }
        : null;

    case 'toolkit':
      return lists.toolkit.length
        ? { type: 'toolkit', id, section: spec, heading: headingFor('toolkit', copy.toolkitHeading), items: lists.toolkit }
        : null;

    case 'credentials':
      return lists.credentials.length
        ? { type: 'credentials', id, section: spec, heading: headingFor('credentials', copy.credentialsHeading), items: lists.credentials }
        : null;

    case 'stats': {
      const items = (copy.stats ?? []).slice(0, Math.min(6, plan.statCount || 6));
      return items.length
        ? { type: 'stats', id, section: spec, heading: headingFor('stats', copy.statsHeading), items }
        : null;
    }

    case 'timeline': {
      const items = (copy.timeline ?? []).slice(0, Math.min(8, plan.timelineCount || 8));
      return items.length >= 2
        ? { type: 'timeline', id, section: spec, heading: headingFor('timeline', copy.timelineHeading), items }
        : null;
    }

    case 'process': {
      const steps = (copy.process ?? []).slice(0, Math.min(6, plan.processCount || 6));
      return steps.length >= 2
        ? { type: 'process', id, section: spec, heading: headingFor('process', copy.processHeading), steps }
        : null;
    }

    case 'quote':
      return plan.includeQuote && filled(copy.quote?.text)
        ? { type: 'quote', id, section: spec, text: copy.quote!.text, attribution: copy.quote!.attribution }
        : null;

    case 'courses':
      return {
        type: 'courses', id, section: spec,
        heading: headingFor('courses'), mode: 'auto', limit: 6,
      };

    case 'gallery':
      return media.galleryIds.length
        ? { type: 'gallery', id, section: spec, heading: headingFor('gallery'), mediaIds: media.galleryIds.slice(0, 12) }
        : null;

    case 'reviews':
      return { type: 'reviews', id, section: spec, heading: headingFor('reviews'), mode: 'auto', limit: 6 };

    case 'faq': {
      // Four, not eight. An FAQ is the least persuasive thing on a teacher's
      // page and the easiest for a model to pad, and a wall of accordions at the
      // bottom is what makes a site read as a support article.
      const items = copy.faq.slice(0, Math.max(1, Math.min(5, plan.faqCount || 4)));
      return items.length ? { type: 'faq', id, section: spec, heading: headingFor('faq'), items } : null;
    }

    case 'contact':
      return { type: 'contact', id, section: spec, heading: headingFor('contact'), socials };

    case 'cta':
      return filled(copy.cta.headline)
        ? { type: 'cta', id, section: spec, headline: copy.cta.headline, buttonLabel: copy.cta.buttonLabel }
        : null;

    default:
      return null;
  }
}

/**
 * The page every teacher gets when the composition stage produced nothing
 * usable: a complete, ordered, competent site with no model input at all.
 */
export function fallbackSections(): ComposedSection[] {
  const at = (type: ComposedSection['type'], pattern: string, over: Partial<ComposedSection> = {}): ComposedSection => ({
    type, pattern,
    emphasis: 'normal', width: 'standard', surface: 'page', align: 'start',
    columns: 3, accents: [], imageTreatment: 'rounded',
    ...over,
  });
  return [
    at('hero', 'hero.centered', { emphasis: 'feature', align: 'center' }),
    at('about', 'about.side-by-side'),
    at('toolkit', 'toolkit.tags', { surface: 'raised' }),
    at('credentials', 'credentials.record'),
    at('courses', 'courses.grid'),
    at('gallery', 'gallery.mosaic'),
    at('reviews', 'reviews.cards', { surface: 'raised' }),
    at('faq', 'faq.accordion'),
    at('contact', 'contact.pills', { align: 'center' }),
  ];
}
