import {
  chunkSource,
  estimateTokens,
  foldArabic,
  normalizePageText,
  selectChunksForBatch,
  selectChunksForQuestion,
  stripRunningLines,
  SourcePage,
} from './source-text';

const page = (n: number, text: string, file = 'biology.pdf'): SourcePage => ({
  file,
  page: n,
  text,
});

/**
 * The free half of the content path.
 *
 * Everything here runs before a token is spent, and the more it does the less
 * the model is asked to do. A running footer left in is fifty copies of the
 * same sentence in the material questions get written from; a lecture sent
 * whole is the most expensive way to write an exam there is.
 */
describe('cleaning a page of lecture material', () => {
  it('rejoins a word a line break split with a hyphen', () => {
    expect(normalizePageText('photosyn-\nthesis is the process')).toBe(
      'photosynthesis is the process',
    );
  });

  it('drops a line that is only a page number', () => {
    expect(normalizePageText('Real content here\n12\nMore content')).toBe(
      'Real content here\nMore content',
    );
    expect(normalizePageText('Content\nPage 4 of 12\nMore')).toBe('Content\nMore');
    expect(normalizePageText('محتوى\nصفحة 4\nتاني')).toBe('محتوى\nتاني');
  });

  it('strips the bidirectional marks poppler leaves on every Arabic line', () => {
    const marked = '‫التمثيل الضوئي‬\n‫عملية حيوية‬';
    expect(normalizePageText(marked)).toBe('التمثيل الضوئي\nعملية حيوية');
  });

  it('leaves a number that is part of a sentence alone', () => {
    expect(normalizePageText('The atomic number of carbon is 6')).toContain('6');
  });

  it('collapses runs of whitespace without joining paragraphs', () => {
    expect(normalizePageText('a   b\n\n\n\nc')).toBe('a b\n\nc');
  });
});

describe('removing the header that is on every page', () => {
  const pages = Array.from({ length: 10 }, (_, i) =>
    page(i + 1, `Faculty of Science — Biology 101\nReal content for page ${i + 1} goes here.`),
  );

  it('removes a line that repeats across most of the upload', () => {
    const cleaned = stripRunningLines(pages);
    expect(cleaned.every((p) => !p.text.includes('Faculty of Science'))).toBe(true);
    expect(cleaned[3].text).toContain('page 4');
  });

  it('leaves a short upload alone, where a repeat is as likely to be content', () => {
    const three = pages.slice(0, 3);
    expect(stripRunningLines(three)[0].text).toContain('Faculty of Science');
  });

  it('never removes a long line, however often it repeats', () => {
    const long =
      'This is a genuinely long sentence of real teaching material that happens to be repeated on several pages of the lecture because it matters.';
    const repeated = Array.from({ length: 10 }, (_, i) =>
      page(i + 1, `${long}\nPage ${i + 1} content.`),
    );
    expect(stripRunningLines(repeated)[0].text).toContain('genuinely long sentence');
  });
});

describe('splitting material into chunks that know where they came from', () => {
  const body = (n: number) =>
    Array.from(
      { length: n },
      (_, i) =>
        `Paragraph ${i} about photosynthesis and the way plants convert light energy into chemical energy stored in glucose molecules.`,
    ).join('\n\n');

  it('carries the file and page onto every chunk', () => {
    const chunks = chunkSource([page(8, body(6)), page(9, body(6), 'chemistry.pdf')]);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.sourceFile && c.page)).toBe(true);
    expect(chunks.some((c) => c.sourceFile === 'chemistry.pdf' && c.page === 9)).toBe(true);
  });

  it('never mixes two pages into one chunk, so a source reference stays true', () => {
    const chunks = chunkSource([page(1, body(2)), page(2, body(2))]);
    const pages = new Set(chunks.map((c) => `${c.sourceFile}#${c.page}`));
    expect(pages.size).toBe(2);
  });

  it('keeps chunks near the target size', () => {
    const chunks = chunkSource([page(1, body(40))], { targetTokens: 300, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.tokensApprox).toBeLessThan(600);
  });

  it('skips a page with nothing on it — a cover, a blank, a scan artefact', () => {
    expect(chunkSource([page(1, 'ص'), page(2, body(4))]).every((c) => c.page === 2)).toBe(true);
  });

  it('numbers chunks in reading order across the whole upload', () => {
    const chunks = chunkSource([page(1, body(4)), page(2, body(4))]);
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it('handles Arabic material the same way', () => {
    const arabic = Array.from(
      { length: 8 },
      (_, i) =>
        `الفقرة ${i} تشرح عملية التمثيل الضوئي وكيف تحول النباتات طاقة الضوء إلى طاقة كيميائية مخزنة في جزيئات الجلوكوز داخل الخلية.`,
    ).join('\n\n');
    const chunks = chunkSource([page(3, arabic)], { targetTokens: 200 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].text).toContain('التمثيل الضوئي');
  });
});

describe('choosing which part of the lecture a batch asks about', () => {
  const chunks = chunkSource(
    [
      page(
        1,
        Array.from(
          { length: 30 },
          (_, i) =>
            `Topic ${i} paragraph with enough words in it to be a real chunk of teaching material about subject number ${i}.`,
        ).join('\n\n'),
      ),
    ],
    { targetTokens: 150, overlapTokens: 0 },
  );

  it('covers the whole lecture rather than asking about its first page four times', () => {
    const seen = new Set<number>();
    for (let b = 0; b < 4; b++) {
      for (const c of selectChunksForBatch(chunks, b, 4, 100_000)) seen.add(c.index);
    }
    // Every chunk reachable by some batch.
    expect(seen.size).toBeGreaterThanOrEqual(chunks.length - 1);
  });

  it('gives different batches different material', () => {
    const first = selectChunksForBatch(chunks, 0, 4, 100_000).map((c) => c.index);
    const last = selectChunksForBatch(chunks, 3, 4, 100_000).map((c) => c.index);
    expect(first[0]).toBeLessThan(last[0]);
  });

  it('never sends more than the token ceiling allows', () => {
    const picked = selectChunksForBatch(chunks, 0, 1, 400);
    const total = picked.reduce((n, c) => n + c.tokensApprox, 0);
    expect(total).toBeLessThanOrEqual(400 + picked[picked.length - 1].tokensApprox);
  });

  it('always returns something, even for an impossible ceiling', () => {
    expect(selectChunksForBatch(chunks, 0, 4, 1)).toHaveLength(1);
  });

  it('gives a rewrite the chunk its question came from, first', () => {
    const picked = selectChunksForQuestion(chunks, { text: 'anything', chunkIndex: 5 }, 3);
    expect(picked[0].index).toBe(5);
    expect(picked).toHaveLength(3);
  });

  it('falls back to the most similar material when the chunk is unknown', () => {
    const picked = selectChunksForQuestion(
      chunks,
      { text: 'a question about subject number 7 topic paragraph', chunkIndex: null },
      2,
    );
    expect(picked.length).toBe(2);
  });
});

describe('comparing Arabic that is spelled two ways', () => {
  it('folds diacritics, alef forms and ta marbuta', () => {
    expect(foldArabic('الطّاقة')).toBe(foldArabic('الطاقه'));
    expect(foldArabic('إسلام')).toBe(foldArabic('اسلام'));
  });

  it('estimates tokens close enough to batch with', () => {
    expect(estimateTokens('a'.repeat(320))).toBe(100);
    expect(estimateTokens('')).toBe(0);
  });
});
