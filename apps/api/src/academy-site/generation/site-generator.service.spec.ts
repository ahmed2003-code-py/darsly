import { AcademyProfileFacts } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AiClient } from '../ai/ai.client';
import { AiJobError } from '../ai/ai-job.error';
import { DesignRulesService } from '../pipeline/design-rules.service';
import { EvolutionService } from '../pipeline/evolution.service';
import { SiteBrainService } from '../pipeline/site-brain.service';
import { parseSiteDocument, SiteDocument } from '../schema/site-document';
import { AI_COPY_SCHEMA_NAME } from './ai-copy.jsonschema';
import { SiteGeneratorService } from './site-generator.service';

/**
 * The generator is where two model calls and five deterministic steps meet, and
 * it is the only place that decides which sections a page has at all. Nothing
 * covered it before, so this file pins the contract it currently honours —
 * including the parts that are surprising.
 */

const lt = (s: string) => ({ ar: s, en: `${s} (en)` });

const FACTS = {
  id: 'f1',
  academyId: 'acad-1',
  fullName: 'خالد منصور',
  bio: 'مدرس رياضيات لأكثر من اثني عشر عاماً. أركز على الفهم قبل التمرين.',
  subjects: ['التفاضل', 'الجبر', 'الهندسة'],
  stages: ['الثانوية العامة'],
  achievements: ['اثنا عشر عاماً في التدريس', 'مؤلف مذكرات مراجعة'],
  socials: [
    { platform: 'whatsapp', url: 'https://wa.me/201000000000' },
    { platform: 'broken', url: 'not-a-url' },
  ],
  rawIntake: '',
  createdAt: new Date(0),
  updatedAt: new Date(0),
} as unknown as AcademyProfileFacts;

const PLAN = {
  designDNA: 'editorial_dark',
  theme: { primary: '#123456', accent: '#ABCDEF' },
  archetype: 'math_science',
  design: {
    background: '#0B1020', ink: '#F2F5FF', surface: '#141B33',
    radius: 6, density: 'airy', headingScale: 'dramatic',
    heroTreatment: 'mesh', bodyFont: 'serif', motion: 'calm',
  },
};

const COPY = {
  seo: { metaTitle: lt('أكاديمية خالد'), metaDescription: lt('دروس رياضيات') },
  hero: { headline: lt('الرياضيات منطق'), subheadline: lt('شرح متدرج'), ctaLabel: lt('ابدأ') },
  about: { heading: lt('نبذة'), body: lt('فقرة أولى\nفقرة ثانية') },
  toolkitHeading: lt('ما ستتعلمه'),
  highlights: [lt('التفاضل'), lt('الجبر')],
  credentialsHeading: lt('السجل'),
  credentials: [lt('اثنا عشر عاماً في التدريس')],
  faq: [lt('q1'), lt('q2'), lt('q3'), lt('q4'), lt('q5'), lt('q6')].map((x) => ({ q: x, a: x })),
  cta: { headline: lt('جاهز؟'), buttonLabel: lt('سجل') },
};

interface Options {
  facts?: AcademyProfileFacts | null;
  media?: { id: string; kind: string }[];
  plan?: unknown;
  copy?: unknown;
  snapshots?: { doc: unknown }[];
  publishedDoc?: unknown;
}

