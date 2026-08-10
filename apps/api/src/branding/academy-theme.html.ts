import { AppTheme } from './app-theme';

/**
 * Put the academy's colours in the HTML before the browser has it.
 *
 * The app can only theme itself after React has mounted and a request has come
 * back, which on a cold visit is a second or two of the platform's palette
 * followed by a repaint. Coming from a teacher's own site that reads as having
 * been handed off to a different product at the exact moment someone decides to
 * sign up.
 *
 * The API serves the app's HTML, so the fix is to answer with the colours
 * already in it. No round trip, no cache to warm, nothing to flash — the first
 * paint is correct.
 *
 * Both functions here are pure so the parsing and the escaping can be tested
 * without a server.
 */

/**
 * The academy a request is about, if any.
 *
 * Two shapes carry it: the academy's own pages, and an auth page that remembers
 * where the visitor was heading. The second matters most — the flash the visitor
 * actually sees is on `/login`, and by then the slug survives only in the
 * redirect it is carrying.
 */
export function academySlugFromUrl(url: string): string | null {
  const [path, query = ''] = url.split('?');

  const direct = path.match(/^\/(?:a|t)\/([^/?#]+)/);
  if (direct) return safeSlug(decodeURIComponent(direct[1]));

  if (/^\/(login|register)\b/.test(path)) {
    const redirect = new URLSearchParams(query).get('redirect');
    if (redirect) {
      const nested = decodeURIComponent(redirect).match(/^\/(?:a|t)\/([^/?#]+)/);
      if (nested) return safeSlug(decodeURIComponent(nested[1]));
    }
  }
  return null;
}

/** Slugs go into a database lookup, so only the shape a slug can have is kept. */
function safeSlug(value: string): string | null {
  return /^[a-zA-Z0-9._-]{1,80}$/.test(value) ? value : null;
}

/**
 * Write the theme into the document head.
 *
 * The values are numbers and the names are `--c-*` — both re-checked here rather
 * than trusted, because this is the one place where a stored token would become
 * live CSS in every visitor's browser. Anything that does not match is dropped
 * rather than escaped: there is no legitimate token that needs escaping.
 */
export function injectTheme(html: string, theme: AppTheme): string {
  const declarations = Object.entries(theme.tokens)
    .filter(([name, value]) => /^--c-[a-z0-9-]+$/.test(name) && /^\d{1,3} \d{1,3} \d{1,3}$/.test(value))
    .map(([name, value]) => `${name}:${value}`)
    .join(';');
  if (!declarations) return html;

  const mode = theme.mode === 'dark' ? 'dark' : 'light';
  // A plain <style> rather than an inline style attribute: it lands in the head
  // with the rest of the CSS, and the app's own `applyTheme` writes inline
  // properties later, which therefore win when the two ever disagree.
  const tag = `<style id="academy-theme">:root{${declarations}}</style>`;

  const withTheme = html.includes('</head>')
    ? html.replace('</head>', `${tag}</head>`)
    : tag + html;

  // `data-theme` drives the handful of effects that are not a flat colour.
  return withTheme.replace(/<html([^>]*)>/, (match, attrs: string) =>
    /\bdata-theme=/.test(attrs) ? match : `<html${attrs} data-theme="${mode}">`,
  );
}
