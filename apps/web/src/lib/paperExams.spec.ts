import { formatMarks, formatPct, parseMarks } from './paperExams';

describe('paper exam marks', () => {
  it('reads marks exactly into hundredths, Arabic digits and decimal sign included', () => {
    expect(parseMarks('30')).toBe(3000);
    expect(parseMarks('26.5')).toBe(2650);
    expect(parseMarks('26.25')).toBe(2625);
    expect(parseMarks('٢٦٫٥')).toBe(2650);
    expect(parseMarks('۲۶.۵')).toBe(2650);
    expect(parseMarks(' 7 ')).toBe(700);
    expect(parseMarks('26,5')).toBe(2650);
  });

  it('0 is a real score, not an empty one', () => {
    expect(parseMarks('0')).toBe(0);
    expect(parseMarks('٠')).toBe(0);
    expect(parseMarks('0.00')).toBe(0);
  });

  it('refuses anything that is not a mark — never rounds', () => {
    for (const bad of [
      '',
      ' ',
      '26.255',
      '-1',
      '+5',
      '1e3',
      'NaN',
      'Infinity',
      '26abc',
      '.5',
      '5.',
      '1000.01',
      '١٠٠٠٠',
      'غ',
    ])
      expect(parseMarks(bad)).toBeNull();
    expect(parseMarks('1000')).toBe(100_000);
  });

  it('writes marks back without trailing zeros or float noise', () => {
    expect(formatMarks(3000)).toBe('30');
    expect(formatMarks(2650)).toBe('26.5');
    expect(formatMarks(2625)).toBe('26.25');
    expect(formatMarks(5)).toBe('0.05');
    expect(formatMarks(0)).toBe('0');
    for (let h = 0; h <= 3000; h += 7) expect(parseMarks(formatMarks(h))).toBe(h);
    expect(formatPct(8833)).toBe('88.33%');
    expect(formatPct(0)).toBe('0.00%');
    expect(formatPct(10000)).toBe('100.00%');
  });
});
