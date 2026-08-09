import { DESIGN_DNA_KEYS, DesignDnaKey, resolveDna } from '../pipeline/design-dna';
import { Archetype } from '../generation/planning.schema';
import { SiteBlock, SiteDocument, SiteTheme } from '../schema/site-document';
import { RenderContext, RenderMedia } from '../renderer/types';

/**
 * Deterministic fixtures for the generator's safety net.
 *
 * The golden tests exist to prove that a refactor of the renderer changes no
 * published page. That only works if every input is fixed: block ids are
 * literals rather than `randomUUID()`, media urls are stable, and the copy is
 * the same sentence every time. Nothing here may read the clock, the database
 * or the environment.
 */

export const FIXTURE_MEDIA: Record<string, RenderMedia> = {
  'media-logo': { url: '/media/logo.png', width: 256, height: 256 },
  'media-cover': { url: '/media/cover.jpg', width: 1600, height: 900 },
  'media-g1': { url: '/media/g1.jpg', width: 1200, height: 1200 },
  'media-g2': { url: '/media/g2.jpg', width: 1200, height: 1200 },
  'media-g3': { url: '/media/g3.jpg', width: 1200, height: 1200 },
  'media-g4': { url: '/media/g4.jpg', width: 1200, height: 1200 },
  'media-g5': { url: '/media/g5.jpg', width: 1200, height: 1200 },
  'media-g6': { url: '/media/g6.jpg', width: 1200, height: 1200 },
};

export const GALLERY_IDS = ['media-g1', 'media-g2', 'media-g3', 'media-g4', 'media-g5', 'media-g6'];

export function fixtureContext(over: Partial<RenderContext> = {}): RenderContext {
  return {
    academyName: 'أكاديمية خالد',
    ownerName: 'Khaled Mansour',
    slug: 'khaled-academy',
    defaultLang: 'ar',
    media: (id: string) => FIXTURE_MEDIA[id],
    ...over,
  };
}

const lt = (ar: string, en: string) => ({ ar, en });

/** One representative teacher per archetype, with the copy a good run produces. */
export interface Persona {
  archetype: Archetype;
  hero: { headline: { ar: string; en: string }; subheadline: { ar: string; en: string }; ctaLabel: { ar: string; en: string } };
  about: { heading: { ar: string; en: string }; body: { ar: string; en: string } };
  toolkit: { ar: string; en: string }[];
  credentials: { ar: string; en: string }[];
  stats: { label: { ar: string; en: string }; value: string }[];
  faq: { q: { ar: string; en: string }; a: { ar: string; en: string } }[];
}

