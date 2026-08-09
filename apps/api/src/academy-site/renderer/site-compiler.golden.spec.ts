import { createHash } from 'crypto';
import { Archetype } from '../generation/planning.schema';
import { DesignRulesService } from '../pipeline/design-rules.service';
import { SiteBrainService } from '../pipeline/site-brain.service';
import { SiteDocument, SiteTheme } from '../schema/site-document';
import {
  FIXTURE_DESIGN,
  FIXTURE_DNAS,
  FIXTURE_PERSONAS,
  buildFixtureDoc,
  fixtureContext,
  FixtureOptions,
} from '../__fixtures__/site-doc.fixture';
import { compileSite } from './site-compiler';

/**
 * The golden safety net.
 *
 * Published pages are compiled HTML frozen at publish time, so a renderer change
 * reaches a live academy only when something recompiles it — and when it does,
 * it repaints a page a teacher already approved. Before the renderer is split
 * into modules there has to be a test that fails on any byte that moves.
 *
 * Two layers, deliberately:
 *   - full-text snapshots for a handful of representative pages, so a diff is
 *     readable and a deliberate change can be reviewed;
 *   - a digest per combination across the whole matrix, so nothing changes
 *     silently in the 40-odd pages nobody would think to snapshot.
 *
 * A failure here is not automatically a bug. It means: read the diff, and if the
 * change is intended, update the snapshot in the same commit that causes it.
 */

const rules = new DesignRulesService();
const brain = new SiteBrainService(rules);

/** Run a fixture document through the same Site Brain path generation uses. */
function render(opts: FixtureOptions): string {
  const doc = buildFixtureDoc(opts);
  const archetype = (doc.theme.archetype as Archetype) ?? 'general';
  brain.arrange(doc, archetype);
  brain.assignVariants(doc, {
    dna: doc.theme.dna ?? '',
    archetype,
    preset: doc.theme.preset ?? 'warm',
    hasHeroImage: !!opts.hasCover,
    hasAboutImage: false,
    bioLength: blockTextLength(doc, 'about'),
    subjectsCount: countItems(doc, 'toolkit'),
    achievementsCount: countItems(doc, 'credentials'),
    galleryCount: opts.hasGallery ? 6 : 0,
  });
  return compileSite(brain.plan(doc), fixtureContext({ defaultLang: opts.defaultLang ?? 'ar' }));
}

function blockTextLength(doc: SiteDocument, type: 'about'): number {
  const b = doc.blocks.find((x) => x.type === type);
  return b && b.type === 'about' ? b.body.ar.length : 0;
}

function countItems(doc: SiteDocument, type: 'toolkit' | 'credentials'): number {
  const b = doc.blocks.find((x) => x.type === type);
  return b && (b.type === 'toolkit' || b.type === 'credentials') ? b.items.length : 0;
}

const digest = (html: string) => createHash('sha256').update(html).digest('hex').slice(0, 16);

describe('golden — representative pages render exactly as they do today', () => {
  // One per visual family, plus the two paths that behave differently: a cover
  // image (which switches the hero variant and inverts the text colour) and an
  // AI-composed design (which overrides the preset palette).
  const cases: { name: string; opts: FixtureOptions }[] = [
    { name: 'editorial_dark · programming · no cover', opts: { dna: 'editorial_dark', persona: 'programming' } },
    { name: 'academic_precise · math · no cover', opts: { dna: 'academic_precise', persona: 'math_science' } },
    { name: 'creative_serif · languages · gallery', opts: { dna: 'creative_serif', persona: 'languages', hasGallery: true } },
    { name: 'warm_mentor · math · cover', opts: { dna: 'warm_mentor', persona: 'math_science', hasCover: true } },
    { name: 'bold_energetic · programming · cover + gallery', opts: { dna: 'bold_energetic', persona: 'programming', hasCover: true, hasGallery: true } },
    { name: 'royal_night · languages · AI design', opts: { dna: 'royal_night', persona: 'languages', design: FIXTURE_DESIGN } },
    { name: 'sunrise_warm · programming · stats + cta', opts: { dna: 'sunrise_warm', persona: 'programming', withStats: true, withCta: true } },
    { name: 'academic_precise · languages · english default', opts: { dna: 'academic_precise', persona: 'languages', defaultLang: 'en' } },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(render(c.opts)).toMatchSnapshot();
    });
  }
});

