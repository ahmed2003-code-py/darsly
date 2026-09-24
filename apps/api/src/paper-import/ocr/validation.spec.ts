import {
  assessChunk,
  grounding,
  numbering,
  questionMarkers,
  readableChars,
  unclearRatio,
} from './validation';

/**
 * The evidence escalation runs on, instead of a model's opinion of itself.
 *
 * On the benchmark pages the reading model's self-reported confidence was
 * 0.10–0.20 for text it genuinely could not read and 0.45–0.74 for exam
 * questions it invented. None of these checks ask it.
 */
describe('judging a crop from what was read', () => {
  it('calls a crop with ink but almost no reading a crop problem, not a reader problem', () => {
    const a = assessChunk({ text: '', lines: 3, expectedCharsPerLine: 40 });
    expect(a.verdict).toBe('BAD_CROP');
    expect(a.reasons[0]).toMatch(/EMPTY_WITH_INK/);
  });

  it('calls a reading far shorter than the ink it came from a crop problem', () => {
    const a = assessChunk({ text: 'بلغ معاشه', lines: 4, expectedCharsPerLine: 40 });
    expect(a.verdict).toBe('BAD_CROP');
    expect(a.reasons[0]).toMatch(/TOO_SHORT_FOR_INK/);
  });

  it('calls a mostly-[UNCLEAR] reading ambiguous', () => {
    const a = assessChunk({
      text: '[UNCLEAR] [UNCLEAR] معاش [UNCLEAR] سنة',
      lines: 1,
      expectedCharsPerLine: 10,
    });
    expect(a.verdict).toBe('AMBIGUOUS');
    expect(a.reasons[0]).toMatch(/UNCLEAR_RATIO/);
  });

  it('accepts a full, clear reading', () => {
    const a = assessChunk({
      text: 'يزداد معاش موظف كل سنة زيادة سنوية ثابتة\nوقد بلغ معاشه ١٢٨ جنيها في السنة السادسة',
      lines: 2,
      expectedCharsPerLine: 30,
    });
    expect(a.verdict).toBe('CLEAR');
  });

  it('counts readable characters and the unread share without the markers', () => {
    expect(readableChars('[UNCLEAR] ab c')).toBe(3);
    expect(unclearRatio('[UNCLEAR] one two three')).toBeCloseTo(0.25);
    expect(unclearRatio('')).toBe(0);
  });
});

describe('question numbering across a page', () => {
  it('finds the numbers printed at the start of a line, in any of the usual forms', () => {
    const text = [
      '(١) يزداد معاش',
      'في السنة ٦ من خدمته',
      '٢) اوجد',
      '٣- ارتفاع',
      'س٤ سبيكتان',
      '[5] a',
      'Q6 b',
    ].join('\n');
    expect(questionMarkers(text)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('does not take a number inside a sentence for a question', () => {
    expect(questionMarkers('بلغ معاشه ١٢٨ جنيها في السنة السادسة')).toEqual([]);
  });

  it('reports what is missing between the first and last number, and what repeats', () => {
    const r = numbering([1, 2, 4, 5, 5, 7]);
    expect(r.missing).toEqual([3, 6]);
    expect(r.duplicates).toEqual([5]);
    expect(r.numbered).toBe(true);
  });

  it('does not call a page numbered on the strength of one number', () => {
    expect(numbering([4]).numbered).toBe(false);
  });
});

describe('whether a question is on the page at all', () => {
  const notes =
    'سورة الجن عدد آياتها ٢٨ آية سورة مكية\nعند نطق الميم المشددة تغن بمقدار حركتين\nتم صلح الحديبية في السنة السادسة من الهجرة';

  it('scores a question copied from the transcript as grounded', () => {
    expect(grounding('تم صلح الحديبية في السنة السادسة من الهجرة', notes)).toBeGreaterThan(0.9);
  });

  it('scores a question the transcript does not contain as invented', () => {
    // Both were produced from a page of revision notes that says neither.
    expect(grounding('احسب مساحة المثلث', notes)).toBeLessThan(0.2);
    expect(grounding('أكمل العبارات الآتية', notes)).toBeLessThan(0.2);
  });

  it('is not fooled by Arabic-Indic against Western digits', () => {
    expect(grounding('عدد آياتها 28 آية', notes)).toBe(1);
  });
});
