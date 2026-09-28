import { chunkSource, foldArabic, SourceChunk, SourcePage } from './source-text';

/**
 * An exam written from a Live class: its transcript, uploaded material, or
 * both. Everything here is deterministic and free: which words of a spoken
 * class are teaching, how the two sources are laid side by side, which parts
 * of them deserve more of the exam, and where each question came from.
 */

/** How the transcript is named wherever a source is shown. */
export const TRANSCRIPT_FILE = 'نص الحصة';

/**
 * Talk that runs a class rather than teaches it: greetings, "can you hear
 * me", the camera, the chat, attendance, "one minute". Matched on folded
 * text (foldArabic, lower case).
 */
const CLASSROOM_TALK = [
  /السلام عليكم|وعليكم السلام|صباح الخير|مساء الخير|صباح النور|مساء النور|ازيكم|اخباركم|عاملين ايه|اهلا (بيكم|وسهلا)|اهلين/,
  /سامع(ني|يني|ينّي|ين)|سامعين|صوتي|الصوت (واضح|مقطع|واصل|وحش|عالي|واطي)|صوت(ك|كم) (واضح|مقطع)|مش سامع/,
  /الشاشه|شاشتي|شايفين|الكاميرا|الكاميره|المايك|مايك|ميوت|\bmute\b|\bunmute\b|النت |الانترنت|الشبكه|اللينك|الرابط|الشات|\bchat\b|\bzoom\b/,
  /الحضور|الغياب|مين (موجود|معانا)|حد معايا|استن(وا|ي|ا) (شويه|ثانيه|دقيقه)|ثانيه واحده|دقيقه واحده|هنبدا (كمان|بعد)|يلا نبدا|نبدا بقي|بريك|استراحه|\bbreak\b/,
];
/** A sentence this long is teaching even if it mentions the screen. */
const CLASSROOM_TALK_MAX_WORDS = 12;

/**
 * The teaching in a stretch of a spoken class, with the housekeeping around
 * it removed. Conservative on purpose: only a short sentence that is plainly
 * about running the class goes — "افتحوا الكتاب صفحة ١٢ عشان نشوف قانون نيوتن"
 * stays, "سامعيني؟ الصوت واضح؟" does not. Nothing is reworded or summarised.
 */
