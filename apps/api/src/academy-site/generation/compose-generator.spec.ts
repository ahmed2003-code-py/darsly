import { AcademyProfileFacts } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AiClient } from '../ai/ai.client';
import { AiJobError } from '../ai/ai-job.error';
import { DesignRulesService } from '../pipeline/design-rules.service';
import { EvolutionService } from '../pipeline/evolution.service';
import { SiteBrainService } from '../pipeline/site-brain.service';
import { divergence, fingerprint } from '../pipeline/fingerprint';
import { designFor } from '../pipeline/design-lift';
import { parseSiteDocument, RENDERER_COMPOSITION, SiteDocument } from '../schema/site-document';
import { WARM_DESIGN } from '../__fixtures__/composition.fixture';
import { COMPOSITION_SCHEMA_NAME } from './composition.jsonschema';
import { SiteGeneratorService } from './site-generator.service';

/**
 * The composition pipeline end to end, with the model faked.
 *
 * The interesting cases are all about what happens when the model's answer is
 * imperfect — an unaffordable pattern, a section with nothing to put in it, a
 * design identical to last week's. None of them may cost a generation.
 */

const lt = (s: string) => ({ ar: s, en: `${s} en` });

const FACTS = {
  id: 'f1', academyId: 'acad-1', fullName: 'خالد منصور',
  bio: 'مدرس برمجة لأكثر من ثماني سنوات. أشرح بالكود لا بالسلايدات.\n\nكل أسبوع مشروع صغير ومراجعة سطر بسطر.',
  subjects: ['بايثون', 'قواعد البيانات', 'الويب'],
  stages: ['الجامعة'],
  achievements: ['ثماني سنوات في هندسة البرمجيات', 'درّبت ٤٠٠ طالب'],
  socials: [{ platform: 'whatsapp', url: 'https://wa.me/201000000000' }],
  rawIntake: '', createdAt: new Date(0), updatedAt: new Date(0),
} as unknown as AcademyProfileFacts;

const section = (type: string, pattern: string, over: Record<string, unknown> = {}) => ({
  type, pattern, emphasis: 'normal', width: 'standard', surface: 'page',
  align: 'start', columns: 3, accents: [], imageTreatment: 'rounded', ...over,
});

const COMPOSITION = {
  archetype: 'programming',
  design: WARM_DESIGN,
  sections: [
    section('hero', 'hero.bento', { emphasis: 'feature' }),
    section('toolkit', 'toolkit.skill-matrix', { surface: 'raised' }),
    section('courses', 'courses.bento'),
    section('process', 'process.rail'),
    section('timeline', 'timeline.columns'),
    section('stats', 'stats.big-numbers', { surface: 'inverted' }),
    section('credentials', 'credentials.cards'),
    section('reviews', 'reviews.wall'),
    section('quote', 'quote.statement'),
    section('faq', 'faq.two-column'),
    section('contact', 'contact.split-cta'),
  ],
  content: { statCount: 3, timelineCount: 3, processCount: 3, faqCount: 4, includeQuote: true },
  rationale: 'A technical, built feel for a teacher whose argument is the code itself.',
};

const COPY = {
  seo: { metaTitle: lt('أكاديمية خالد'), metaDescription: lt('برمجة عملية') },
  hero: { headline: lt('اتعلم البرمجة بمشاريع حقيقية'), subheadline: lt('من الصفر لمشروع كامل'), ctaLabel: lt('ابدأ') },
  about: { heading: lt('طريقتي'), body: lt('فقرة أولى\nفقرة ثانية') },
  toolkitHeading: lt('ما ستتعلمه'),
  highlights: [lt('بايثون'), lt('قواعد البيانات'), lt('الويب'), lt('Git')],
  credentialsHeading: lt('السجل'),
  credentials: [lt('ثماني سنوات في هندسة البرمجيات'), lt('درّبت ٤٠٠ طالب')],
  faq: [1, 2, 3, 4, 5].map((n) => ({ q: lt(`سؤال ${n}`), a: lt(`إجابة ${n}`) })),
  cta: { headline: lt('جاهز؟'), buttonLabel: lt('سجل') },
  statsHeading: lt('أرقام'),
  stats: [
    { label: lt('طالب'), value: '400+' },
    { label: lt('مشروع'), value: '1200' },
    { label: lt('تقييم'), value: '4.9/5' },
  ],
  timelineHeading: lt('المسيرة'),
  timeline: [1, 2, 3].map((n) => ({ marker: lt(`201${n}`), title: lt(`خطوة ${n}`), body: lt(`تفاصيل ${n}`) })),
  processHeading: lt('الطريقة'),
  process: [1, 2, 3].map((n) => ({ title: lt(`مرحلة ${n}`), body: lt(`شرح ${n}`) })),
  quote: { text: lt('الكود يُشرح وهو يُكتب.'), attribution: lt('خالد منصور') },
};

