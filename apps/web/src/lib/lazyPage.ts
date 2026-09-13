import { ComponentType, lazy, LazyExoticComponent } from 'react';

/**
 * A lazily-loaded page that survives one bad moment on the network.
 *
 * Every screen is its own chunk, so opening one is a network request — and the
 * first request a phone makes after waking, or the one that lands while the
 * server is still starting, is exactly the one that fails. A single failure
 * used to reach the error boundary and show a student "something went wrong"
 * for a page that would have loaded a second later.
 *
 * Three attempts with a short back-off. A chunk that is genuinely gone (a
 * deploy replaced it while the tab held the old index) fails all three and
 * reaches the boundary, which reloads to pick up the current build — that path
 * is still there, this only stops it being taken for a dropped packet.
 */
export function lazyPage<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(() => withRetry(load));
}

const ATTEMPTS = 3;

async function withRetry<T>(load: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      return await load();
    } catch (err) {
      last = err;
      // 300ms, then 600ms. Long enough for a handover or a cold start to
      // finish, short enough that nobody reads it as the page being broken.
      if (attempt < ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
      }
    }
  }
  throw last;
}
