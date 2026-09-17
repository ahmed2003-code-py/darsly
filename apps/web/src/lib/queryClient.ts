import { QueryClient } from '@tanstack/react-query';

/**
 * The one query cache, reachable from outside React.
 *
 * It lives here rather than in `main.tsx` because signing out has to empty it,
 * and signing out happens in the auth store and in the axios interceptor —
 * neither of which is a component and neither of which can call a hook.
 */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

/**
 * Keys that survive a sign-out, because they describe the *device*, not the
 * person: which end of the palette this screen is on, and the look that was
 * last painted. Everything else is somebody's data and goes.
 *
 * `darsly-studio` is the cached copy of the look. It is deliberately kept — see
 * `releaseStudio` — so the app does not flash back to platform indigo in the
 * moment between signing out and signing back in.
 *
 * `darsly-studio-owner` is kept **with it, and must be**. It is the id the look
 * belongs to, and `claimStudio` drops the look by comparing it against whoever
 * just arrived. Removing it as "user data" left that comparison with nothing to
 * compare: the look stopped being dropped at all, and one student's theme was
 * worn by the next teacher and admin to sign in. The look and its owner are one
 * fact and are kept or dropped together.
 */
const DEVICE_KEYS = new Set([
  'darsly-color-mode',
  'darsly-theme',
  'darsly-studio',
  'darsly-studio-owner',
]);

/**
 * Forget the person who was just signed in.
 *
 * Three things hold their data and all three have to go together, or the next
 * account sees the last one's:
 *
 *  - the react-query cache, which is the one that bit: a query keyed `['wallet']`
 *    is keyed by *what* it fetches and never by *whose* it is, so an admin
 *    signing in after a student was handed the student's balance out of memory,
 *    instantly, before any request went out;
 *  - localStorage, minus the device keys above;
 *  - sessionStorage, which is where a redirect destination waits — that is how
 *    the admin was sent to the student's wallet page in the first place.
 *
 * Safe to call twice, and safe to call when nobody was signed in.
 */
export function forgetUserData(): void {
  queryClient.clear();
  try {
    for (const key of Object.keys(localStorage)) {
      if (!DEVICE_KEYS.has(key)) localStorage.removeItem(key);
    }
    sessionStorage.clear();
  } catch {
    // A browser with storage blocked has nothing to forget.
  }
}
