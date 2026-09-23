import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/**
 * The small slice of Markdown a teacher actually types.
 *
 * Descriptions and bios are written in a plain textarea, and people write
 * `**عنوان**` and `- بند` in them because that is what writing looks like
 * everywhere else. Until now the asterisks were printed literally, so the
 * effort made the text worse rather than better.
 *
 * This renders to React elements and never to HTML. There is no
 * `dangerouslySetInnerHTML` anywhere below, which means a description
 * containing `<script>` is displayed as those characters and cannot execute —
 * the safety comes from the shape of the code rather than from a sanitiser
 * that has to be kept ahead of its attackers.
 *
 * Supported, because it is what gets used: headings, bold, italic,
 * strikethrough, inline code, fenced code, bullet and numbered lists, quotes,
 * horizontal rules, links, and bare URLs. Tables, images and HTML are not —
 * a course description is a paragraph, not a document.
 */

// ── Inline ──────────────────────────────────────────────────────────────────

/**
 * One pass, alternation ordered so `**` is tried before `*`. No lookbehind:
 * Safari only gained it in 16.4, and a parse error there would take down the
 * whole bundle rather than just this feature.
 *
 * A new instance per call, never a shared constant. A `g` regex keeps
 * `lastIndex` on the object, and this parser recurses into the text it has
 * just matched — one shared instance would let the inner call move the outer
 * call's cursor, which shows up as a hang rather than as a wrong result.
 */
