import { MutationCache, QueryClient } from '@tanstack/react-query';
import { resolveError } from './errorMessage';
import { useToastStore } from './toast';

/**
 * The one query cache, reachable from outside React.
 *
 * It lives here rather than in `main.tsx` because signing out has to empty it,
 * and signing out happens in the auth store and in the axios interceptor —
 * neither of which is a component and neither of which can call a hook.
 */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
  /**
   * Every write that fails says so, once, in the reader's language.
   *
   * Put here rather than at each call site because "the save failed and nobody
   * was told" was the common case, not the exception: a screen had to remember
   * to render an `ErrorNote`, and most row actions, toggles and uploads had
   * nowhere to put one — so the refusal went to the console and the reader was
   * left looking at a button that appeared to do nothing.
   *
   * A mutation that reports its own failure better (a form with field-level
   * copy, a flow with its own recovery UI) opts out with
   * `meta: { silentError: true }`.
   */
  mutationCache: new MutationCache({
    onError: (error, _vars, _ctx, mutation) => {
      if (mutation.meta?.silentError) return;
      const { message, status } = resolveError(error);
      // 401 is not a refusal the reader can act on: the axios interceptor has
      // already tried to refresh and, having failed, signed them out. The
      // sign-in screen they land on is the message.
      if (!message || status === 401) return;
      useToastStore.getState().push({ tone: 'error', message });
    },
  }),
});

/**
 * Keys that survive a sign-out, because they describe the *device*, not the
 * person: which end of the palette this screen is on, and the look that was
 * last painted. Everything else is somebody's data and goes.
 *
 * Looks are kept too, but each under its own account's key — `darsly-studio:<id>`
 * (see `studioKeyFor`). They survive a sign-out so somebody returning finds
 * their own exactly as they left it and sees no repaint, and they cannot reach
 * anyone else because no other account ever reads that key. The single shared
 * `darsly-studio` this replaced is deliberately NOT in the list: any device
 * still carrying one drops it on the next boot.
 */
const DEVICE_KEYS = new Set(['darsly-color-mode', 'darsly-theme']);
const DEVICE_PREFIXES = ['darsly-studio:'];

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
      const keep = DEVICE_KEYS.has(key) || DEVICE_PREFIXES.some((p) => key.startsWith(p));
      if (!keep) localStorage.removeItem(key);
    }
    sessionStorage.clear();
  } catch {
    // A browser with storage blocked has nothing to forget.
  }
}
