import { applyFragment, looksNumeric, mergeRegion, normalise, reconcile } from './reconcile';
import { PageTranscript, TranscriptRegion, UNCLEAR } from './transcript.schema';

const region = (over: Partial<TranscriptRegion> = {}): TranscriptRegion => ({
  label: '1',
  text: 'بلغ معاشه ١٢٨ جنيهًا في السنة السادسة',
  confidence: 0.8,
  uncertain: [],
  math: [],
  ...over,
});

/**
 * Choosing between two readings of the same pixels.
 *
 * The rule the whole file exists to enforce: **visual evidence outranks
 * sense.** When one pass reads 128 and another reads 1280, the tempting
 * resolution is the one where the arithmetic works — and that is exactly the
 * resolution that silently changes a student's exam paper. Sense breaks a tie
 * between equally-evidenced readings; it never overturns a better look.
 */
describe('deciding which reading to believe', () => {
  it('takes the closer look over the distant one', () => {
    // A crop of one question at the same image budget is several times the
    // resolution of the whole page, so it is better evidence by construction.
    const out = reconcile([
      { text: '١٢٨٠', confidence: 0.9, evidence: 'page' },
      { text: '١٢٨', confidence: 0.75, evidence: 'region' },
    ]);
    expect(out.text).toBe('١٢٨');
  });

  it('takes a focused crop over a region crop', () => {
    const out = reconcile([
      { text: '13.6', confidence: 0.8, evidence: 'region' },
      { text: '1.36', confidence: 0.7, evidence: 'focus' },
    ]);
    expect(out.text).toBe('1.36');
  });

  it('treats agreement across passes as stronger than either pass alone', () => {
    const agreed = reconcile([
      { text: 'القاهرة', confidence: 0.7, evidence: 'page' },
      { text: 'القاهرة', confidence: 0.7, evidence: 'region' },
    ]);
    const alone = reconcile([{ text: 'القاهرة', confidence: 0.7, evidence: 'region' }]);
    expect(agreed.confidence).toBeGreaterThan(alone.confidence);
  });

  it('counts two spellings of the same Arabic word as agreement', () => {
    const out = reconcile([
      { text: 'الطّاقة', confidence: 0.7, evidence: 'page' },
      { text: 'الطاقه', confidence: 0.7, evidence: 'region' },
    ]);
    expect(out.confidence).toBeGreaterThan(0.7);
    expect(out.unresolved).toBe(false);
  });

  it('refuses to pick between two numbers when nothing settles it', () => {
    // The whole point. Picking one here is picking at random and calling it a
    // reading; the teacher is shown [UNCLEAR] and decides for themselves.
    const out = reconcile([
      { text: '128', confidence: 0.6, evidence: 'page' },
      { text: '120', confidence: 0.62, evidence: 'page' },
    ]);
    expect(out.unresolved).toBe(true);
  });

  it('does settle a numeric disagreement when one pass saw it far better', () => {
    const out = reconcile([
      { text: '128', confidence: 0.55, evidence: 'page' },
      { text: '120', confidence: 0.85, evidence: 'focus' },
    ]);
    expect(out.unresolved).toBe(false);
    expect(out.text).toBe('120');
  });

  it('does not treat disagreeing words as a numeric standoff', () => {
    const out = reconcile([
      { text: 'القاهرة', confidence: 0.6, evidence: 'page' },
      { text: 'الإسكندرية', confidence: 0.62, evidence: 'page' },
    ]);
    expect(out.unresolved).toBe(false);
  });

  it('says nothing rather than something when there is nothing', () => {
    const out = reconcile([{ text: '  ', confidence: 0.9, evidence: 'focus' }]);
    expect(out.text).toBe('');
    expect(out.unresolved).toBe(true);
  });

  it('knows a number from a word, in either script', () => {
    expect(looksNumeric('١٢٨')).toBe(true);
    expect(looksNumeric('13.6')).toBe(true);
    expect(looksNumeric('81%')).toBe(true);
    expect(looksNumeric('٣/٤')).toBe(true);
    expect(looksNumeric('القاهرة')).toBe(false);
    expect(looksNumeric('')).toBe(false);
  });

  it('folds spelling and spacing but never the digits', () => {
    expect(normalise('الطّاقة')).toBe(normalise('الطاقه'));
    expect(normalise('a  b')).toBe('a b');
    // Two different numbers must stay two different numbers.
    expect(normalise('١٢٨')).not.toBe(normalise('١٢٨٠'));
  });
});

describe('folding a re-read back into the page', () => {
  const transcript = (): PageTranscript => ({
    language: 'ar',
    confidence: 0.6,
    blank: false,
    regions: [region({ label: '1', confidence: 0.95 }), region({ label: '2', confidence: 0.4 })],
  });

  it('replaces only the region that was looked at again', () => {
    const before = transcript();
    const after = mergeRegion(before, 1, region({ label: '2', text: 'fixed', confidence: 0.92 }));
    expect(after.regions[0]).toBe(before.regions[0]);
    expect(after.regions[1].text).toBe('fixed');
  });

  it('rates the page by its worst region, which is the one being retyped', () => {
    const after = mergeRegion(
      transcript(),
      1,
      region({ label: '2', text: 'fixed', confidence: 0.92 }),
    );
    expect(after.confidence).toBe(0.92);
  });

  it('puts a settled number back into the sentence it came out of', () => {
    const r = region({
      text: 'بلغ معاشه ١٢٨٠ جنيهًا',
      uncertain: [{ text: '١٢٨٠', confidence: 0.4, reason: 'faded', numeric: true }],
    });
    const out = applyFragment(r, r.uncertain[0], {
      text: '١٢٨',
      confidence: 0.93,
      unresolved: false,
      considered: [],
    });
    expect(out.text).toBe('بلغ معاشه ١٢٨ جنيهًا');
    expect(out.uncertain).toHaveLength(0);
  });

  it('marks a number nobody could settle instead of choosing one', () => {
    const r = region({
      text: 'بلغ معاشه ١٢٨ جنيهًا',
      uncertain: [{ text: '١٢٨', confidence: 0.4, reason: 'faded', numeric: true }],
    });
    const out = applyFragment(r, r.uncertain[0], {
      text: '١٢٠',
      confidence: 0.45,
      unresolved: true,
      considered: [],
    });
    expect(out.text).toContain(UNCLEAR);
    expect(out.uncertain).toHaveLength(1);
    expect(out.confidence).toBeLessThan(r.confidence);
  });
});
