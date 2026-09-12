import { randomUUID } from 'crypto';
import { RENDERER_FIXED, SiteBlock, SiteDocument } from '../schema/site-document';
import { ListItem } from '../text.util';
import { FixedCopy } from './fixed-copy.schema';

/**
 * Turn generated copy into the one fixed page shape every academy gets.
 *
 * Unlike `compose-assembler.ts`, there is no layout to decide: the block order
 * is the reference design's section order, always. A block whose content ended
 * up empty is simply left out — the renderer already copes with a page missing
 * its gallery or its quote tile — rather than assembled with nothing in it.
 */
export interface AssembleFixedInput {
  copy: FixedCopy;
  primary: string;
  accent: string;
  logoId?: string;
  coverId?: string;
  galleryIds: string[];
  toolkit: ListItem[];
  credentials: ListItem[];
  socials: { platform: string; url: string }[];
  defaultLang?: 'ar' | 'en';
}

const bilingual = (ar: string, en: string) => ({ ar, en });
const filled = (lt: { ar?: string; en?: string } | undefined) =>
  !!(lt && ((lt.ar ?? '').trim() || (lt.en ?? '').trim()));

export function assembleFixed(input: AssembleFixedInput): SiteDocument {
  const { copy, toolkit, credentials, galleryIds, socials } = input;
  const blocks: SiteBlock[] = [];

  blocks.push({
    type: 'hero',
    id: randomUUID(),
    headline: copy.hero.headline,
    subheadline: copy.hero.subheadline,
    ctaLabel: copy.hero.ctaLabel,
    ...(input.coverId ? { mediaId: input.coverId } : {}),
  });

  blocks.push({ type: 'about', id: randomUUID(), heading: copy.about.heading, body: copy.about.body });

  if (toolkit.length) {
    blocks.push({
      type: 'toolkit',
      id: randomUUID(),
      heading: filled(copy.toolkitHeading) ? copy.toolkitHeading : bilingual('محاور المتابعة', 'What we cover'),
      items: toolkit,
    });
  }

  if (credentials.length) {
    blocks.push({
      type: 'credentials',
      id: randomUUID(),
      heading: filled(copy.credentialsHeading) ? copy.credentialsHeading : bilingual('الإنجازات', 'Track record'),
      items: credentials,
    });
  }

  // Live — resolved at render/hydration time, never frozen into the document.
  blocks.push({ type: 'courses', id: randomUUID(), heading: bilingual('الدورات', 'Courses'), mode: 'auto', limit: 12 });

  if (galleryIds.length) {
    blocks.push({
      type: 'gallery',
      id: randomUUID(),
      heading: bilingual('المعرض', 'Gallery'),
      mediaIds: galleryIds.slice(0, 12),
    });
  }

  // Exactly three, matching the reference's fixed "journey" step count.
  const steps = (copy.process ?? []).slice(0, 3);
  if (steps.length) {
    blocks.push({ type: 'process', id: randomUUID(), heading: bilingual('الطريقة', 'How it works'), steps });
  }

  // Exactly three, matching the reference's fixed FAQ count.
  const faq = copy.faq.slice(0, 3);
  if (faq.length) {
    blocks.push({ type: 'faq', id: randomUUID(), heading: bilingual('أسئلة شائعة', 'FAQ'), items: faq });
  }

  blocks.push({ type: 'contact', id: randomUUID(), heading: bilingual('تواصل معنا', 'Contact'), socials });

  // Optional pull-quote, in the teacher's own voice — the reference design has a
  // tile for it in the gallery grid but does not require one to exist.
  if (filled(copy.quote?.text)) {
    blocks.push({ type: 'quote', id: randomUUID(), text: copy.quote!.text, attribution: copy.quote!.attribution });
  }

  return {
    version: 1,
    renderer: { version: RENDERER_FIXED },
    theme: {
      primary: input.primary,
      accent: input.accent,
      ...(input.logoId ? { logoMediaId: input.logoId } : {}),
      ...(input.defaultLang ? { defaultLang: input.defaultLang } : {}),
    },
    seo: { title: copy.seo.metaTitle, description: copy.seo.metaDescription },
    blocks,
  };
}
