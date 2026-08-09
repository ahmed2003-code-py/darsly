import { PrismaService } from '../../prisma/prisma.service';
import { DESIGN_DNA_KEYS } from './design-dna';
import { EvolutionContext, EvolutionService } from './evolution.service';

/**
 * Generation is not memoryless: what the teacher published is a "keep this"
 * signal and what they regenerated away from is a "don't repeat" one. These
 * tests pin how history is read, and record the one part that is written but
 * never wired up.
 */

interface FakeState {
  site?: { id: string; publishedDoc: unknown } | null;
  snapshots?: { doc: unknown }[];
}

function fakePrisma(state: FakeState): PrismaService {
  return {
    academySite: {
      findUnique: jest.fn().mockResolvedValue(state.site ?? null),
    },
    academySiteSnapshot: {
      findMany: jest.fn().mockResolvedValue(state.snapshots ?? []),
      count: jest.fn().mockResolvedValue((state.snapshots ?? []).length),
    },
  } as unknown as PrismaService;
}

const themed = (dna?: string, archetype?: string) => ({
  theme: { ...(dna ? { dna } : {}), ...(archetype ? { archetype } : {}) },
});

/** A snapshot row as Prisma returns it: the document lives under `doc`. */
const snap = (doc: unknown) => ({ doc });

describe('EvolutionService.context', () => {
  it('reports a first generation when the academy has no site yet', async () => {
    const evo = new EvolutionService(fakePrisma({ site: null }));
    await expect(evo.context('a1')).resolves.toEqual({
      publishedDna: undefined,
      publishedArchetype: undefined,
      recentDnas: [],
      regenCount: 0,
    });
  });

  it('reads the published direction as the "keep this" signal', async () => {
    const evo = new EvolutionService(
      fakePrisma({ site: { id: 's1', publishedDoc: themed('editorial_dark', 'university') }, snapshots: [] }),
    );
    const ctx = await evo.context('a1');
    expect(ctx.publishedDna).toBe('editorial_dark');
    expect(ctx.publishedArchetype).toBe('university');
  });

  it('reads recent generations most-recent-first as the "do not repeat" signal', async () => {
    const evo = new EvolutionService(
      fakePrisma({
        site: { id: 's1', publishedDoc: null },
        snapshots: [snap(themed('royal_night')), snap(themed('warm_mentor')), snap(themed('creative_serif'))],
      }),
    );
    const ctx = await evo.context('a1');
    expect(ctx.recentDnas).toEqual(['royal_night', 'warm_mentor', 'creative_serif']);
    expect(ctx.regenCount).toBe(3);
  });

  it('skips snapshots that carry no design direction', async () => {
    const evo = new EvolutionService(
      fakePrisma({
        site: { id: 's1', publishedDoc: null },
        snapshots: [snap(themed('royal_night')), snap({ theme: {} }), snap({}), snap(themed('warm_mentor'))],
      }),
    );
    expect((await evo.context('a1')).recentDnas).toEqual(['royal_night', 'warm_mentor']);
  });

  it('survives a published document that is not shaped like a document', async () => {
    const evo = new EvolutionService(fakePrisma({ site: { id: 's1', publishedDoc: 'garbage' } }));
    await expect(evo.context('a1')).resolves.toMatchObject({ publishedDna: undefined });
  });
});

describe('EvolutionService.normalizeDna', () => {
  it('passes a known direction through untouched', () => {
    const evo = new EvolutionService(fakePrisma({}));
    for (const key of DESIGN_DNA_KEYS) expect(evo.normalizeDna(key)).toBe(key);
  });

  it('replaces an unknown direction rather than letting it reach the renderer', () => {
    const evo = new EvolutionService(fakePrisma({}));
    expect(DESIGN_DNA_KEYS).toContain(evo.normalizeDna('something_the_model_invented'));
  });
});

describe('EvolutionService.enforceVariety', () => {
  const evo = new EvolutionService(fakePrisma({}));
  const ctx = (recentDnas: string[]): EvolutionContext => ({ recentDnas, regenCount: recentDnas.length });

  it('rotates away from the direction the teacher just regenerated out of', () => {
    const chosen = evo.enforceVariety('royal_night', ctx(['royal_night', 'warm_mentor']), false);
    expect(chosen).not.toBe('royal_night');
    expect(DESIGN_DNA_KEYS).toContain(chosen);
  });

  it('leaves an unrelated choice alone', () => {
    expect(evo.enforceVariety('creative_serif', ctx(['royal_night']), false)).toBe('creative_serif');
  });

  it('lets an explicit style brief win over the anti-repeat guard', () => {
    expect(evo.enforceVariety('royal_night', ctx(['royal_night']), true)).toBe('royal_night');
  });

  it('still moves when every direction has already been used', () => {
    const all = [...DESIGN_DNA_KEYS];
    expect(evo.enforceVariety(all[0], ctx(all), false)).not.toBe(all[0]);
  });

  it('is not called by the generation pipeline today', () => {
    // The guarantee this method exists to provide — that regenerating without a
    // brief cannot return the same direction — is not in force: buildDraft()
    // calls normalizeDna() and never this. Recorded as a test so the gap is
    // visible rather than folklore, and so wiring it up has somewhere to land.
    const generator = require('fs').readFileSync(
      require('path').join(__dirname, '../generation/site-generator.service.ts'),
      'utf8',
    );
    expect(generator).not.toContain('enforceVariety');
  });
});
