/**
 * Split plain text into text and link pieces, for rendering a chat message.
 *
 * Nothing here produces HTML: the renderer turns each piece into a React
 * text node or an <a>, so a message can never inject markup. Only http(s)
 * links become clickable (a bare "www." gets https://); `javascript:`,
 * `data:` and every other scheme stay plain text because they never match.
 * Trailing punctuation that ends a sentence — including Arabic ، and ؟ — is
 * left outside the link, as are unbalanced closing brackets.
 */
export type TextToken =
  { type: 'text'; value: string } | { type: 'link'; value: string; href: string };

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
const TRAILING = /[.,;:!?،؛؟…'"\]}»]+$/;

function balance(url: string): string {
  // Keep a closing ")" that closes an opening "(" inside the URL (wiki links).
  let out = url;
  while (/\)$/.test(out) && (out.match(/\(/g)?.length ?? 0) < (out.match(/\)/g)?.length ?? 0)) {
    out = out.slice(0, -1);
  }
  return out;
}

export function tokenizeLinks(text: string): TextToken[] {
  const out: TextToken[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    // Peel sentence punctuation and unbalanced closing brackets, in any order
    // they come ("…(see https://x.io/a)." ends with ")." ), until stable.
    let url = m[0];
    for (let prev = ''; prev !== url;) {
      prev = url;
      url = balance(url.replace(TRAILING, ''));
    }
    if (url.length < 5) continue;
    const start = m.index ?? 0;
    const href = /^www\./i.test(url) ? `https://${url}` : url;
    if (!/^https?:\/\/[^\s/]+\.[^\s]+/i.test(href) && !/^https?:\/\/localhost/i.test(href))
      continue;
    if (start > last) out.push({ type: 'text', value: text.slice(last, start) });
    out.push({ type: 'link', value: url, href });
    last = start + url.length;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out;
}
