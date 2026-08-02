/**
 * Text hygiene for facts that flow into visible sections. Teachers paste bios
 * and CV bullets that contain Markdown (`* item`, `**bold**`, `# heading`) and
 * ragged whitespace; dumping that verbatim into the page looks broken. These
 * pure helpers strip Markdown and normalise lists.
 *
 * Phase 1 (deterministic) removes the obvious noise. Phase 2 (AI Generation)
 * replaces raw fact lists with curated, editor-quality copy.
 */

/** Strip common Markdown constructs, leaving readable plain text. */
export function stripMarkdown(input: string): string {
  return String(input ?? '')
    .replace(/```[\s\S]*?```/g, ' ') // fenced code
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links -> label
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // ATX headings
    .replace(/^\s{0,3}>\s?/gm, '') // blockquotes
    .replace(/^\s*[-*+]\s+/gm, '') // unordered bullet markers
    .replace(/^\s*\d+[.)]\s+/gm, '') // ordered list markers
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold **
    .replace(/__([^_]+)__/g, '$1') // bold __
    .replace(/\*([^*]+)\*/g, '$1') // italic *
    .replace(/~~([^~]+)~~/g, '$1') // strikethrough
    .replace(/[*_`#>]/g, '') // stray markdown tokens
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** Strip Markdown and collapse a possibly multi-line value to one clean line. */
export function cleanLine(input: string): string {
  return stripMarkdown(input).replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

export interface CleanListOptions {
  /** Drop entries shorter than this many characters (removes noise fragments). */
  min?: number;
  /** Truncate each entry to this length. */
  maxLen?: number;
  /** Keep at most this many entries. */
  cap?: number;
}

/**
 * Normalise a fact list for display: strip Markdown, trim, drop empties/too-short
 * fragments, de-duplicate case-insensitively, and cap the count — order preserved.
 */
export function cleanList(items: unknown, opts: CleanListOptions = {}): string[] {
  if (!Array.isArray(items)) return [];
  const { min = 1, maxLen = Infinity, cap = Infinity } = opts;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    if (typeof raw !== 'string') continue;
    const cleaned = cleanLine(raw).slice(0, maxLen === Infinity ? undefined : maxLen).trim();
    if (cleaned.length < min) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= cap) break;
  }
  return out;
}