export const PERSONAS: Record<'programming' | 'math_science' | 'languages', Persona> = {
  programming: {
    archetype: 'programming',
    hero: {
      headline: lt('اتعلم البرمجة بمشاريع حقيقية', 'Learn to code by shipping real projects'),
      subheadline: lt(
        'مسار عملي لطلاب الثانوي والجامعة يبدأ من الصفر وينتهي بمشروع كامل على GitHub.',
        'A hands-on track for school and university students, from zero to a finished project on GitHub.',
      ),
      ctaLabel: lt('ابدأ الآن', 'Start now'),
    },
    about: {
      heading: lt('طريقتي في الشرح', 'How I teach'),
      body: lt(
        'بشرح كل فكرة وانا بكتب الكود قدامك، مش على سلايدات.\nكل أسبوع بتسلم مشروع صغير وبناخد عليه مراجعة سطر بسطر.',
        'Every idea is explained while I write the code in front of you, not on slides.\nEach week you ship a small project and get a line-by-line review.',
      ),
    },
    toolkit: [
      lt('بايثون', 'Python'),
      lt('هياكل البيانات', 'Data Structures'),
      lt('قواعد البيانات', 'Databases'),
      lt('تطوير الويب', 'Web Development'),
      lt('Git والتعاون', 'Git & Collaboration'),
    ],
    credentials: [
      lt('مهندس برمجيات لأكثر من ثماني سنوات', 'Software engineer for over eight years'),
      lt('درّبت أكثر من ٤٠٠ طالب على البرمجة العملية', 'Trained more than 400 students in practical programming'),
      lt('مساهم في مشاريع مفتوحة المصدر', 'Contributor to open-source projects'),
    ],
    stats: [
      { label: lt('طالب', 'Students'), value: '400+' },
      { label: lt('مشروع مُسلَّم', 'Projects shipped'), value: '1,200' },
      { label: lt('تقييم', 'Rating'), value: '4.9/5' },
    ],
    faq: [
      {
        q: lt('محتاج خبرة قبل ما أبدأ؟', 'Do I need experience to start?'),
        a: lt('لا، المسار بيبدأ من الصفر ومعاه مراجعة أسبوعية.', 'No. The track starts from zero and includes a weekly review.'),
      },
      {
        q: lt('إيه اللغات اللي بتشرحها؟', 'Which languages do you teach?'),
        a: lt('بايثون أساساً، مع أساسيات الويب.', 'Mainly Python, plus web fundamentals.'),
      },
    ],
  },
  math_science: {
    archetype: 'math_science',
    hero: {
      headline: lt('الرياضيات تبقى منطق مش حفظ', 'Mathematics as reasoning, not memorisation'),
      subheadline: lt(
        'شرح متدرّج لطلاب الثانوية العامة يبني الأساس قبل التمرين.',
        'A step-by-step course for secondary students that builds the foundation before the drilling.',
      ),
      ctaLabel: lt('احجز مكانك', 'Reserve your seat'),
    },
    about: {
      heading: lt('نبذة عني', 'About me'),
      body: lt(
        'مدرس رياضيات لأكثر من اثني عشر عاماً في المرحلة الثانوية.\nبركّز على فهم الفكرة قبل الحل، وبعدها التمرين يبقى سهل.',
        'A secondary-school mathematics teacher for over twelve years.\nI focus on understanding the idea first; the practice then takes care of itself.',
      ),
    },
    toolkit: [
      lt('التفاضل والتكامل', 'Calculus'),
      lt('الجبر', 'Algebra'),
      lt('الهندسة الفراغية', 'Solid Geometry'),
      lt('الإحصاء', 'Statistics'),
    ],
    credentials: [
      lt('اثنا عشر عاماً في تدريس الثانوية العامة', 'Twelve years teaching the secondary certificate'),
      lt('مؤلف مذكرات مراجعة معتمدة', 'Author of approved revision booklets'),
    ],
    stats: [
      { label: lt('سنة خبرة', 'Years teaching'), value: '12' },
      { label: lt('طالب', 'Students'), value: '900+' },
    ],
    faq: [
      {
        q: lt('بتغطي المنهج كامل؟', 'Do you cover the whole syllabus?'),
        a: lt('نعم، بالترتيب ومعه مراجعات دورية.', 'Yes, in order and with periodic revisions.'),
      },
    ],
  },
  languages: {
    archetype: 'languages',
    hero: {
      headline: lt('اتكلم إنجليزي بثقة', 'Speak English with confidence'),
      subheadline: lt(
        'كورسات محادثة عملية للكبار والطلاب، تركيز على الاستخدام الحقيقي مش القواعد المجردة.',
        'Practical conversation courses for adults and students — real usage, not abstract grammar.',
      ),
      ctaLabel: lt('ابدأ المحادثة', 'Start speaking'),
    },
    about: {
      heading: lt('طريقة التعلم', 'The method'),
      body: lt(
        'الحصة كلها كلام: مواقف حقيقية، تصحيح فوري، وواجب صوتي قصير.\nالقواعد بتيجي في سياقها مش كقائمة تُحفظ.',
        'The lesson is all speaking: real situations, instant correction, and a short audio task.\nGrammar arrives in context rather than as a list to memorise.',
      ),
    },
    toolkit: [
      lt('المحادثة', 'Conversation'),
      lt('النطق', 'Pronunciation'),
      lt('إنجليزي الأعمال', 'Business English'),
      lt('آيلتس', 'IELTS'),
    ],
    credentials: [
      lt('معلمة معتمدة من CELTA', 'CELTA-certified teacher'),
      lt('سبع سنوات في تدريس المحادثة للكبار', 'Seven years teaching conversation to adults'),
      lt('درّبت فرق شركات على إنجليزي الأعمال', 'Trained corporate teams in business English'),
    ],
    stats: [{ label: lt('متعلم', 'Learners'), value: '600+' }],
    faq: [
      {
        q: lt('المستوى المطلوب للبدء؟', 'What level do I need to start?'),
        a: lt('من المبتدئ للمتوسط، وفيه اختبار تحديد مستوى قبل البداية.', 'Beginner to intermediate; there is a placement check first.'),
      },
    ],
  },
};

export interface FixtureOptions {
  dna: DesignDnaKey;
  persona: keyof typeof PERSONAS;
  hasCover?: boolean;
  hasGallery?: boolean;
  hasLogo?: boolean;
  /** Include a `stats` block — the schema and renderer support one even though
   *  the generator does not currently emit it. */
  withStats?: boolean;
  /** Include a closing `cta` block (dropped from generation in de1a663). */
  withCta?: boolean;
  design?: SiteTheme['design'];
  defaultLang?: 'ar' | 'en';
}

