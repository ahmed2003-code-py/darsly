import { DesignSpec, SectionSpec } from '../schema/design-spec';
import { ContentProfile } from '../pipeline/content-profile';
import { RENDERER_COMPOSITION, SiteBlock, SiteDocument } from '../schema/site-document';
import { GALLERY_IDS, PERSONAS } from './site-doc.fixture';

/**
 * Fixtures for the composition engine.
 *
 * Deliberately opinionated rather than neutral: each design here is one a real
 * teacher could plausibly be given, because a fixture that sets every axis to
 * its middle value proves only that the middle values work.
 */

const lt = (ar: string, en: string) => ({ ar, en });

export const PROFILE: ContentProfile = {
  hasCover: true, hasLogo: true, galleryCount: 6, bioLength: 340,
  subjectsCount: 5, achievementsCount: 4,
  courseCount: 6, reviewCount: 8, avgRating: 4.8,
  bioParagraphs: 2, avgAchievementLength: 48,
};

export const THIN_PROFILE: ContentProfile = {
  hasCover: false, hasLogo: false, galleryCount: 0, bioLength: 90,
  subjectsCount: 2, achievementsCount: 1,
  courseCount: 0, reviewCount: 0, avgRating: 0,
  bioParagraphs: 1, avgAchievementLength: 20,
};

/** A dark, technical, hard-edged system — a programming teacher. */
export const TECHNICAL_DESIGN: DesignSpec = {
  palette: {
    background: '#080A0F', ink: '#E8EDF7', surface: '#0F131C', surfaceAlt: '#141A26',
    primary: '#3DDC97', accent: '#5B8CFF', mode: 'dark',
  },
  typography: {
    headingFamily: 'condensed', bodyFamily: 'mono', scale: 'dramatic',
    headingWeight: 700, headingCase: 'upper', tracking: 'normal', measure: 'narrow',
  },
  geometry: { radius: 2, radiusStyle: 'uniform', border: 'hairline', shadow: 'none', grain: true },
  rhythm: { density: 'compact', sectionRhythm: 'alternating', containerWidth: 'wide', gutter: 'tight' },
  motion: { intensity: 'lively', entrance: 'mask-reveal', scrollFx: ['sticky-headings', 'counters'] },
  decoration: {
    backdrop: 'grid-lines', accents: ['corner-brackets', 'rule-lines'],
    dividers: 'notch', imageTreatment: 'grid-overlay',
  },
};

/** A light, warm, rounded system — a languages teacher. */
export const WARM_DESIGN: DesignSpec = {
  palette: {
    background: '#FFF9F2', ink: '#241A12', surface: '#FFF1E3', surfaceAlt: '#FCE8D6',
    primary: '#C2410C', accent: '#0F766E', mode: 'light',
  },
  typography: {
    headingFamily: 'serif', bodyFamily: 'sans', scale: 'dramatic',
    headingWeight: 700, headingCase: 'normal', tracking: 'wide', measure: 'wide',
  },
  geometry: { radius: 24, radiusStyle: 'uniform', border: 'none', shadow: 'soft', grain: false },
  rhythm: { density: 'expansive', sectionRhythm: 'even', containerWidth: 'standard', gutter: 'generous' },
  motion: { intensity: 'cinematic', entrance: 'rise', scrollFx: ['parallax', 'pointer-glow'] },
  decoration: {
    backdrop: 'aurora', accents: ['underline-swash', 'blob'],
    dividers: 'hairline', imageTreatment: 'mask-arch',
  },
};

/** A quiet, austere, typographic system — a university lecturer. */
export const AUSTERE_DESIGN: DesignSpec = {
  palette: {
    background: '#0E1116', ink: '#EDEAE3', surface: '#161A21', surfaceAlt: '#1B2029',
    primary: '#C8A96A', accent: '#C8A96A', mode: 'dark',
  },
  typography: {
    headingFamily: 'serif', bodyFamily: 'serif', scale: 'restrained',
    headingWeight: 600, headingCase: 'normal', tracking: 'normal', measure: 'wide',
  },
  geometry: { radius: 0, radiusStyle: 'uniform', border: 'strong', shadow: 'none', grain: true },
  rhythm: { density: 'expansive', sectionRhythm: 'even', containerWidth: 'narrow', gutter: 'normal' },
  motion: { intensity: 'calm', entrance: 'fade', scrollFx: ['sticky-headings'] },
  decoration: { backdrop: 'none', accents: ['rule-lines'], dividers: 'hairline', imageTreatment: 'plain' },
};

export const DESIGNS = { TECHNICAL_DESIGN, WARM_DESIGN, AUSTERE_DESIGN };

const s = (pattern: string, over: Partial<SectionSpec> = {}): SectionSpec => ({ pattern, ...over });

export interface ComposeFixtureOptions {
  design: DesignSpec;
  persona?: keyof typeof PERSONAS;
  sections?: Record<string, SectionSpec>;
  hasCover?: boolean;
  hasGallery?: boolean;
  /** Include the section types the composition pipeline can now emit. */
  rich?: boolean;
}

