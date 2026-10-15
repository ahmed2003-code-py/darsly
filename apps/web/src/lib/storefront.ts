/**
 * How `/a/:slug` is shown.
 *
 * An academy that published a Studio site shows that site — the teacher's
 * shopfront, with its own colours, full screen. One that has not used to fall
 * back to a standalone page from July: its own header with a "Sign in" button
 * even for a signed-in student, the platform's old default purple, a course
 * card that read a `grade` field the API no longer sends — and, because the
 * student's look was switched off for every `/a/*` URL, a student lost their
 * theme on it too.
 *
 *  - SITE    published: the site, and only it (the student's look stands down).
 *  - APP     not published, signed in: the academy inside the normal app, with
 *            the person's own account, navigation and look.
 *  - PUBLIC  not published, a visitor: the same content in the current public
 *            frame, with sign-in and sign-up.
 */
export type StorefrontView = 'SITE' | 'APP' | 'PUBLIC';

export function storefrontView(x: { published: boolean; signedIn: boolean }): StorefrontView {
  if (x.published) return 'SITE';
  return x.signedIn ? 'APP' : 'PUBLIC';
}

/** The student's look stands down only for a published site — never for the fallback. */
export function studentLookSuspended(view: StorefrontView | null): boolean {
  return view === 'SITE';
}

/** A course's years, named in the reader's language (the API sends `grades[]`). */
export function courseYearsLabel(
  grades: { nameAr: string; nameEn: string }[] | null | undefined,
  lang: string,
): string {
  const en = lang.startsWith('en');
  return (grades ?? []).map((g) => (en ? g.nameEn : g.nameAr)).join(en ? ', ' : '، ');
}