export function dropClassroomTalk(text: string): string {
  const teaching = (s: string) => {
    const t = s.trim();
    if (!t) return false;
    if (t.split(/\s+/).length > CLASSROOM_TALK_MAX_WORDS) return true;
    const folded = foldArabic(t).toLowerCase();
    return !CLASSROOM_TALK.some((re) => re.test(folded));
  };
  // Line by line (a line is a statement the planner counts), sentence by sentence.
  return (text ?? '')
    .split(/\n+/)
    .map((line) =>
      line
        .split(/(?<=[.!?؟…])\s+/)
        .filter(teaching)
        .join(' ')
        .replace(/[ \t]+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .join('\n');
}

/** The class's words, in the order spoken, as chunks that say they are the transcript. */
export function transcriptChunks(segments: { text: string }[]): SourceChunk[] {
  const pages: SourcePage[] = segments
    .map((s) => dropClassroomTalk(s.text ?? ''))
    .map((text, i) => ({ file: TRANSCRIPT_FILE, page: i + 1, text }))
    .filter((p) => p.text);
  return chunkSource(pages).map((c) => ({ ...c, sourceKind: 'LIVE_TRANSCRIPT' as const }));
}

/**
 * The uploaded material and the transcript, laid side by side: each placed
 * by how far through its own source it is, so the slides' opening and the
 * class's opening sit together, and a batch of questions sees both accounts
 * of the same stretch of the lesson. Indexes run 0… over the result.
 */
export function mergeSources(documents: SourceChunk[], transcript: SourceChunk[]): SourceChunk[] {
  const at = (i: number, n: number) => (n <= 1 ? 0 : i / (n - 1));
  const all = [
    ...documents.map((c, i) => ({ c: { ...c, sourceKind: c.sourceKind ?? ('DOCUMENT' as const) }, pos: at(i, documents.length), tie: 0 })),
    ...transcript.map((c, i) => ({ c: { ...c, sourceKind: 'LIVE_TRANSCRIPT' as const }, pos: at(i, transcript.length), tie: 1 })),
  ];
  all.sort((a, b) => a.pos - b.pos || a.tie - b.tie);
  return all.map((x, index) => ({ ...x.c, index }));
}

/** Content words for matching across the two sources: folded, and without the article. */
function terms(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of foldArabic(text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    const w = raw.replace(/^(وال|بال|فال|كال|لل|ال)(?=\p{L}{3})/u, '');
    if (w.length >= 4) out.add(w);
  }
  return out;
}

/** Content terms a chunk shares with the other source to count as fully covered by both. */
const SHARED_TERMS_FOR_FULL_WEIGHT = 5;

const kindsOf = (chunks: SourceChunk[]) => new Set(chunks.map((c) => c.sourceKind ?? 'DOCUMENT'));

/**
 * How much of the exam each chunk deserves, beyond what it can carry.
 *
 * With one source, every chunk counts the same — nothing changes. With both,
 * a chunk whose content the other source also covers (the slide the teacher
 * actually explained; the explanation of something on a slide) weighs up to
 * four times one the other never touches (2 against 0.5): what a teacher
 * both wrote and said is what the lesson is about, and a long slide nobody
 * explained must not take the exam over. Capacity still caps every chunk.
 */
export function sourceEmphasis(chunks: SourceChunk[]): number[] {
  if (kindsOf(chunks).size < 2) return chunks.map(() => 1);
  const vocab = new Map<string, Set<string>>();
  const t = chunks.map((c) => terms(c.text));
  chunks.forEach((c, i) => {
    const k = c.sourceKind ?? 'DOCUMENT';
    if (!vocab.has(k)) vocab.set(k, new Set());
    for (const w of t[i]) vocab.get(k)!.add(w);
  });
  return chunks.map((c, i) => {
    const other = [...vocab.entries()].filter(([k]) => k !== (c.sourceKind ?? 'DOCUMENT')).map(([, v]) => v);
    if (!t[i].size || !other.length) return 1;
    // Counted, not a share: colloquial speech and a slide share a handful of
    // terms («الـ overfitting», "validation loss") amid very different wording.
    let shared = 0;
    for (const w of t[i]) if (other.some((v) => v.has(w))) shared++;
    return 0.5 + 1.5 * Math.min(1, shared / SHARED_TERMS_FOR_FULL_WEIGHT);
  });
}

export type QuestionSourceKind = 'LIVE_TRANSCRIPT' | 'UPLOADED_DOCUMENT' | 'BOTH';

export interface QuestionProvenance {
  kind: QuestionSourceKind;
  /** Where a teacher checks it: the chunk it was written from, and the other source's closest match when it has one. */
  evidence: { sourceKind: 'LIVE_TRANSCRIPT' | 'UPLOADED_DOCUMENT'; sourceId: string; chunk: number; file: string; page: number | null }[];
}

/**
 * Where a question came from — for the teacher's review only.
 *
 * Its own chunk (recorded when it was written) decides the source; it counts
 * as "from both" when the other source has a chunk carrying most of its
 * content words too. Word overlap, not meaning: a question the teacher
 * explained in different words than the slide shows as one source, which is
 * the honest mistake to make.
 */
export function questionProvenance(
  q: { text: string; modelAnswer?: string | null; options?: { text: string }[] | null; sourceChunk?: number | null },
  chunks: SourceChunk[],
  ids: { liveSessionId: string | null },
): QuestionProvenance | null {
  const own = chunks.find((c) => c.index === q.sourceChunk);
  if (!own) return null;
  const kindOf = (c: SourceChunk) => (c.sourceKind === 'LIVE_TRANSCRIPT' ? 'LIVE_TRANSCRIPT' : 'UPLOADED_DOCUMENT') as 'LIVE_TRANSCRIPT' | 'UPLOADED_DOCUMENT';
  const cite = (c: SourceChunk) => ({
    sourceKind: kindOf(c),
    sourceId: kindOf(c) === 'LIVE_TRANSCRIPT' ? (ids.liveSessionId ?? '') : c.sourceFile,
    chunk: c.index,
    file: c.sourceFile,
    page: c.page,
  });
  const evidence = [cite(own)];
  if (kindsOf(chunks).size < 2) return { kind: kindOf(own), evidence };
  const asked = terms([q.text, q.modelAnswer ?? '', ...(q.options ?? []).map((o) => o.text)].join(' '));
  let best: { c: SourceChunk; shared: number } | null = null;
  for (const c of chunks) {
    if (kindOf(c) === kindOf(own)) continue;
    const words = terms(c.text);
    let shared = 0;
    for (const w of asked) if (words.has(w)) shared++;
    if (!best || shared > best.shared) best = { c, shared };
  }
  const both = !!best && best.shared >= 3 && best.shared / Math.max(1, asked.size) >= 0.4;
  if (both) evidence.push(cite(best!.c));
  return { kind: both ? 'BOTH' : kindOf(own), evidence };
}
