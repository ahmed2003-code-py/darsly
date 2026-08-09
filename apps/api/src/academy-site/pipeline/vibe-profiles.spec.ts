import { ARCHETYPE_PROFILES } from './archetype-profiles';
import { VIBE_KEYS, VIBE_PROFILES, vibeBrief, vibeProfile } from './vibe-profiles';
import { allPatterns } from '../renderer/compose';

/**
 * The four directions a teacher picks between.
 *
 * The value of these is entirely in how far apart they are. A set of briefs that
 * all say "tasteful and modern" is the enum problem again with more words, so
 * most of what is tested here is distance: different palettes, different type,
 * different geometry, different patterns.
 */

const ALL = VIBE_KEYS.map((k) => VIBE_PROFILES[k]);

describe('the directions are genuinely different from each other', () => {
  it('shares almost no patterns between any two', () => {
    for (let i = 0; i < ALL.length; i++) {
      for (let j = i + 1; j < ALL.length; j++) {
        const a = new Set(ALL[i].favours);
        const shared = ALL[j].favours.filter((p) => a.has(p));
        expect(shared.length / Math.min(a.size, ALL[j].favours.length)).toBeLessThan(0.5);
      }
    }
  });

  it('gives each direction patterns no other direction reaches for first', () => {
    for (const v of ALL) {
      const others = new Set(ALL.filter((o) => o !== v).flatMap((o) => o.favours));
      expect(v.favours.some((p) => !others.has(p))).toBe(true);
    }
  });

  it('names only patterns the platform actually has', () => {
    const known = new Set(allPatterns().map((p) => p.id));
    for (const v of ALL) {
      for (const id of v.favours) expect(known.has(id)).toBe(true);
    }
  });

  it('sends them to different ends of the light/dark axis', () => {
    expect(VIBE_PROFILES.trusted.palette.toLowerCase()).toContain('light');
    expect(VIBE_PROFILES.premium.palette.toLowerCase()).toContain('dark');
    expect(VIBE_PROFILES.energetic.palette.toLowerCase()).toContain('saturated');
  });

  it('gives each one a distinct typographic position', () => {
    expect(VIBE_PROFILES.energetic.typography).toMatch(/display|condensed/i);
    expect(VIBE_PROFILES.premium.typography).toMatch(/serif/i);
    expect(VIBE_PROFILES.academic.typography).toMatch(/restrained|balanced/i);
    expect(VIBE_PROFILES.trusted.typography).toMatch(/round|friendly|humanist/i);
  });

  it('tells each one how it fails, not only how it succeeds', () => {
    // A brief that only says what to do produces the safe middle every time.
    for (const v of ALL) {
      expect(v.avoid.length).toBeGreaterThan(60);
      expect(v.mood.length).toBeGreaterThan(60);
    }
  });
});

describe('vibeBrief', () => {
  it('carries every axis of the direction into the prompt', () => {
    const brief = vibeBrief('premium');
    for (const axis of ['mood', 'palette', 'typography', 'geometry', 'rhythm', 'motion', 'decoration']) {
      expect(brief).toContain(`${axis}:`);
    }
    expect(brief).toContain('how this direction fails');
  });

  it('produces a visibly different brief for each direction', () => {
    const briefs = VIBE_KEYS.map((k) => vibeBrief(k));
    expect(new Set(briefs).size).toBe(VIBE_KEYS.length);
    for (const b of briefs) expect(b.length).toBeGreaterThan(600);
  });

  it('falls back to the warm direction for anything unknown', () => {
    expect(vibeProfile(undefined).label).toBe(VIBE_PROFILES.trusted.label);
    expect(vibeProfile('nonsense').label).toBe(VIBE_PROFILES.trusted.label);
  });
});

describe('the direction outranks the subject', () => {
  it('is stated as an order of authority rather than three equal hints', () => {
    // The teacher's own choice used to arrive as one adjective beneath a page of
    // subject guidance, so in practice the subject decided the design and the
    // choice did nothing.
    const { userComposePrompt } = require('../generation/compose-prompt');
    const prompt = userComposePrompt({
      facts: { fullName: 'x', bio: 'y', subjects: [], stages: [], achievements: [], rawIntake: '' },
      academyName: 'a',
      vibe: 'premium',
      profile: {
        hasCover: false, hasLogo: false, galleryCount: 0, bioLength: 100,
        subjectsCount: 2, achievementsCount: 1, courseCount: 1, reviewCount: 0,
        avgRating: 0, bioParagraphs: 1, avgAchievementLength: 10,
      },
      counts: {},
      archetypeGuess: 'programming',
      evo: { recentDnas: [], regenCount: 0 },
      recent: [],
    });
    expect(prompt).toContain('THREE BRIEFS, IN ORDER OF AUTHORITY');
    expect(prompt.indexOf('DIRECTION')).toBeLessThan(prompt.indexOf('SUBJECT GUIDANCE'));
    expect(prompt).toContain(VIBE_PROFILES.premium.mood);
    // The subject brief is still there — it decides what goes on the page.
    expect(prompt).toContain(ARCHETYPE_PROFILES.programming.mood);
  });
});