function build(opts: Options = {}) {
  const media = opts.media ?? [
    { id: 'm-logo', kind: 'LOGO' },
    { id: 'm-cover', kind: 'COVER' },
    { id: 'm-g1', kind: 'GALLERY' },
    { id: 'm-g2', kind: 'GALLERY' },
  ];
  const prisma = {
    academy: { findUnique: jest.fn().mockResolvedValue({ id: 'acad-1', name: 'أكاديمية خالد' }) },
    academyProfileFacts: {
      findUnique: jest.fn().mockResolvedValue(opts.facts === undefined ? FACTS : opts.facts),
    },
    academyMedia: { findMany: jest.fn().mockResolvedValue(media) },
    academySite: {
      findUnique: jest.fn().mockResolvedValue({ id: 'site-1', publishedDoc: opts.publishedDoc ?? null }),
    },
    academySiteSnapshot: {
      findMany: jest.fn().mockResolvedValue(opts.snapshots ?? []),
      count: jest.fn().mockResolvedValue((opts.snapshots ?? []).length),
    },
  } as unknown as PrismaService;

  const calls: { schemaName: string }[] = [];
  const ai = {
    completeStructured: jest.fn(async ({ schemaName }: { schemaName: string }) => {
      calls.push({ schemaName });
      const data = schemaName === AI_COPY_SCHEMA_NAME ? (opts.copy ?? COPY) : (opts.plan ?? PLAN);
      return { data, inputTokens: 100, outputTokens: 200, costCents: schemaName === AI_COPY_SCHEMA_NAME ? 7 : 3 };
    }),
  } as unknown as AiClient;

  const rules = new DesignRulesService();
  const generator = new SiteGeneratorService(
    prisma,
    ai,
    rules,
    new SiteBrainService(rules),
    new EvolutionService(prisma),
  );
  return { generator, prisma, ai, calls };
}

const types = (doc: SiteDocument) => doc.blocks.map((b) => b.type);

describe('SiteGeneratorService.buildDraft — the assembled page', () => {
  it('produces a document that satisfies its own schema', async () => {
    const { generator } = build();
    const { doc } = await generator.buildDraft('acad-1');
    expect(parseSiteDocument(doc).success).toBe(true);
  });

  it('runs exactly two model calls: plan, then copy', async () => {
    const { generator, calls } = build();
    await generator.buildDraft('acad-1');
    expect(calls.map((c) => c.schemaName)).toEqual(['academy_plan', 'academy_copy']);
  });

  it('bills the teacher for both calls', async () => {
    const { generator } = build();
    expect((await generator.buildDraft('acad-1')).costCents).toBe(10);
  });

  it('emits the section set the product ships today', async () => {
    const { generator } = build();
    const { doc } = await generator.buildDraft('acad-1');
    expect([...types(doc)].sort()).toEqual(
      ['about', 'contact', 'courses', 'credentials', 'faq', 'gallery', 'hero', 'reviews', 'toolkit'].sort(),
    );
  });

  it('never emits a stats band or a closing CTA', async () => {
    // Both types are in the schema and both have renderers. `stats` has simply
    // never been generated, and the closing CTA was deliberately dropped. A
    // richer composition model is expected to change this — deliberately.
    const { generator } = build();
    const { doc } = await generator.buildDraft('acad-1');
    expect(types(doc)).not.toContain('stats');
    expect(types(doc)).not.toContain('cta');
  });

  it('orders the page by the archetype the model inferred', async () => {
    const { generator } = build();
    const { doc } = await generator.buildDraft('acad-1');
    expect(types(doc)[0]).toBe('hero');
    expect(types(doc).at(-1)).toBe('contact');
    expect(doc.theme.archetype).toBe('math_science');
  });

  it('gives every block a unique id and a resolved variant', async () => {
    const { generator } = build();
    const { doc } = await generator.buildDraft('acad-1');
    const ids = doc.blocks.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(doc.blocks.every((b) => !!b.variant)).toBe(true);
  });

  it('attaches the cover to the hero, the logo to the theme, the gallery to its block', async () => {
    const { generator } = build();
    const { doc } = await generator.buildDraft('acad-1');
    const hero = doc.blocks.find((b) => b.type === 'hero')!;
    const gallery = doc.blocks.find((b) => b.type === 'gallery')!;
    expect(hero.type === 'hero' && hero.mediaId).toBe('m-cover');
    expect(doc.theme.logoMediaId).toBe('m-logo');
    expect(gallery.type === 'gallery' && gallery.mediaIds).toEqual(['m-g1', 'm-g2']);
  });

  it('drops the gallery section when there are no gallery images', async () => {
    const { generator } = build({ media: [{ id: 'm-cover', kind: 'COVER' }] });
    const { doc } = await generator.buildDraft('acad-1');
    expect(types(doc)).not.toContain('gallery');
  });

  it('keeps the FAQ short even when the model writes a long one', async () => {
    // An FAQ is the least persuasive thing on the page and the easiest to pad.
    const { generator } = build();
    const { doc } = await generator.buildDraft('acad-1');
    const faq = doc.blocks.find((b) => b.type === 'faq')!;
    expect(faq.type === 'faq' && faq.items).toHaveLength(4);
  });

  it('keeps only the social links that are real URLs', async () => {
    const { generator } = build();
    const { doc } = await generator.buildDraft('acad-1');
    const contact = doc.blocks.find((b) => b.type === 'contact')!;
    expect(contact.type === 'contact' && contact.socials).toEqual([
      { platform: 'whatsapp', url: 'https://wa.me/201000000000' },
    ]);
  });
});