interface Options {
  composition?: unknown;
  copy?: unknown;
  courseCount?: number;
  reviewCount?: number;
  media?: { id: string; kind: string }[];
  snapshots?: { doc: unknown }[];
  facts?: AcademyProfileFacts;
}

function build(opts: Options = {}) {
  const media = opts.media ?? [
    { id: 'm-logo', kind: 'LOGO' }, { id: 'm-cover', kind: 'COVER' },
    ...Array.from({ length: 6 }, (_, i) => ({ id: `m-g${i}`, kind: 'GALLERY' })),
  ];
  const prisma = {
    academy: { findUnique: jest.fn().mockResolvedValue({ id: 'acad-1', name: 'أكاديمية خالد' }) },
    academyProfileFacts: { findUnique: jest.fn().mockResolvedValue(opts.facts ?? FACTS) },
    academyMedia: { findMany: jest.fn().mockResolvedValue(media) },
    academySite: { findUnique: jest.fn().mockResolvedValue({ id: 'site-1', publishedDoc: null }) },
    academySiteSnapshot: {
      findMany: jest.fn().mockResolvedValue(opts.snapshots ?? []),
      count: jest.fn().mockResolvedValue((opts.snapshots ?? []).length),
    },
    course: { count: jest.fn().mockResolvedValue(opts.courseCount ?? 6) },
    review: {
      aggregate: jest.fn().mockResolvedValue({
        _count: { _all: opts.reviewCount ?? 8 },
        _avg: { rating: 4.8 },
      }),
    },
  } as unknown as PrismaService;

  const prompts: Record<string, string> = {};
  const ai = {
    completeStructured: jest.fn(async ({ schemaName, messages }: { schemaName: string; messages: { content: string }[] }) => {
      prompts[schemaName] = messages[0].content;
      const data = schemaName === COMPOSITION_SCHEMA_NAME
        ? (opts.composition ?? COMPOSITION)
        : (opts.copy ?? COPY);
      return { data, inputTokens: 500, outputTokens: 900, costCents: schemaName === COMPOSITION_SCHEMA_NAME ? 9 : 6 };
    }),
  } as unknown as AiClient;

  const rules = new DesignRulesService();
  const generator = new SiteGeneratorService(
    prisma, ai, rules, new SiteBrainService(rules), new EvolutionService(prisma),
  );
  return { generator, prisma, ai, prompts };
}

const types = (doc: SiteDocument) => doc.blocks.map((b) => b.type);

