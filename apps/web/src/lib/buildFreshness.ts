/**
 * A tab left open across a deploy keeps running the build it was opened with.
 *
 * The strings are loaded once, at boot (i18n/index.ts), but the API is the new
 * one the moment the deploy finishes. So the old tab draws whatever the new API
 * names and the old build has no words for: Admin → Features showed
 * "admin.featureFlag.receptionDesk.label" for flags the server had just added,
 * while a freshly opened tab showed them correctly. Nothing was missing from
 * the deployed files — the page was simply older than the server.
 *
 * Every deploy changes the hashed entry script that index.html loads, so that
 * is the build's identity. When the tab comes back into view, or every few
 * minutes, the current index.html is fetched (no-cache) and its entry script
 * compared with the one this tab runs. If they differ, the next in-app
 * navigation becomes a full page load (components/BuildFreshness.tsx) of the same address: the reader has
 * already left the screen they were on, so nothing typed is lost, and they land
 * on the new build without being interrupted mid-form.
 */

const ENTRY = /<script[^>]+src="(\/assets\/index-[\w-]+\.js)"/;

/** The entry script an index.html loads, or null when it names none. */
export function entryScriptOf(html: string): string | null {
  return ENTRY.exec(html)?.[1] ?? null;
}

/** The entry script this tab is running (its own module script tag). */
export function runningEntry(doc: Document = document): string | null {
  const el = doc.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]');
  if (!el) return null;
  return new URL(el.src, doc.baseURI).pathname;
}

/**
 * Whether the served build differs from the running one. Unknown on either side
 * is never "stale": a failed fetch or an unusual page must not reload anyone.
 */
export function isStale(running: string | null, served: string | null): boolean {
  return running != null && served != null && running !== served;
}