describe('golden — the whole matrix is byte-stable', () => {
  it('every DNA × persona × cover state', () => {
    const matrix: Record<string, string> = {};
    for (const dna of FIXTURE_DNAS) {
      for (const persona of FIXTURE_PERSONAS) {
        for (const hasCover of [false, true]) {
          const key = `${dna}/${persona}/${hasCover ? 'cover' : 'no-cover'}`;
          matrix[key] = digest(render({ dna, persona, hasCover, hasGallery: true }));
        }
      }
    }
    expect(Object.keys(matrix)).toHaveLength(FIXTURE_DNAS.length * FIXTURE_PERSONAS.length * 2);
    expect(matrix).toMatchSnapshot();
  });

  it('every axis of the AI-composed design system', () => {
    // Each axis varied on its own against a fixed base, so a regression names the
    // knob that broke rather than "something in the design changed".
    const axes: Record<string, Partial<NonNullable<SiteTheme['design']>>[]> = {
      density: [{ density: 'compact' }, { density: 'regular' }, { density: 'airy' }],
      headingScale: [{ headingScale: 'restrained' }, { headingScale: 'balanced' }, { headingScale: 'dramatic' }],
      heroTreatment: [{ heroTreatment: 'flat' }, { heroTreatment: 'gradient' }, { heroTreatment: 'mesh' }, { heroTreatment: 'spotlight' }],
      bodyFont: [{ bodyFont: 'sans' }, { bodyFont: 'serif' }, { bodyFont: 'mono' }],
      motion: [{ motion: 'calm' }, { motion: 'lively' }, { motion: 'cinematic' }],
      radius: [{ radius: 0 }, { radius: 14 }, { radius: 28 }],
    };
    const matrix: Record<string, string> = {};
    for (const [axis, values] of Object.entries(axes)) {
      for (const value of values) {
        const label = Object.values(value)[0];
        matrix[`${axis}=${label}`] = digest(
          render({ dna: 'royal_night', persona: 'programming', design: { ...FIXTURE_DESIGN, ...value } }),
        );
      }
    }
    expect(matrix).toMatchSnapshot();
  });

  it('gives each axis value its own output', () => {
    // A snapshot passes just as happily when a knob is wired to nothing. This is
    // the assertion that the knobs are actually connected.
    const seen = new Map<string, string>();
    for (const density of ['compact', 'regular', 'airy'] as const) {
      for (const heroTreatment of ['flat', 'gradient', 'mesh', 'spotlight'] as const) {
        const html = render({
          dna: 'royal_night',
          persona: 'programming',
          design: { ...FIXTURE_DESIGN, density, heroTreatment },
        });
        const key = digest(html);
        expect(seen.has(key)).toBe(false);
        seen.set(key, `${density}/${heroTreatment}`);
      }
    }
    expect(seen.size).toBe(12);
  });
});

describe('golden — compilation is deterministic', () => {
  it('produces identical bytes for identical input', () => {
    const opts: FixtureOptions = { dna: 'editorial_dark', persona: 'programming', hasCover: true, hasGallery: true };
    expect(render(opts)).toBe(render(opts));
  });

  it('does not depend on the order the fixtures were built in', () => {
    const a = render({ dna: 'warm_mentor', persona: 'languages' });
    render({ dna: 'bold_energetic', persona: 'programming', hasCover: true });
    const b = render({ dna: 'warm_mentor', persona: 'languages' });
    expect(b).toBe(a);
  });
});