describe('buildComposedDraft — the page the model designed', () => {
  it('produces a valid document on the composition renderer', async () => {
    const { doc } = await build().generator.buildComposedDraft('acad-1');
    expect(parseSiteDocument(doc).success).toBe(true);
    expect(doc.renderer?.version).toBe(RENDERER_COMPOSITION);
    expect(doc.theme.designSpec).toBeDefined();
  });

  it('builds the sections the composition asked for, in its order', async () => {
    const { doc } = await build().generator.buildComposedDraft('acad-1');
    // The composition's own eleven, in its order — plus the two essentials it
    // forgot. `about` lands under the hero where a visitor asks who this is;
    // the gallery joins the end of the middle band.
    expect(types(doc)).toEqual([
      'hero', 'about', 'toolkit', 'courses', 'process', 'timeline', 'stats',
      'credentials', 'reviews', 'quote', 'faq', 'gallery', 'contact',
    ]);
  });

  it('adds back an essential section the composition left out', async () => {
    // Given the choice the model will happily return eight handsome sections
    // with no course list and no social proof — a page that looks designed and
    // sells nothing.
    const sparse = {
      ...COMPOSITION,
      sections: [
        section('hero', 'hero.centered'), section('toolkit', 'toolkit.tags'),
        section('process', 'process.rail'), section('timeline', 'timeline.rail'),
        section('quote', 'quote.statement'), section('stats', 'stats.band'),
      ],
    };
    const { doc } = await build({ composition: sparse }).generator.buildComposedDraft('acad-1');
    for (const essential of ['about', 'courses', 'credentials', 'reviews', 'faq', 'contact']) {
      expect(types(doc)).toContain(essential);
    }
    expect(doc.blocks.length).toBeGreaterThanOrEqual(10);
  });

  it('does not add back a section the teacher cannot fill', async () => {
    const { generator } = build({
      composition: { ...COMPOSITION, sections: COMPOSITION.sections.slice(0, 6) },
      media: [{ id: 'm-logo', kind: 'LOGO' }],
      facts: { ...FACTS, achievements: [] } as unknown as AcademyProfileFacts,
      copy: { ...COPY, credentials: [] },
    });
    const { doc } = await generator.buildComposedDraft('acad-1');
    expect(types(doc)).not.toContain('gallery');
    expect(types(doc)).not.toContain('credentials');
  });

  it('finally emits the sections the old pipeline never could', async () => {
    const { doc } = await build().generator.buildComposedDraft('acad-1');
    expect(types(doc)).toContain('stats');
    expect(types(doc)).toContain('timeline');
    expect(types(doc)).toContain('process');
    expect(types(doc)).toContain('quote');
  });

  it('carries each section\'s layout onto its block', async () => {
    const { doc } = await build().generator.buildComposedDraft('acad-1');
    const hero = doc.blocks.find((b) => b.type === 'hero')!;
    expect(hero.section?.pattern).toBe('hero.bento');
    expect(hero.section?.emphasis).toBe('feature');
    const stats = doc.blocks.find((b) => b.type === 'stats')!;
    expect(stats.section?.surface).toBe('inverted');
  });

  it('keeps the hero first and contact last whatever order was proposed', async () => {
    const reordered = {
      ...COMPOSITION,
      sections: [
        section('contact', 'contact.pills'),
        section('faq', 'faq.accordion'),
        section('courses', 'courses.grid'),
        section('about', 'about.statement'),
        section('toolkit', 'toolkit.tags'),
        section('hero', 'hero.centered'),
      ],
    };
    const { doc } = await build({ composition: reordered }).generator.buildComposedDraft('acad-1');
    expect(types(doc)[0]).toBe('hero');
    expect(types(doc).at(-1)).toBe('contact');
  });

  it('writes exactly the content the composition planned for', async () => {
    const { doc } = await build().generator.buildComposedDraft('acad-1');
    const stats = doc.blocks.find((b) => b.type === 'stats')!;
    const faq = doc.blocks.find((b) => b.type === 'faq')!;
    expect(stats.type === 'stats' && stats.items).toHaveLength(3);
    expect(faq.type === 'faq' && faq.items).toHaveLength(4);
  });

  it('stores the rationale and the fingerprint', async () => {
    const { doc } = await build().generator.buildComposedDraft('acad-1');
    expect(doc.rationale).toContain('technical');
    expect(doc.fingerprint?.heroPattern).toBe('hero.bento');
    expect(doc.fingerprint?.mode).toBe('light');
  });

  it('bills for both model calls', async () => {
    expect((await build().generator.buildComposedDraft('acad-1')).costCents).toBe(15);
  });
});

