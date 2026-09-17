/**
 * What a formatting button does to the text, decided away from the DOM.
 *
 * The editor used to work this out inline, against an element it found with
 * `document.getElementById`, which meant the one thing worth testing — where
 * the characters go and where the caret lands — could only be checked by
 * opening the app and clicking. It is a pure function of (text, selection,
 * mark) and is written as one here.
 *
 * The rule the whole thing follows: **a button is a toggle.** Pressing bold on
 * bold text takes the bold off. It used to add a second pair, so a teacher who
 * pressed it twice got `****كده****`, which renders as literal asterisks — and
 * the only way back was to delete them by hand.
 */

export type Mark =
  | { key: string; icon: string; wrap: string }
  | { key: string; icon: string; line: string; numbered?: boolean };

export const MARKS: Mark[] = [
  { key: 'bold', icon: 'format_bold', wrap: '**' },
  { key: 'italic', icon: 'format_italic', wrap: '*' },
  { key: 'bullet', icon: 'format_list_bulleted', line: '- ' },
  { key: 'number', icon: 'format_list_numbered', line: '1. ', numbered: true },
  { key: 'heading', icon: 'title', line: '## ' },
];

export interface Applied {
  value: string;
  /** Where the selection should sit afterwards — kept, not collapsed. */
  start: number;
  end: number;
}

/** A line already carrying this mark, `- ` or `## ` or `3. `. */
function linePrefix(line: string, mark: { line: string; numbered?: boolean }): string | null {
  if (mark.numbered) {
    const m = /^\d+\.\s/.exec(line);
    return m ? m[0] : null;
  }
  return line.startsWith(mark.line) ? mark.line : null;
}

/**
 * Bold inside bold is the one case where "is it already marked?" is ambiguous:
 * with `**كده**` and `كده` selected, the characters either side are `*`, so a
 * naive italic toggle would strip one from each and quietly turn bold into
 * italic. An italic toggle therefore refuses to act on what is really a bold
 * pair.
 */
function wrappedWith(value: string, start: number, end: number, wrap: string): boolean {
  const before = value.slice(start - wrap.length, start);
  const after = value.slice(end, end + wrap.length);
  if (before !== wrap || after !== wrap) return false;
  if (wrap === '*' && value.slice(start - 2, start) === '**') return false;
  return true;
}

export function applyMark(value: string, start: number, end: number, mark: Mark): Applied {
  if ('wrap' in mark) {
    const w = mark.wrap;
    // Already marked: take it off, and keep the same words selected.
    if (wrappedWith(value, start, end, w)) {
      return {
        value: value.slice(0, start - w.length) + value.slice(start, end) + value.slice(end + w.length),
        start: start - w.length,
        end: end - w.length,
      };
    }
    const selected = value.slice(start, end);
    return {
      value: value.slice(0, start) + w + selected + w + value.slice(end),
      start: start + w.length,
      end: start + w.length + selected.length,
    };
  }

  // Line marks cover every line the selection touches, from the start of the
  // first to the end of the last — so marking three lines is one press, and the
  // press does not chop a line in half at the cursor.
  const from = value.lastIndexOf('\n', start - 1) + 1;
  const toIdx = value.indexOf('\n', end);
  const to = toIdx === -1 ? value.length : toIdx;
  const lines = value.slice(from, to).split('\n');

  // Off only when every line already has it: a half-marked block fills in
  // rather than clearing, which is what someone pressing the button means.
  const allMarked = lines.every((l) => linePrefix(l, mark) !== null);
  const marked = lines.map((line, i) => {
    const has = linePrefix(line, mark);
    if (allMarked) return has ? line.slice(has.length) : line;
    if (has) return line;
    return (mark.numbered ? `${i + 1}. ` : mark.line) + line;
  });

  const block = marked.join('\n');
  return { value: value.slice(0, from) + block + value.slice(to), start: from, end: from + block.length };
}
