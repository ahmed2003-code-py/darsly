/**
 * Where to send someone after they sign in.
 *
 * A generated academy site is plain server-rendered HTML that links straight into
 * the app ("ابدأ الآن" → `/course/<id>`), so a visitor who is not signed in gets
 * bounced to the login page mid-journey. Losing their destination there means
 * they land on a dashboard and have to find the course again — most simply do
 * not, so the whole funnel leaks at its last step.
 *
 * The destination therefore travels as a query parameter rather than router
 * state: it has to survive a full document load coming from the academy site,
 * which router state does not.
 */

export const REDIRECT_PARAM = 'redirect';

/**
 * Only ever return a path inside this app.
 *
 * Anything absolute — `https://evil.example`, or the protocol-relative
 * `//evil.example` a naive `startsWith('/')` check would wave through — is
 * discarded, so a crafted login link can never bounce a signed-in user to
 * someone else's site.
 */
export function safeRedirect(raw: string | null | undefined, fallback = '/'): string {
  if (!raw) return fallback;
  const value = raw.trim();
  if (!value.startsWith('/')) return fallback;
  if (value.startsWith('//')) return fallback;
  if (value.startsWith('/\\')) return fallback;
  // Never bounce back into the auth pages: that loops.
  if (/^\/(login|register|forgot-password|reset-password)\b/.test(value)) return fallback;
  return value;
}

/** Build the login URL that remembers where the visitor was heading. */
export function loginUrlFor(pathname: string, search = ''): string {
  const target = `${pathname}${search}`;
  if (target === '/' || !target.startsWith('/')) return '/login';
  return `/login?${REDIRECT_PARAM}=${encodeURIComponent(target)}`;
}

/**
 * Carry the destination across the auth pages themselves. Without this it is
 * lost the moment someone clicks "create an account" from the login screen.
 */
export function withRedirect(path: string, destination: string): string {
  if (!destination || destination === '/') return path;
  return `${path}?${REDIRECT_PARAM}=${encodeURIComponent(destination)}`;
}