/**
 * Build the document the pipeline would assemble for these inputs: the same
 * block set, the same order before the Site Brain rearranges it, and the theme
 * fields the DNA resolves to. Ids are literal so the output is byte-stable.
 */
export function buildFixtureDoc(opts: FixtureOptions): SiteDocument {
  const {
    dna: dnaKey, persona: personaKey, hasCover = false, hasGallery = false, hasLogo = true,
    withStats = false, withCta = false, design, defaultLang = 'ar',
  } = opts;
  const dna = resolveDna(dnaKey);
  const p = PERSONAS[personaKey];

  const blocks: SiteBlock[] = [];
  blocks.push({
    type: 'hero',
    id: 'blk-hero',
    headline: p.hero.headline,
    subheadline: p.hero.subheadline,
    ctaLabel: p.hero.ctaLabel,
    ...(hasCover ? { mediaId: 'media-cover' } : {}),
  });
  blocks.push({ type: 'about', id: 'blk-about', heading: p.about.heading, body: p.about.body });
  blocks.push({
    type: 'toolkit',
    id: 'blk-toolkit',
    heading: lt('ما ستتعلمه', 'What you’ll learn'),
    items: p.toolkit,
  });
  blocks.push({
    type: 'credentials',
    id: 'blk-credentials',
    heading: lt('لماذا تثق بنا', 'Track record'),
    items: p.credentials,
  });
  if (withStats) {
    blocks.push({ type: 'stats', id: 'blk-stats', heading: lt('أرقام', 'By the numbers'), items: p.stats });
  }
  blocks.push({ type: 'courses', id: 'blk-courses', heading: lt('الدورات', 'Courses'), mode: 'auto', limit: 6 });
  if (hasGallery) {
    blocks.push({ type: 'gallery', id: 'blk-gallery', heading: lt('معرض الصور', 'Gallery'), mediaIds: GALLERY_IDS });
  }
  blocks.push({ type: 'reviews', id: 'blk-reviews', heading: lt('آراء الطلاب', 'Student Reviews'), mode: 'auto', limit: 6 });
  blocks.push({ type: 'faq', id: 'blk-faq', heading: lt('الأسئلة الشائعة', 'FAQ'), items: p.faq });
  blocks.push({
    type: 'contact',
    id: 'blk-contact',
    heading: lt('تواصل معنا', 'Contact'),
    socials: [
      { platform: 'whatsapp', url: 'https://wa.me/201000000000' },
      { platform: 'youtube', url: 'https://youtube.com/@khaled' },
    ],
  });
  if (withCta) {
    blocks.push({
      type: 'cta',
      id: 'blk-cta',
      headline: lt('جاهز تبدأ؟', 'Ready to start?'),
      buttonLabel: lt('سجّل الآن', 'Enrol now'),
    });
  }

  return {
    version: 1,
    theme: {
      primary: dna.palette.primary,
      accent: dna.palette.accent,
      ...(hasLogo ? { logoMediaId: 'media-logo' } : {}),
      style: dna.style,
      preset: dna.preset,
      headingFont: dna.headingFont,
      dna: dna.key,
      archetype: p.archetype,
      defaultLang,
      ...(design ? { design } : {}),
    },
    seo: {
      title: lt('أكاديمية خالد — تعلم بثقة', 'Khaled Academy — learn with confidence'),
      description: lt(
        'دروس عملية بشرح واضح ومتابعة أسبوعية لطلاب الثانوي والجامعة.',
        'Practical lessons with clear explanation and weekly follow-up for school and university students.',
      ),
    },
    blocks,
  };
}

/** A complete, valid AI design system — the shape the Planning stage produces. */
export const FIXTURE_DESIGN: NonNullable<SiteTheme['design']> = {
  background: '#0B1020',
  ink: '#F2F5FF',
  surface: '#141B33',
  radius: 6,
  density: 'airy',
  headingScale: 'dramatic',
  heroTreatment: 'mesh',
  bodyFont: 'sans',
  motion: 'lively',
};

/** Every DNA key, in a stable order, for the golden matrix. */
export const FIXTURE_DNAS: DesignDnaKey[] = [...DESIGN_DNA_KEYS].sort();

export const FIXTURE_PERSONAS = ['programming', 'math_science', 'languages'] as const;