const inlineRe = () =>
  /(\*\*|__)([\s\S]+?)\1|(\*|_)([\s\S]+?)\3|~~([\s\S]+?)~~|`([^`\n]+)`|\[([^\]\n]+)\]\(([^()\s]+)\)|(https?:\/\/[^\s<>()[\]]+)/g;

const WORD = /[\p{L}\p{N}_]/u;

/**
 * Links are the one place a string from the database becomes something the
 * browser will act on, so the scheme is checked against a list of three rather
 * than against a list of what to reject. `javascript:` and `data:` are not
 * refused by name — they simply never match.
 */
function safeHref(href: string): string | null {
  const h = href.trim();
  if (/^https?:\/\//i.test(h) || /^mailto:/i.test(h)) return h;
  if (h.startsWith('/') && !h.startsWith('//')) return h; // in-app route
  return null;
}

const LINK_CLASS = 'font-bold text-primary underline underline-offset-2 hover:no-underline';

/**
 * An in-app path stays in the app. Sending `/courses` through `target="_blank"`
 * would drop the reader into a fresh page load of the site they are already on;
 * only a link that leaves the site earns a new tab, and with it `noopener`.
 */
function Anchor({ href, bare, children }: { href: string; bare?: boolean; children: ReactNode }) {
  const internal = href.startsWith('/');
  const className = bare ? `break-all ${LINK_CLASS}` : LINK_CLASS;
  if (internal) {
    return (
      <Link to={href} className={className} dir={bare ? 'ltr' : undefined}>
        {children}
      </Link>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className={className}
      dir={bare ? 'ltr' : undefined}
    >
      {children}
    </a>
  );
}

function inline(src: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = inlineRe();
  let last = 0;
  let n = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(src))) {
    const [whole] = m;
    // `_` inside a word is a word, not emphasis: `file_name_here` and
    // `snake_case` are far more common in a description than italics are.
    if (m[3] === '_') {
      const before = src[m.index - 1];
      const after = src[m.index + whole.length];
      if ((before && WORD.test(before)) || (after && WORD.test(after))) continue;
    }
    if (m.index > last) out.push(src.slice(last, m.index));
    const k = `${key}-${n++}`;

    if (m[1])
      out.push(
        <strong key={k} className="font-bold">
          {inline(m[2], k)}
        </strong>,
      );
    else if (m[3])
      out.push(
        <em key={k} className="italic">
          {inline(m[4], k)}
        </em>,
      );
    else if (m[5])
      out.push(
        <s key={k} className="opacity-70">
          {inline(m[5], k)}
        </s>,
      );
    else if (m[6]) {
      out.push(
        <code
          key={k}
          className="rounded bg-surface-container-high px-1.5 py-0.5 font-mono text-[0.9em]"
          dir="ltr"
        >
          {m[6]}
        </code>,
      );
    } else if (m[7]) {
      const href = safeHref(m[8]);
      // A link whose target we will not follow still has text worth reading,
      // so it degrades to that text rather than disappearing.
      out.push(
        href ? (
          <Anchor key={k} href={href}>
            {inline(m[7], k)}
          </Anchor>
        ) : (
          <span key={k}>{inline(m[7], k)}</span>
        ),
      );
    } else if (m[9]) {
      const href = safeHref(m[9]);
      out.push(
        href ? (
          <Anchor key={k} href={href} bare>
            {m[9]}
          </Anchor>
        ) : (
          m[9]
        ),
      );
    }
    last = m.index + whole.length;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

/** Soft newlines become breaks: someone typing into a textarea means them. */
function withBreaks(text: string, key: string): ReactNode[] {
  const lines = text.split('\n');
  return lines.flatMap((line, i) =>
    i === 0
      ? inline(line, `${key}-${i}`)
      : [<br key={`${key}-br-${i}`} />, ...inline(line, `${key}-${i}`)],
  );
}

// ── Blocks ──────────────────────────────────────────────────────────────────

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBER = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*(\S*)\s*$/;

const HEADING_CLASS = [
  'font-heading text-2xl font-extrabold',
  'font-heading text-xl font-bold',
  'font-heading text-lg font-bold',
  'font-heading text-base font-bold',
  'font-heading text-sm font-bold',
  'font-heading text-sm font-bold text-on-surface-variant',
];

function blocks(src: string): ReactNode[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let n = 0;

  while (i < lines.length) {
    const line = lines[i];
    const key = `b${n++}`;

    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const close = fence[1][0];
      const body: string[] = [];
      i++;
      while (
        i < lines.length &&
        !new RegExp(`^\\s{0,3}${close === '`' ? '`' : '~'}{3,}\\s*$`).test(lines[i])
      ) {
        body.push(lines[i++]);
      }
      i++; // the closing fence, or the end of the text
      out.push(
        <pre
          key={key}
          dir="ltr"
          className="mb-3 overflow-x-auto rounded-xl bg-surface-container-high p-3 text-sm last:mb-0"
        >
          <code className="font-mono">{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    if (RULE.test(line)) {
      out.push(<hr key={key} className="my-4 border-outline-variant" />);
      i++;
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      const level = h[1].length;
      const Tag = `h${Math.min(level + 2, 6)}` as 'h3';
      out.push(
        <Tag key={key} className={`mb-2 mt-3 first:mt-0 ${HEADING_CLASS[level - 1]}`}>
          {inline(h[2], key)}
        </Tag>,
      );
      i++;
      continue;
    }

    if (BULLET.test(line) || NUMBER.test(line)) {
      const ordered = !BULLET.test(line);
      const items: string[] = [];
      while (i < lines.length) {
        const b = BULLET.exec(lines[i]);
        const o = NUMBER.exec(lines[i]);
        if (ordered && o) items.push(o[2]);
        else if (!ordered && b) items.push(b[1]);
        else break;
        i++;
      }
      const cls = 'mb-3 space-y-1 ps-5 last:mb-0';
      const children = items.map((it, k) => (
        <li key={`${key}-${k}`} className="leading-relaxed">
          {inline(it, `${key}-${k}`)}
        </li>
      ));
      out.push(
        ordered ? (
          <ol key={key} className={`list-decimal ${cls}`}>
            {children}
          </ol>
        ) : (
          <ul key={key} className={`list-disc ${cls}`}>
            {children}
          </ul>
        ),
      );
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])![1]);
      out.push(
        <blockquote
          key={key}
          className="mb-3 border-s-4 border-primary/40 ps-3 italic text-on-surface-variant last:mb-0"
        >
          {withBreaks(body.join('\n'), key)}
        </blockquote>,
      );
      continue;
    }

    // A paragraph runs to the next blank line or the next block that starts one.
    const body: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) body.push(lines[i++]);
    out.push(
      <p key={key} className="mb-3 leading-relaxed last:mb-0">
        {withBreaks(body.join('\n'), key)}
      </p>,
    );
  }
  return out;
}

function isBlockStart(line: string): boolean {
  return (
    HEADING.test(line) ||
    BULLET.test(line) ||
    NUMBER.test(line) ||
    QUOTE.test(line) ||
    RULE.test(line) ||
    FENCE.test(line)
  );
}

// ── Public ──────────────────────────────────────────────────────────────────

/**
 * `dir="auto"` on the wrapper, not a hardcoded rtl: a description can be Arabic,
 * English, or Arabic that opens with an English product name, and the browser
 * decides that per block better than we can.
 */
export function Markdown({
  children,
  className = '',
}: {
  children?: string | null;
  className?: string;
}) {
  const src = (children ?? '').trim();
  if (!src) return null;
  return (
    <div dir="auto" className={className}>
      {blocks(src)}
    </div>
  );
}

/**
 * The same text with the marks taken off, for the places that show two clamped
 * lines of it. Rendering real formatting inside a `line-clamp-2` card would
 * fight the clamp; printing the raw asterisks there is what it looks like now.
 */
export function stripMarkdown(src?: string | null): string {
  if (!src) return '';
  return src
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, ' ')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/!\[([^\]\n]*)\]\([^()\s]+\)/g, '$1')
    .replace(/\[([^\]\n]+)\]\([^()\s]+\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,3}\d{1,9}[.)]\s+/gm, '')
    .replace(/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/gm, ' ')
    .replace(/(\*\*|__)([\s\S]+?)\1/g, '$2')
    .replace(/~~([\s\S]+?)~~/g, '$1')
    .replace(/(^|[^\p{L}\p{N}_])[*_]([^*_\n]+)[*_]/gu, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}
