import {
  CARD_TOKEN_DIGITS,
  generateCardToken,
  hashCardToken,
  isCardToken,
  normalizeDeskInput,
} from './card-token';

describe('card token', () => {
  it('is 48 decimal digits — at least 128 bits of entropy', () => {
    const t = generateCardToken();
    expect(t).toMatch(/^\d{48}$/);
    expect(CARD_TOKEN_DIGITS * Math.log2(10)).toBeGreaterThanOrEqual(128);
    expect(isCardToken(t)).toBe(true);
  });

  it('never repeats across many draws and uses every digit', () => {
    const seen = new Set<string>();
    const digits = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const t = generateCardToken();
      seen.add(t);
      for (const d of t) digits.add(d);
    }
    expect(seen.size).toBe(2000);
    expect(digits.size).toBe(10);
  });

  it('is stored only as a 64-hex SHA-256 digest, never the token', () => {
    const t = generateCardToken();
    const h = hashCardToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(t);
    expect(hashCardToken(t)).toBe(h);
    expect(hashCardToken(generateCardToken())).not.toBe(h);
  });

  it('reads what a scanner or an Arabic keyboard typed', () => {
    const t = generateCardToken();
    const arabic = [...t].map((d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]).join('');
    expect(normalizeDeskInput(arabic)).toBe(t);
    expect(normalizeDeskInput(` ${t.slice(0, 20)}-${t.slice(20)}\n`)).toBe(t);
    expect(isCardToken(normalizeDeskInput('١٢٣٤٥٦'))).toBe(false);
  });

  it('a student code, a phone or a URL is not a card', () => {
    expect(isCardToken('123456')).toBe(false);
    expect(isCardToken('01012345678')).toBe(false);
    expect(isCardToken(`https://x/${generateCardToken()}`)).toBe(false);
    expect(isCardToken(generateCardToken() + '0')).toBe(false);
  });
});