describe('buildComposedDraft — what the model is told', () => {
  it('tells the designer what this teacher actually has', async () => {
    const { generator, prompts } = build({ courseCount: 12, reviewCount: 30 });
    await generator.buildComposedDraft('acad-1');
    const brief = prompts[COMPOSITION_SCHEMA_NAME];
    expect(brief).toContain('published courses: 12');
    expect(brief).toContain('student reviews: 30');
    expect(brief).toContain('gallery images: 6');
  });

  it('withholds the layouts this teacher cannot fill', async () => {
    const { generator, prompts } = build({ courseCount: 0, media: [{ id: 'm-logo', kind: 'LOGO' }] });
    await generator.buildComposedDraft('acad-1');
    const brief = prompts[COMPOSITION_SCHEMA_NAME];
    // No cover, no gallery, no courses — so none of the patterns that need them
    // are offered. Cheaper and more honest than letting one be chosen and then
    // silently downgraded.
    expect(brief).toContain('UNAVAILABLE');
    expect(brief).toMatch(/UNAVAILABLE[^\n]*hero\.split-portrait/);
    expect(brief).toMatch(/UNAVAILABLE[^\n]*gallery\.immersive/);
    expect(brief).toMatch(/UNAVAILABLE[^\n]*courses\.bento/);
  });

  it('tells the writer exactly how much to write', async () => {
    const { generator, prompts } = build();
    await generator.buildComposedDraft('acad-1');
    const brief = prompts.academy_copy;
    expect(brief).toContain('EXACTLY 3 figure(s)');
    expect(brief).toContain('EXACTLY 3 entries');
    expect(brief).toContain('EXACTLY 3 steps');
  });

  it('tells the writer to leave out what the page does not have', async () => {
    const noExtras = {
      ...COMPOSITION,
      sections: [
        section('hero', 'hero.centered'), section('about', 'about.statement'),
        section('toolkit', 'toolkit.tags'), section('credentials', 'credentials.record'),
        section('courses', 'courses.grid'), section('contact', 'contact.pills'),
      ],
      content: { statCount: 0, timelineCount: 0, processCount: 0, faqCount: 3, includeQuote: false },
    };
    const { generator, prompts } = build({ composition: noExtras });
    await generator.buildComposedDraft('acad-1');
    expect(prompts.academy_copy).toContain('no figures section');
    expect(prompts.academy_copy).toContain('no journey section');
    expect(prompts.academy_copy).toContain('no pull quote');
  });
});

describe('buildComposedDraft — imperfect answers still produce a page', () => {
  it('leaves out a section the teacher has no content for', async () => {
    const { generator } = build({ media: [{ id: 'm-logo', kind: 'LOGO' }] });
    const { doc } = await generator.buildComposedDraft('acad-1');
    // The composition asked for no gallery, and there are no images anyway.
    expect(types(doc)).not.toContain('gallery');
  });

  it('drops a timeline the writer did not write', async () => {
    const { generator } = build({ copy: { ...COPY, timeline: [] } });
    const { doc } = await generator.buildComposedDraft('acad-1');
    expect(types(doc)).not.toContain('timeline');
    expect(types(doc)).toContain('hero');
  });

  it('still produces a complete page when every section it asked for drops out', async () => {
    // A composition can be perfectly valid and still leave almost nothing: here
    // every section it asked for depends on content the writer did not produce.
    // A hero alone is not a page.
    const { generator } = build({
      composition: {
        ...COMPOSITION,
        sections: [
          section('hero', 'hero.centered'),
          section('timeline', 'timeline.rail'),
          section('process', 'process.numbered'),
          section('quote', 'quote.statement'),
          section('stats', 'stats.band'),
          section('gallery', 'gallery.mosaic'),
        ],
        content: { statCount: 0, timelineCount: 0, processCount: 0, faqCount: 4, includeQuote: false },
      },
      copy: { ...COPY, timeline: [], process: [], stats: [] },
    });
    const { doc } = await generator.buildComposedDraft('acad-1');
    expect(doc.blocks.length).toBeGreaterThan(4);
    expect(types(doc)).toContain('courses');
    expect(types(doc)).toContain('contact');
  });

  it('renders a page whose patterns do not exist', async () => {
    const { generator } = build({
      composition: {
        ...COMPOSITION,
        sections: COMPOSITION.sections.map((s) => ({ ...s, pattern: 'made.up' })),
      },
    });
    const { doc } = await generator.buildComposedDraft('acad-1');
    // The document keeps what the model said; the Site Brain substitutes at
    // render time, so nothing is lost and nothing breaks.
    expect(parseSiteDocument(doc).success).toBe(true);
  });

  it('asks for a retry only when the composition itself is malformed', async () => {
    const { generator } = build({ composition: { archetype: 'programming' } });
    await expect(generator.buildComposedDraft('acad-1')).rejects.toThrow('AI composition failed validation');
    await expect(generator.buildComposedDraft('acad-1')).rejects.toMatchObject({ errorClass: 'RETRYABLE' });
  });

  it('never calls the writer when the design failed', async () => {
    const { generator, ai } = build({ composition: {} });
    await expect(generator.buildComposedDraft('acad-1')).rejects.toThrow();
    expect((ai.completeStructured as jest.Mock).mock.calls).toHaveLength(1);
  });
});

