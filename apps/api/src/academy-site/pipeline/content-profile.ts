import { ContentSignals } from '../generation/plan-prompt';
import { FitContext, allPatterns, patternFits } from '../renderer/compose';

/**
 * What this teacher actually has to build a page out of.
 *
 * The old signal set knew about text and images and nothing else, which is why
 * "many courses deserve a course-led page" was impossible to act on: the
 * generator never looked at the catalogue. This adds the live half — courses,
 * reviews, ratings — and the derived judgements the composition needs.
 *
 * It is used twice on purpose. Once in the prompt, as a plain statement of what
 * is and is not available, because a model that knows a gallery has two images
 * will not design an immersive one. And once in the validator, as a hard gate,
 * because a model that knows will occasionally do it anyway.
 */
export interface ContentProfile extends ContentSignals {
  /** Published, non-deleted courses in this academy. */
  courseCount: number;
  /** Reviews carrying an actual comment. */
  reviewCount: number;
  /** Mean rating across those reviews, 0 when there are none. */
  avgRating: number;
  /** How many paragraphs the bio breaks into. */
  bioParagraphs: number;
  /** Mean length of an achievement line — short lines suit a wall, long ones a list. */
  avgAchievementLength: number;
}

export const EMPTY_PROFILE: ContentProfile = {
  hasCover: false, hasLogo: false, galleryCount: 0, bioLength: 0,
  subjectsCount: 0, achievementsCount: 0,
  courseCount: 0, reviewCount: 0, avgRating: 0,
  bioParagraphs: 0, avgAchievementLength: 0,
};

/**
 * How strong a case this page can make on its own evidence.
 *
 * A page with no photographs, a two-line bio and no courses cannot be given a
 * layout that assumes any of those and still look finished — it needs a
 * typographic design, and this is what tells the planner so.
 */
export function evidenceStrength(p: ContentProfile): 'thin' | 'normal' | 'strong' {
  let score = 0;
  if (p.hasCover) score += 2;
  if (p.galleryCount >= 4) score += 2;
  else if (p.galleryCount > 0) score += 1;
  if (p.bioLength >= 320) score += 2;
  else if (p.bioLength >= 120) score += 1;
  if (p.achievementsCount >= 4) score += 2;
  else if (p.achievementsCount >= 2) score += 1;
  if (p.courseCount >= 4) score += 2;
  else if (p.courseCount >= 1) score += 1;
  if (p.reviewCount >= 4) score += 1;
  if (score >= 8) return 'strong';
  if (score >= 4) return 'normal';
  return 'thin';
}

/** The fit context for one section, from the profile plus that block's own content. */
export function fitFor(
  profile: ContentProfile,
  archetype: string,
  over: Partial<FitContext> = {},
): FitContext {
  return {
    archetype,
    items: 0,
    hasMedia: false,
    galleryCount: profile.galleryCount,
    textLength: profile.bioLength,
    courseCount: profile.courseCount,
    reviewCount: profile.reviewCount,
    ...over,
  };
}

/**
 * The patterns this teacher's content actually unlocks, grouped by section.
 *
 * Handed to the planning model as a menu. Telling it what it cannot have is what
 * stops it designing an immersive gallery for someone with two photographs and
 * then having the design quietly downgraded underneath it.
 */
export function availablePatterns(
  profile: ContentProfile,
  archetype: string,
  perSection: Record<string, Partial<FitContext>> = {},
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const p of allPatterns()) {
    const fit = fitFor(profile, archetype, perSection[p.section] ?? {});
    if (!patternFits(p, fit)) continue;
    (out[p.section] ??= []).push(p.id);
  }
  return out;
}
