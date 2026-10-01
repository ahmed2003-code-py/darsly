import { centsToDecimal, formatMoney, parseMoney } from './centerFees';

/** What a receptionist types becomes exact minor units — or nothing. */
describe('center fees — money input and display', () => {
  it('reads amounts as typed, exactly', () => {
    expect(parseMoney('500')).toBe(50_000);
    expect(parseMoney('500.5')).toBe(50_050);
    expect(parseMoney('500.50')).toBe(50_050);
    expect(parseMoney('0.01')).toBe(1);
    expect(parseMoney('0.10')).toBe(10);
    expect(parseMoney('99.99')).toBe(9_999);
    expect(parseMoney('1,500.25')).toBe(150_025);
    expect(parseMoney(' 200 ')).toBe(20_000);
    expect(parseMoney('1000000')).toBe(100_000_000);
  });

  it('reads Arabic-Indic digits and the Arabic decimal sign', () => {
    expect(parseMoney('٥٠٠')).toBe(50_000);
    expect(parseMoney('٢٠٠٫٧٥')).toBe(20_075);
    expect(parseMoney('۳۰۰')).toBe(30_000);
  });

  it('refuses what is not money: never rounds silently', () => {
    for (const bad of [
      '',
      '0',
      '0.00',
      '-5',
      'abc',
      '1.234',
      '1e3',
      '5.',
      '.5',
      '1..2',
      'NaN',
      '٥٠٠ج',
    ])
      expect(parseMoney(bad)).toBeNull();
  });

  it('shows two decimals and the currency', () => {
    expect(centsToDecimal(50_000)).toBe('500.00');
    expect(centsToDecimal(1)).toBe('0.01');
    expect(centsToDecimal(-2_550)).toBe('-25.50');
    expect(formatMoney(50_000, 'EGP', 'en')).toMatch(/500\.00/);
    expect(formatMoney(50_000, 'EGP', 'en')).toMatch(/EGP|E£/);
    expect(formatMoney(123_456_789, 'EGP', 'ar')).toMatch(/1,234,567\.89|1٬234٬567٫89/);
  });
});