describe('SiteGeneratorService.buildDraft — the design decision', () => {
  it('keeps the design system the model composed', async () => {
    const { generator } = build();
    const { doc } = await generator.buildDraft('acad-1');
    expect(doc.theme.design).toEqual(PLAN.design);
  });

  it('keeps the colours the model chose when they are valid hex', async () => {
    const { generator } = build();
    const { doc } = await generator.buildDraft('acad-1');
    expect(doc.theme.primary).toBe('#123456');
    expect(doc.theme.accent).toBe('#ABCDEF');
  });

  it('falls back to the DNA signature palette when the colours are not hex', async () => {
    const { generator } = build({ plan: { ...PLAN, theme: { primary: 'blue', accent: 'gold' } } });
    const { doc } = await generator.buildDraft('acad-1');
    expect(doc.theme.primary).toBe('#6366F1'); // editorial_dark
    expect(doc.theme.accent).toBe('#E3B341');
  });

  it('renders a competent page when the model composed no design system', async () => {
    const { design, ...noDesign } = PLAN;
    const { generator } = build({ plan: noDesign });
    const { doc } = await generator.buildDraft('acad-1');
    expect(doc.theme.design).toBeUndefined();
    expect(doc.theme.preset).toBe('premium');
    expect(doc.theme.headingFont).toBe('serif');
  });

  it('throws away the whole plan when the model names a direction that does not exist', async () => {
    // The direction is a zod enum, so an invented key fails validation before
    // anything can substitute for it: one unknown string costs the entire
    // planning call and buys a retry. Everything downstream is built to degrade
    // gracefully; this one field is not, and a larger design vocabulary makes
    // that far more likely to fire.
    const { generator, calls } = build({ plan: { ...PLAN, designDNA: 'invented_dna' } });
    await expect(generator.buildDraft('acad-1')).rejects.toThrow('AI plan failed validation');
    expect(calls.map((c) => c.schemaName)).toEqual(['academy_plan']);
  });

  it('ignores the vibe rotation entirely', async () => {
    // `pickVibeDna(vibe, regenCount)` is only reached when normalizeDna returns
    // something falsy, and it never does. The vibe therefore steers the copy but
    // no longer steers the design — worth knowing before the rotation is trusted.
    const trusted = await build().generator.buildDraft('acad-1', 'trusted');
    const energetic = await build().generator.buildDraft('acad-1', 'energetic');
    expect(trusted.doc.theme.dna).toBe(energetic.doc.theme.dna);
  });
});

