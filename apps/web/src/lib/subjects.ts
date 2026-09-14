/** Mirrors `SubjectTrack` on the API. */
export const SUBJECT_TRACKS = ['GENERAL', 'LANGUAGES', 'BOTH'] as const;
export type SubjectTrack = (typeof SUBJECT_TRACKS)[number];

/** What a student can be. `BOTH` describes a subject, not a school. */
export const STUDENT_TRACKS = ['GENERAL', 'LANGUAGES'] as const;
export type StudentTrack = (typeof STUDENT_TRACKS)[number];

export interface Subject {
  id: string;
  nameAr: string;
  nameEn: string;
  icon?: string | null;
  track: SubjectTrack;
}

/** The order the groups are offered in: shared first, then each system. */
export const TRACK_ORDER: SubjectTrack[] = ['BOTH', 'GENERAL', 'LANGUAGES'];

export const subjectName = (s: Subject, ar: boolean) => (ar ? s.nameAr : s.nameEn);

/**
 * Match a subject against what was typed, in either language at once.
 *
 * A teacher hunting for "Math" should not have to know whether the list is
 * currently rendering Arabic names, and one typing "ريا" should reach
 * "الرياضيات" — so both names are searched however the app is set.
 */
export function subjectMatches(s: Subject, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return `${s.nameAr} ${s.nameEn}`.toLowerCase().includes(needle);
}
