/**
 * Turning uploaded lecture material into something worth sending a model.
 *
 * Every function here is deterministic and free, and that is the point: the
 * cheapest token is the one never sent. A fifty-page lecture handed whole to a
 * model once per batch of questions is both the most expensive way to write an
 * exam and the least likely to cover the material evenly — the model reads the
 * first few pages properly and skims the rest.
 *
 * So the material is cleaned, split into chunks that carry where they came
 * from, and selected from. No embeddings and no vector store: there is neither
 * in this project, a lecture is tens of chunks rather than millions, and word
 * overlap answers "which part of this lecture is about photosynthesis" well
 * enough at that size. A retrieval system would be a larger thing to own than
 * the feature it serves.
 */

export interface SourcePage {
  /** The file a teacher would look for. */
  file: string;
  /** Page within that file, 1-based. */
  page: number;
  text: string;
}

export interface SourceChunk {
  index: number;
  text: string;
  sourceFile: string;
  page: number | null;
  tokensApprox: number;
}

/**
 * Roughly how many tokens a string is.
 *
 * Characters over 3.2, which is near enough for Arabic and English both and
 * is only ever used to decide how much to put in a batch. A real tokeniser
 * would be a dependency bought for a number that is allowed to be wrong by
 * twenty percent.
 */
export function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 3.2);
}

/**
 * Clean one page.
 *
 * Only the artefacts that are reliably artefacts: a word broken across a line
 * by a hyphen, a line that is nothing but a page number, runs of whitespace,
 * the control characters poppler leaves behind. Anything ambiguous is left
 * alone — this is cleanup, not editing, and a cleaner that removes a real line
 * of a lecture costs more than one that leaves a page number in.
 */
