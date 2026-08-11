/**
 * The academy's public address: darsly.app/a/<slug>.
 *
 * Auto-generated at signup as something like `ae0011w`, which is fine for a
 * system and useless on a business card — so a teacher can rename it. Every
 * rule about what a slug may be lives here, shared by the write path and the
 * availability check, because a suggestion the checker calls free and the
 * update then rejects is worse than no suggestion at all.
 */

/** Addresses the platform needs for itself, or that would read as a promise. */
export const RESERVED_SLUGS = new Set([
  'admin', 'api', 'app', 'auth', 'login', 'register', 'course', 'courses',
  'teacher', 'teachers', 'student', 'students', 'discover', 'profile',
  'settings', 'security', 'wallet', 'payments', 'live', 'messages', 'a', 't',
  'darsly', 'support', 'help', 'about', 'terms', 'privacy', 'static', 'assets',
]);

export const SLUG_MIN = 3;
export const SLUG_MAX = 40;

/** Lower-case letters, digits, single hyphens; no hyphen at either end. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Turn what a person typed into a usable address.
 *
 * "Ahmed Elsayed" → "ahmed-elsayed". Arabic and other non-Latin characters have
 * no ASCII equivalent to fall back on, so they drop out; a name written entirely
 * in Arabic therefore normalizes to nothing, and the caller must treat an empty
 * result as "suggest something else" rather than as a valid slug.
 */
export function slugify(raw: string): string {
  return raw
    .normalize('NFKD')
    // Strip combining marks left behind by the decomposition (é → e).
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    // A trailing hyphen can reappear after the length cut.
    .replace(/-+$/g, '');
}

export type SlugRejection = 'INVALID' | 'RESERVED' | 'TAKEN';

/** Shape-only check; uniqueness needs the database and lives in the service. */
export function slugShapeError(slug: string): SlugRejection | null {
  if (slug.length < SLUG_MIN || slug.length > SLUG_MAX) return 'INVALID';
  if (!SLUG_PATTERN.test(slug)) return 'INVALID';
  if (RESERVED_SLUGS.has(slug)) return 'RESERVED';
  return null;
}

/**
 * Candidate addresses to offer when the wanted one is gone, in the order a
 * person would most likely accept them: the plain word first, then numbered.
 */
export function slugCandidates(base: string, limit = 12): string[] {
  const seed = base.length >= SLUG_MIN ? base : `${base}-academy`;
  // A word already at the end is not worth repeating: padding a short base with
  // "-academy" and then suffixing it again produced `ab-academy-academy`.
  const words = ['academy', 'online', 'eg'].filter((w) => !seed.endsWith(`-${w}`) && seed !== w);
  const out = words.map((w) => `${seed}-${w}`);
  for (let n = 2; out.length < limit; n++) out.push(`${seed}${n}`);
  return out
    .map((s) => s.slice(0, SLUG_MAX).replace(/-+$/g, ''))
    .filter((s, i, all) => !slugShapeError(s) && all.indexOf(s) === i);
}