describe('buildComposedDraft — regenerating gives something genuinely different', () => {
  /** A previous generation with exactly the design the model is about to repeat. */
  const previous = (): { doc: unknown } => {
    const doc = {
      version: 1,
      theme: { primary: WARM_DESIGN.palette.primary, accent: WARM_DESIGN.palette.accent, designSpec: WARM_DESIGN },
      blocks: [{ type: 'hero', id: 'h', section: { pattern: 'hero.bento' }, headline: lt('x'), subheadline: lt('y'), ctaLabel: lt('z') }],
    };
    return { doc };
  };

  it('pushes the design away from the one just regenerated out of', async () => {
    const { generator } = build({ snapshots: [previous()] });
    const { doc } = await generator.buildComposedDraft('acad-1');
    const before = fingerprint(WARM_DESIGN, { blocks: [] as never });
    const after = fingerprint(designFor(doc), doc);
    expect(divergence(before, after)).toBeGreaterThanOrEqual(3);
  });

  it('leaves a genuinely new design alone', async () => {
    const { generator } = build({ snapshots: [] });
    const { doc } = await generator.buildComposedDraft('acad-1');
    expect(doc.theme.designSpec!.palette.background).toBe(WARM_DESIGN.palette.background);
  });

  it('shows the designer what it must not rebuild', async () => {
    const { generator, prompts } = build({ snapshots: [previous()] });
    await generator.buildComposedDraft('acad-1');
    expect(prompts[COMPOSITION_SCHEMA_NAME]).toContain('GENERATION HISTORY');
    expect(prompts[COMPOSITION_SCHEMA_NAME]).toContain('hero.bento');
  });
});

describe('buildComposedDraft — the platform keeps its guarantees', () => {
  it('refuses terminally when there is nothing to write about', async () => {
    const thin = { ...FACTS, bio: null, rawIntake: null, subjects: [] } as unknown as AcademyProfileFacts;
    const err: AiJobError = await build({ facts: thin }).generator
      .buildComposedDraft('acad-1').catch((e) => e);
    expect(err.errorClass).toBe('TERMINAL');
  });

  it('keeps only social links that are real URLs', async () => {
    const facts = {
      ...FACTS,
      socials: [{ platform: 'ok', url: 'https://wa.me/2' }, { platform: 'bad', url: 'not-a-url' }],
    } as unknown as AcademyProfileFacts;
    const { doc } = await build({ facts }).generator.buildComposedDraft('acad-1');
    const contact = doc.blocks.find((b) => b.type === 'contact')!;
    expect(contact.type === 'contact' && contact.socials).toHaveLength(1);
  });

  it('gives every block a unique id', async () => {
    const { doc } = await build().generator.buildComposedDraft('acad-1');
    const ids = doc.blocks.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
