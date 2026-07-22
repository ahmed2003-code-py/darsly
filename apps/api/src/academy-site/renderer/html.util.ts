/** HTML-escape text for element content. */
export function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape a value used inside a double-quoted HTML attribute. */
export function escapeAttr(s: string): string {
  return escapeHtml(s);
}

/** Allow only http(s) URLs and same-origin absolute paths; otherwise blank. */
export function safeUrl(url: string | undefined): string {
  if (!url) return '';
  const u = url.trim();
  if (/^https?:\/\//i.test(u) || u.startsWith('/')) return u;
  return '';
}