export function normalizePageText(raw: string): string {
  return (
    (raw ?? '')
      // Bidirectional marks: invisible, and a token each on every RTL line.
      .replace(/[‎‏‪-‮⁦-⁩­]/g, '')
      .replace(/\r\n?/g, '\n')
      // A word split across a line break by a hyphen is one word.
      .replace(/(\p{L})-\n(\p{L})/gu, '$1$2')
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      // A line that is only a number, or "page 4 of 12", is furniture.
      .filter((line) => !/^[-—–\s]*\d{1,4}[-—–\s]*$/.test(line))
      .filter((line) => !/^(page|صفحة)\s*\d+(\s*(of|من)\s*\d+)?$/i.test(line))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * Remove the lines that are on every page.
 *
 * A running header or footer — the course name, the lecturer, a department —
 * is repeated once per page, and on a fifty-page lecture that is fifty copies
 * of the same sentence in the material questions get written from. Detected by
 * repetition rather than by position, because a header is not always at the
 * top of what OCR returns.
 *
 * The threshold is deliberately high. On a three-page upload, a line appearing
 * on two of them is as likely to be a real repeated definition as a footer.
 */
export function stripRunningLines(pages: SourcePage[], threshold = 0.6): SourcePage[] {
  if (pages.length < 4) return pages;
  const counts = new Map<string, number>();
  for (const page of pages) {
    // Once per page, however many times it appears on that page.
    for (const line of new Set(
      page.text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    )) {
      // Long lines are prose, not furniture, however often they repeat.
      if (line.length > 80) continue;
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
  }
  const running = new Set(
    [...counts.entries()].filter(([, n]) => n / pages.length >= threshold).map(([line]) => line),
  );
  if (!running.size) return pages;
  return pages.map((page) => ({
    ...page,
    text: page.text
      .split('\n')
      .filter((line) => !running.has(line.trim()))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  }));
}

/** Below this a "page" is a scan artefact, a cover or a blank — nothing to
 *  write a question from, and a chunk of it would only dilute the material. */
export const MIN_PAGE_CHARS = 120;

export interface ChunkOptions {
  /** Target size in approximate tokens. Big enough to hold an argument, small
   *  enough that several fit in one generation call beside the instructions. */
  targetTokens?: number;
  /** Carry the tail of the previous chunk, so a definition split across a
   *  boundary is still whole somewhere. */
  overlapTokens?: number;
}

/**
 * Split the material into chunks that know where they came from.
 *
 * Paragraph boundaries first, then sentences, then a hard cut — a chunk that
 * ends mid-sentence is a chunk a question gets written from incorrectly.
 */
export function chunkSource(pages: SourcePage[], opts: ChunkOptions = {}): SourceChunk[] {
  const target = Math.max(120, opts.targetTokens ?? 700);
  const overlap = Math.max(0, Math.min(opts.overlapTokens ?? 80, Math.floor(target / 3)));
  const chunks: SourceChunk[] = [];

  for (const page of pages) {
    const text = page.text.trim();
    if (text.length < MIN_PAGE_CHARS) continue;

    const units = splitUnits(text);
    let buffer: string[] = [];
    let bufferTokens = 0;

    const flush = () => {
      if (!buffer.length) return;
      const body = buffer.join('\n\n').trim();
      if (estimateTokens(body) < 40) {
        // Too small to ask a question about; fold it into the next chunk.
        return;
      }
      chunks.push({
        index: chunks.length,
        text: body,
        sourceFile: page.file,
        page: page.page,
        tokensApprox: estimateTokens(body),
      });
      // Keep the tail as the head of the next chunk.
      const tail: string[] = [];
      let tailTokens = 0;
      for (let i = buffer.length - 1; i >= 0 && tailTokens < overlap; i--) {
        tail.unshift(buffer[i]);
        tailTokens += estimateTokens(buffer[i]);
      }
      buffer = overlap ? tail : [];
      bufferTokens = overlap ? tailTokens : 0;
    };

    for (const unit of units) {
      const tokens = estimateTokens(unit);
      if (bufferTokens + tokens > target && buffer.length) flush();
      buffer.push(unit);
      bufferTokens += tokens;
    }
    // Whatever is left of this page is its own chunk, however small — it is
    // still material, and the next page is a different page.
    if (buffer.length) {
      const body = buffer.join('\n\n').trim();
      if (estimateTokens(body) >= 40) {
        chunks.push({
          index: chunks.length,
          text: body,
          sourceFile: page.file,
          page: page.page,
          tokensApprox: estimateTokens(body),
        });
      }
    }
  }
  return chunks.map((c, i) => ({ ...c, index: i }));
}

/** Paragraphs, falling back to sentences for a wall of text. */
function splitUnits(text: string): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const paragraph of paragraphs) {
    if (estimateTokens(paragraph) <= 400) {
      out.push(paragraph);
      continue;
    }
    // Arabic full stop, question mark and the Arabic comma-as-terminator all
    // end sentences here; so does a newline in OCR output that lost its
    // paragraph breaks.
    const sentences = paragraph
      .split(/(?<=[.!?؟。])\s+|\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    let buffer = '';
    for (const sentence of sentences) {
      if (estimateTokens(buffer + ' ' + sentence) > 400 && buffer) {
        out.push(buffer.trim());
        buffer = '';
      }
      buffer += (buffer ? ' ' : '') + sentence;
    }
    if (buffer.trim()) out.push(buffer.trim());
  }
  return out;
}

/**
 * Which chunks a batch of questions should be written from.
 *
 * Coverage first: batch 1 gets the opening of the material, batch 2 the next
 * stretch, and so on, so a twenty-question exam on a fifty-page lecture asks
 * about the whole lecture rather than about its first chapter four times. The
 * slices overlap by one chunk so a topic straddling a boundary can still be
 * asked about.
 */
export function selectChunksForBatch(
  chunks: SourceChunk[],
  batchIndex: number,
  batchCount: number,
  maxTokens: number,
): SourceChunk[] {
  if (!chunks.length || batchCount < 1) return [];
  const perBatch = Math.max(1, Math.ceil(chunks.length / batchCount));
  const start = Math.max(
    0,
    Math.min(batchIndex * perBatch - (batchIndex ? 1 : 0), chunks.length - 1),
  );
  const slice = chunks.slice(start, start + perBatch + (batchIndex ? 1 : 0));
  const window = slice.length ? slice : chunks;

  const out: SourceChunk[] = [];
  let tokens = 0;
  for (const chunk of window) {
    if (tokens + chunk.tokensApprox > maxTokens && out.length) break;
    out.push(chunk);
    tokens += chunk.tokensApprox;
  }
  return out.length ? out : [window[0]];
}

/**
 * The chunks nearest to a question, for rewriting just that one.
 *
 * Its own chunk first — the one it was written from, which is recorded — and
 * then whichever others share the most distinctive words with it, so a rewrite
 * has the same material to work from without being handed the whole lecture.
 */
export function selectChunksForQuestion(
  chunks: SourceChunk[],
  question: { text: string; chunkIndex?: number | null },
  limit = 3,
): SourceChunk[] {
  if (!chunks.length) return [];
  const own = chunks.find((c) => c.index === question.chunkIndex);
  const wanted = keywords(question.text);
  const scored = chunks
    .filter((c) => c !== own)
    .map((c) => ({ chunk: c, score: overlap(wanted, keywords(c.text)) }))
    .sort((a, b) => b.score - a.score)
    .map((s) => s.chunk);
  return [own, ...scored].filter((c): c is SourceChunk => !!c).slice(0, limit);
}

/** Words worth matching on: long enough to be distinctive, folded so that
 *  Arabic written with and without diacritics compares equal. */
export function keywords(text: string): Set<string> {
  return new Set(
    foldArabic(text ?? '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 4),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / Math.min(a.size, b.size);
}

/**
 * Fold Arabic so that two spellings of the same word compare equal.
 *
 * Diacritics are optional in writing and a model does not use them
 * consistently; alef comes in four forms that mean the same letter; a final
 * ya and alef maqsura are the same sound. Without this, "الطاقة" and "الطّاقة"
 * are different words and a duplicate question is not detected as one.
 */
export function foldArabic(text: string): string {
  return (text ?? '')
    .replace(/[ً-ْٰ]/g, '')
    .replace(/[آأإٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ـ/g, '');
}

/**
 * How many distinct questions this material could honestly carry.
 *
 * A page of a lecture is one page of a lecture however many questions are
 * asked for. Without this the studio took a request for twenty questions from
 * a single page, split it into three batches over the *same* chunk, watched
 * each batch repeat the previous one, threw the repeats away as duplicates,
 * called the shortfall a model failure and escalated all three batches to the
 * flagship — six calls and ten minutes to produce thirteen questions that one
 * call could have produced.
 *
 * So the ceiling is worked out first, deterministically, and the plan is cut
 * to it before anything is generated. Roughly one question per 70 tokens of
 * material with a hard ceiling per chunk: a paragraph supports a question or
 * two, not six, and a model asked for six writes the same one repeatedly.
 */
export const MAX_QUESTIONS_PER_CHUNK = 6;
const TOKENS_PER_QUESTION = 70;

/**
 * How many separate teachable statements a chunk holds, counted by line.
 *
 * Tokens undercount a revision sheet: fifteen one-line facts ("the Treaty of
 * Hudaybiyyah was in 6 AH") are fifteen questions in 230 tokens, and the
 * token rule called that page three. A line counts when it is a sentence —
 * four words or more, fifteen letters or more — so a heading ("المراجعة
 * النهائية") or a stray OCR fragment does not.
 */
export function teachableLines(text: string): number {
  return (text ?? '').split('\n').filter(isStatement).length;
}

function isStatement(raw: string): boolean {
  const line = raw.trim();
  if (!line) return false;
  const words = line.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  const letters = line.replace(/[^\p{L}\p{N}]/gu, '').length;
  return words >= 4 && letters >= 15;
}

/**
 * The chunk with each statement numbered — "L1. …", "L2. …" — the lines
 * `teachableLines` counts, in order, and nothing else changed. So a question
 * can be assigned a statement rather than only a chunk: two calls writing
 * from one revision sheet at the same time otherwise both pick its most
 * prominent facts, and the exam asks the same fact twice.
 */
export function numberStatements(text: string): string {
  let n = 0;
  return (text ?? '')
    .split('\n')
    .map((line) => (isStatement(line) ? `L${++n}. ${line.trim()}` : line))
    .join('\n');
}

/**
 * How many distinct questions one chunk can honestly carry: its length, or
 * the number of separate statements in it when that is more — never less
 * than one. Without text (older callers), length alone.
 */
export function chunkCapacity(
  chunk: Pick<SourceChunk, 'tokensApprox'> & { text?: string },
): number {
  const byTokens = Math.min(
    MAX_QUESTIONS_PER_CHUNK,
    Math.floor(chunk.tokensApprox / TOKENS_PER_QUESTION),
  );
  const byLines = chunk.text ? teachableLines(chunk.text) : 0;
  return Math.max(1, byTokens, byLines);
}

export function supportableQuestions(
  chunks: (Pick<SourceChunk, 'tokensApprox'> & { text?: string })[],
): number {
  if (!chunks.length) return 0;
  return chunks.reduce((n, c) => n + chunkCapacity(c), 0);
}
