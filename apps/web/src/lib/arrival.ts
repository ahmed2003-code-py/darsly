/**
 * Remember which academy a visitor arrived through.
 *
 * A student is sent their teacher's link, reads the teacher's site, clicks a
 * course, and is bounced to sign in. At that moment the app knows nothing about
 * them — no account, no enrolment, no membership — so without this the sign-in
 * screen is the platform's, in the platform's colours, offering to register them
 * as a teacher. From the student's side they simply left their teacher's site
 * and landed somewhere else.
 *
 * The slug is kept in localStorage rather than router state because the journey
 * crosses a full document load: the academy site is server-rendered HTML in an
 * iframe, and its links are ordinary navigations.
 *
 * This is a hint about where someone came from, never a permission. It decides
 * which colours to paint and which sign-up options to offer; anything that
 * grants access is still decided by the API.
 */

const KEY = 'darsly-arrival-academy';

/** A slug is a path segment in a URL we build, so only the safe shape is kept. */
const looksLikeSlug = (v: string) => /^[a-zA-Z0-9._-]{1,80}$/.test(v);

export function rememberArrival(slug: string | undefined | null): void {
  if (!slug || !looksLikeSlug(slug)) return;
  try {
    localStorage.setItem(KEY, slug);
  } catch {
    // Private mode, or storage full. The journey still works; it just stops
    // carrying the teacher's identity across the sign-in.
  }
}

export function arrivalAcademy(): string | null {
  try {
    const v = localStorage.getItem(KEY);
    return v && looksLikeSlug(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Forget it once the account it led to is established.
 *
 * Left in place it would outlive its meaning — a teacher who once opened a
 * colleague's link would keep being offered that colleague's colours on every
 * later sign-in.
 */
export function clearArrival(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}