describe('SiteGeneratorService.buildDraft — curation', () => {
  it('prefers the model\'s curated lists', async () => {
    const { generator } = build();
    const { doc } = await generator.buildDraft('acad-1');
    const toolkit = doc.blocks.find((b) => b.type === 'toolkit')!;
    expect(toolkit.type === 'toolkit' && toolkit.items).toEqual([
      { ar: 'التفاضل', en: 'التفاضل (en)' },
      { ar: 'الجبر', en: 'الجبر (en)' },
    ]);
  });

  it('falls back to the raw facts when the model curated nothing', async () => {
    const { generator } = build({ copy: { ...COPY, highlights: [], credentials: [] } });
    const { doc } = await generator.buildDraft('acad-1');
    const toolkit = doc.blocks.find((b) => b.type === 'toolkit')!;
    expect(toolkit.type === 'toolkit' && toolkit.items).toEqual(['التفاضل', 'الجبر', 'الهندسة']);
  });

  it('drops the section entirely when neither the model nor the facts have anything', async () => {
    const { generator } = build({
      facts: { ...FACTS, subjects: [], achievements: [] } as unknown as AcademyProfileFacts,
      copy: { ...COPY, highlights: [], credentials: [] },
    });
    const { doc } = await generator.buildDraft('acad-1');
    expect(types(doc)).not.toContain('toolkit');
    expect(types(doc)).not.toContain('credentials');
  });

  it('strips Markdown the teacher pasted into their facts', async () => {
    const { generator } = build({
      facts: { ...FACTS, subjects: ['**الجبر**', '* الهندسة'] } as unknown as AcademyProfileFacts,
      copy: { ...COPY, highlights: [] },
    });
    const { doc } = await generator.buildDraft('acad-1');
    const toolkit = doc.blocks.find((b) => b.type === 'toolkit')!;
    expect(toolkit.type === 'toolkit' && toolkit.items).toEqual(['الجبر', 'الهندسة']);
  });
});

describe('SiteGeneratorService.buildDraft — failure handling', () => {
  const reason = async (p: Promise<unknown>) => {
    try {
      await p;
      return null;
    } catch (e) {
      return e as AiJobError;
    }
  };

  it('refuses terminally when the academy does not exist', async () => {
    const { generator, prisma } = build();
    (prisma.academy.findUnique as jest.Mock).mockResolvedValue(null);
    expect((await reason(generator.buildDraft('nope')))?.errorClass).toBe('TERMINAL');
  });

  it('refuses terminally when there is nothing to write about', async () => {
    const { generator } = build({
      facts: { ...FACTS, bio: null, rawIntake: null, subjects: [] } as unknown as AcademyProfileFacts,
    });
    const err = await reason(generator.buildDraft('acad-1'));
    expect(err?.errorClass).toBe('TERMINAL');
    expect(err?.message).toContain('Not enough profile facts');
  });

  it('asks for a retry when the plan does not validate', async () => {
    const { generator } = build({ plan: { designDNA: 'editorial_dark' } });
    const err = await reason(generator.buildDraft('acad-1'));
    expect(err?.errorClass).toBe('RETRYABLE');
    expect(err?.message).toContain('AI plan failed validation');
  });

  it('asks for a retry when the copy does not validate', async () => {
    const { generator } = build({ copy: { hero: {} } });
    const err = await reason(generator.buildDraft('acad-1'));
    expect(err?.errorClass).toBe('RETRYABLE');
    expect(err?.message).toContain('AI output failed validation');
  });
});

describe('SiteGeneratorService.buildDraft — history', () => {
  it('reads the academy\'s past generations before planning', async () => {
    const { generator, prisma } = build({
      snapshots: [{ doc: { theme: { dna: 'royal_night' } } }],
      publishedDoc: { theme: { dna: 'warm_mentor' } },
    });
    await generator.buildDraft('acad-1');
    expect(prisma.academySiteSnapshot.findMany).toHaveBeenCalled();
    expect(prisma.academySite.findUnique).toHaveBeenCalled();
  });

  it('does not stop the model repeating the direction just regenerated away from', async () => {
    // EvolutionService has a deterministic anti-repeat guard. buildDraft does not
    // call it, so the only thing standing between a teacher and the same page
    // twice is the model choosing to read the history brief in the prompt.
    const { generator } = build({ snapshots: [{ doc: { theme: { dna: 'editorial_dark' } } }] });
    const { doc } = await generator.buildDraft('acad-1');
    expect(doc.theme.dna).toBe('editorial_dark');
  });
});