/** A complete v3 document: design system, section specs, and content for both. */
export function buildComposition(opts: ComposeFixtureOptions): SiteDocument {
  const { design, persona = 'programming', sections = {}, hasCover = true, hasGallery = true, rich = true } = opts;
  const p = PERSONAS[persona];
  const at = (type: string, fallback: string, over?: Partial<SectionSpec>) =>
    sections[type] ?? s(fallback, over);

  const blocks: SiteBlock[] = [
    {
      type: 'hero', id: 'blk-hero',
      section: at('hero', hasCover ? 'hero.split-portrait' : 'hero.editorial'),
      headline: p.hero.headline, subheadline: p.hero.subheadline, ctaLabel: p.hero.ctaLabel,
      ...(hasCover ? { mediaId: 'media-cover' } : {}),
    },
    {
      type: 'about', id: 'blk-about', section: at('about', 'about.side-by-side'),
      heading: p.about.heading, body: p.about.body,
    },
    {
      type: 'toolkit', id: 'blk-toolkit', section: at('toolkit', 'toolkit.skill-matrix'),
      heading: lt('ما ستتعلمه', 'What you’ll learn'), items: p.toolkit,
    },
    {
      type: 'credentials', id: 'blk-credentials', section: at('credentials', 'credentials.cards'),
      heading: lt('لماذا تثق بنا', 'Track record'), items: p.credentials,
    },
    {
      type: 'stats', id: 'blk-stats', section: at('stats', 'stats.big-numbers'),
      heading: lt('أرقام', 'By the numbers'), items: p.stats,
    },
    {
      type: 'courses', id: 'blk-courses', section: at('courses', 'courses.bento'),
      heading: lt('الدورات', 'Courses'), mode: 'auto', limit: 6,
    },
    {
      type: 'reviews', id: 'blk-reviews', section: at('reviews', 'reviews.wall'),
      heading: lt('آراء الطلاب', 'Student Reviews'), mode: 'auto', limit: 6,
    },
    {
      type: 'faq', id: 'blk-faq', section: at('faq', 'faq.two-column'),
      heading: lt('الأسئلة الشائعة', 'FAQ'), items: p.faq,
    },
    {
      type: 'contact', id: 'blk-contact', section: at('contact', 'contact.split-cta'),
      heading: lt('تواصل معنا', 'Contact'),
      socials: [
        { platform: 'whatsapp', url: 'https://wa.me/201000000000' },
        { platform: 'youtube', url: 'https://youtube.com/@khaled' },
      ],
    },
  ];

  if (hasGallery) {
    blocks.splice(6, 0, {
      type: 'gallery', id: 'blk-gallery', section: at('gallery', 'gallery.mosaic'),
      heading: lt('معرض الصور', 'Gallery'), mediaIds: GALLERY_IDS,
    });
  }

  if (rich) {
    blocks.splice(3, 0, {
      type: 'timeline', id: 'blk-timeline', section: at('timeline', 'timeline.rail'),
      heading: lt('المسيرة', 'Journey'),
      items: [
        { marker: lt('٢٠١٦', '2016'), title: lt('بداية التدريس', 'Started teaching'), body: lt('أول مجموعة من عشرة طلاب.', 'A first group of ten students.') },
        { marker: lt('٢٠٢٠', '2020'), title: lt('التحول للأونلاين', 'Moved online'), body: lt('منهج كامل مسجل ومتابعة أسبوعية.', 'A full recorded syllabus with weekly follow-up.') },
        { marker: lt('٢٠٢٤', '2024'), title: lt('أكاديمية مستقلة', 'An academy of my own'), body: lt('فريق من ثلاثة مدرسين.', 'A team of three teachers.') },
      ],
    });
    blocks.splice(5, 0, {
      type: 'process', id: 'blk-process', section: at('process', 'process.numbered'),
      heading: lt('الطريقة', 'How it works'),
      steps: [
        { title: lt('تحديد المستوى', 'Placement'), body: lt('اختبار قصير قبل البداية.', 'A short check before we begin.') },
        { title: lt('الحصص', 'The lessons'), body: lt('حصتان أسبوعياً مع تسجيل.', 'Twice a week, with recordings.') },
        { title: lt('المتابعة', 'Follow-up'), body: lt('واجب ومراجعة كل أسبوع.', 'Homework and a review every week.') },
      ],
    });
    blocks.splice(8, 0, {
      type: 'quote', id: 'blk-quote', section: at('quote', 'quote.statement'),
      text: lt('الفهم أولاً، والتمرين بعده يبقى سهل.', 'Understanding first — the practice then takes care of itself.'),
      attribution: lt('خالد منصور', 'Khaled Mansour'),
    });
  }

  return {
    version: 1,
    renderer: { version: RENDERER_COMPOSITION },
    theme: {
      primary: design.palette.primary,
      accent: design.palette.accent,
      logoMediaId: 'media-logo',
      archetype: p.archetype,
      defaultLang: 'ar',
      designSpec: design,
    },
    seo: {
      title: lt('أكاديمية خالد — تعلم بثقة', 'Khaled Academy — learn with confidence'),
      description: lt('دروس عملية بشرح واضح.', 'Practical lessons, clearly explained.'),
    },
    blocks,
  };
}
