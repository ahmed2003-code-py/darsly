import {
  confidenceCalibration,
  editDistance,
  mathIn,
  numbersIn,
  scoreTranscription,
  segmentationAccuracy,
} from './metrics';
import { FIXTURES } from './fixtures';

/**
 * Measuring a transcription.
 *
 * The reason numeric accuracy is scored separately, and the reason these tests
 * exist: a pipeline that gets 96% of the Arabic right and turns ١٢٨ into ١٢٨٠
 * is worse than useless for an exam. The text reads fine, a teacher publishes
 * it, and a class is marked against a number nobody typed. A single blended
 * score hides exactly that, so the score that would hide it is tested for
 * refusing to.
 */
describe('scoring a transcription against what the page says', () => {
  const reference = 'بلغ معاشه ١٢٨ جنيهًا في السنة السادسة';

  it('gives a perfect reading full marks', () => {
    const r = scoreTranscription(reference, reference);
    expect(r.characterAccuracy).toBe(1);
    expect(r.wordAccuracy).toBe(1);
    expect(r.numericAccuracy).toBe(1);
  });

  it('forgives an Arabic spelling variant, which is typography not reading', () => {
    const r = scoreTranscription('الطاقة الحركية', 'الطاقه الحركيه');
    expect(r.characterAccuracy).toBe(1);
  });

  it('does NOT forgive a changed digit, however plausible', () => {
    // The whole point of the file.
    const r = scoreTranscription(reference, 'بلغ معاشه ١٢٨٠ جنيهًا في السنة السادسة');
    expect(r.numericAccuracy).toBe(0);
    // And the words still score nearly perfect, which is the trap: a blended
    // score would call this a 97% success.
    expect(r.wordAccuracy).toBeGreaterThan(0.8);
  });

  it('names the number that changed and what it became', () => {
    const r = scoreTranscription(reference, 'بلغ معاشه ١٢٨٠ جنيهًا في السنة السادسة');
    expect(r.numericErrors).toEqual([{ expected: '١٢٨', got: '١٢٨٠' }]);
  });

  it('says so when a number vanished entirely', () => {
    const r = scoreTranscription(reference, 'بلغ معاشه جنيهًا في السنة السادسة');
    expect(r.numericErrors[0]).toEqual({ expected: '١٢٨', got: null });
  });

  it('counts a decimal as one number, in either script', () => {
    expect(numbersIn('وزنه ١٣٫٦ جرامًا')).toContain('١٣٫٦');
    expect(numbersIn('13.6 grams and 81%')).toEqual(['13.6', '81']);
  });

  it('never treats an Arabic-Indic digit as its Western twin', () => {
    // Converting between them is a change to the page, not a reading of it.
    const r = scoreTranscription('العدد ١٢٨', 'العدد 128');
    expect(r.numericAccuracy).toBe(0);
  });

  it('scores whether the mathematics survived as mathematics', () => {
    const ref = 'Find √7 / (2 - √7) to 4 decimal places.';
    expect(mathIn(ref).length).toBeGreaterThan(0);
    expect(scoreTranscription(ref, ref).mathAccuracy).toBe(1);
    // Turned into prose: the words are close, the mathematics is gone.
    const prose = scoreTranscription(ref, 'Find the square root of seven over two minus it.');
    expect(prose.mathAccuracy).toBeLessThan(1);
  });

  it('scores a page that lost half its questions as half-segmented', () => {
    expect(segmentationAccuracy(7, 7)).toBe(1);
    expect(segmentationAccuracy(7, 4)).toBeCloseTo(4 / 7, 1);
    expect(segmentationAccuracy(7, 0)).toBe(0);
  });

  it('notices when confidence has nothing to do with being right', () => {
    // A pipeline whose confidence is noise is worse than one with none,
    // because every threshold built on it is then noise too.
    const honest = confidenceCalibration([
      { confidence: 0.95, accuracy: 0.98 },
      { confidence: 0.8, accuracy: 0.85 },
      { confidence: 0.4, accuracy: 0.45 },
      { confidence: 0.2, accuracy: 0.2 },
    ]);
    const noise = confidenceCalibration([
      { confidence: 0.95, accuracy: 0.2 },
      { confidence: 0.2, accuracy: 0.95 },
      { confidence: 0.9, accuracy: 0.3 },
      { confidence: 0.3, accuracy: 0.9 },
    ]);
    expect(honest).toBeGreaterThan(0.9);
    expect(noise).toBeLessThan(0);
  });

  it('measures edits without building a million-cell matrix', () => {
    expect(editDistance([...'kitten'], [...'sitting'])).toBe(3);
    expect(editDistance([], [...'abc'])).toBe(3);
  });
});

describe('the pages the pipeline is measured against', () => {
  it('covers every kind of page the product actually meets', () => {
    const challenges = new Set(FIXTURES.map((f) => f.challenge));
    for (const needed of [
      'clean-print',
      'handwriting',
      'arabic-numerals',
      'fractions',
      'percentages',
      'low-light',
      'skew',
      'low-resolution',
    ]) {
      expect(challenges).toContain(needed);
    }
  });

  it('knows how many questions each page has, so segmentation can be scored', () => {
    expect(FIXTURES.every((f) => f.regions > 0 && f.reference.trim().length > 10)).toBe(true);
  });

  it('carries numbers on the pages that are about numbers', () => {
    const numeric = FIXTURES.filter((f) =>
      ['arabic-numerals', 'fractions', 'percentages', 'decimals', 'math'].includes(f.challenge),
    );
    expect(numeric.length).toBeGreaterThan(2);
    expect(numeric.every((f) => numbersIn(f.reference).length > 0)).toBe(true);
  });
});
