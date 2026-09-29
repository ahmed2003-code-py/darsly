import {
  formatCents,
  mulDivRoundHalfUp,
  parseMoneyToCents,
  priceLiveSeat,
  PricingError,
  TermsSnapshot,
} from './pricing';

const pct = (bps: number, feeMode: 'ADDITIVE' | 'DEDUCTED' = 'ADDITIVE'): TermsSnapshot => ({
  id: 't1',
  feeType: 'PERCENT',
  feeBps: bps,
  feeFixedCents: null,
  feeMode,
  feeRefundableOnStudentCancel: false,
});
const fixed = (cents: number, feeMode: 'ADDITIVE' | 'DEDUCTED' = 'ADDITIVE'): TermsSnapshot => ({
  id: 't2',
  feeType: 'FIXED',
  feeBps: null,
  feeFixedCents: cents,
  feeMode,
  feeRefundableOnStudentCancel: false,
});
const personal = { kind: 'PERSONAL' as const };
const center = (p: number) => ({ kind: 'CENTER' as const, teacherSharePercent: p });

describe('the Live pricing engine', () => {
  it('ADDITIVE: 100 EGP at 10% — the student pays 110, Darsly 10, the seller 100', () => {
    const p = priceLiveSeat({ basePriceCents: 10_000, terms: pct(1000), split: personal });
    expect(p).toMatchObject({
      studentPaysCents: 11_000,
      feeCents: 1_000,
      commercialNetCents: 10_000,
      teacherCents: 10_000,
      centerCents: 0,
      termsVersionId: 't1',
    });
  });

  it('DEDUCTED: 100 EGP at 10% — the student pays 100, Darsly 10, the seller 90', () => {
    const p = priceLiveSeat({
      basePriceCents: 10_000,
      terms: pct(1000, 'DEDUCTED'),
      split: personal,
    });
    expect(p).toMatchObject({
      studentPaysCents: 10_000,
      feeCents: 1_000,
      commercialNetCents: 9_000,
      teacherCents: 9_000,
    });
  });

  it('takes basis points: 7.5% of 100 EGP is 7.50', () => {
    expect(
      priceLiveSeat({ basePriceCents: 10_000, terms: pct(750), split: personal }).feeCents,
    ).toBe(750);
  });

  it('FIXED fees, both modes', () => {
    expect(
      priceLiveSeat({ basePriceCents: 5_000, terms: fixed(700), split: personal }),
    ).toMatchObject({
      studentPaysCents: 5_700,
      feeCents: 700,
      teacherCents: 5_000,
    });
    expect(
      priceLiveSeat({ basePriceCents: 5_000, terms: fixed(700, 'DEDUCTED'), split: personal }),
    ).toMatchObject({ studentPaysCents: 5_000, feeCents: 700, teacherCents: 4_300 });
  });

  it('refuses a deducted fee that would take the whole price', () => {
    const run = (base: number, t: TermsSnapshot) => () =>
      priceLiveSeat({ basePriceCents: base, terms: t, split: personal });
    expect(run(700, fixed(700, 'DEDUCTED'))).toThrow(PricingError);
    expect(run(500, fixed(700, 'DEDUCTED'))).toThrow(/whole price/);
    expect(run(1_000, pct(10_000, 'DEDUCTED'))).toThrow(PricingError);
    // One piaster left for the seller is a valid (if odd) configuration.
    expect(
      priceLiveSeat({ basePriceCents: 701, terms: fixed(700, 'DEDUCTED'), split: personal })
        .teacherCents,
    ).toBe(1);
  });

  it('splits a Center sale after the fee, the teacher by the agreed share and the Center the rest', () => {
    const p = priceLiveSeat({ basePriceCents: 10_000, terms: pct(1000), split: center(60) });
    expect(p).toMatchObject({
      studentPaysCents: 11_000,
      feeCents: 1_000,
      teacherCents: 6_000,
      centerCents: 4_000,
      teacherSharePercent: 60,
    });
    const d = priceLiveSeat({
      basePriceCents: 10_000,
      terms: pct(1000, 'DEDUCTED'),
      split: center(60),
    });
    expect(d).toMatchObject({
      studentPaysCents: 10_000,
      feeCents: 1_000,
      teacherCents: 5_400,
      centerCents: 3_600,
    });
  });

  it('rounds half-up exactly once per step, the other side taking the remainder', () => {
    // 3.33 EGP at 12.5% = 41.625 piasters → 42.
    expect(priceLiveSeat({ basePriceCents: 333, terms: pct(1250), split: personal }).feeCents).toBe(
      42,
    );
    // 0.5 piaster of fee → 1 (half-up); 0.49 → 0.
    expect(priceLiveSeat({ basePriceCents: 50, terms: pct(100), split: personal }).feeCents).toBe(
      1,
    );
    expect(priceLiveSeat({ basePriceCents: 49, terms: pct(100), split: personal }).feeCents).toBe(
      0,
    );
    // A 33% share of 1 piaster: the teacher 0, the Center 1 — never 1 + 1.
    const tiny = priceLiveSeat({ basePriceCents: 1, terms: pct(0), split: center(33) });
    expect(tiny.teacherCents + tiny.centerCents).toBe(1);
    // An odd net split 50/50: 10001 → 5001 + 5000.
    const odd = priceLiveSeat({ basePriceCents: 10_001, terms: pct(0), split: center(50) });
    expect([odd.teacherCents, odd.centerCents]).toEqual([5_001, 5_000]);
  });

  it('never creates or loses a piaster, across thousands of awkward combinations', () => {
    const bases = [
      1, 2, 3, 7, 49, 50, 99, 101, 333, 999, 1_001, 14_950, 99_999, 1_234_567, 100_000_000,
    ];
    const bpsList = [0, 1, 33, 50, 99, 250, 333, 750, 999, 1_250, 2_000, 3_333, 9_999, 10_000];
    const shares = [0, 1, 33, 50, 67, 99, 100];
    let checked = 0;
    for (const base of bases)
      for (const bps of bpsList)
        for (const mode of ['ADDITIVE', 'DEDUCTED'] as const)
          for (const share of [null, ...shares]) {
            let p;
            try {
              p = priceLiveSeat({
                basePriceCents: base,
                terms: pct(bps, mode),
                split: share == null ? personal : center(share),
              });
            } catch (e) {
              expect(e).toBeInstanceOf(PricingError);
              continue;
            }
            checked++;
            expect(p.studentPaysCents).toBe(p.feeCents + p.teacherCents + p.centerCents);
            expect(p.commercialNetCents).toBe(p.teacherCents + p.centerCents);
            for (const v of [p.feeCents, p.teacherCents, p.centerCents]) {
              expect(Number.isSafeInteger(v)).toBe(true);
              expect(v).toBeGreaterThanOrEqual(0);
            }
            if (mode === 'ADDITIVE') expect(p.studentPaysCents).toBe(base + p.feeCents);
            else expect(p.studentPaysCents).toBe(base);
          }
    expect(checked).toBeGreaterThan(2_500);
  });

  it('applies a discount before the fee; a 100% discount is a seat that costs nothing', () => {
    const p = priceLiveSeat({
      basePriceCents: 10_000,
      discountCents: 2_500,
      terms: pct(1000),
      split: personal,
    });
    expect(p).toMatchObject({
      discountCents: 2_500,
      feeCents: 750,
      studentPaysCents: 8_250,
      teacherCents: 7_500,
    });
    const free = priceLiveSeat({
      basePriceCents: 10_000,
      discountCents: 10_000,
      terms: fixed(500),
      split: personal,
    });
    expect(free).toMatchObject({
      studentPaysCents: 0,
      feeCents: 0,
      teacherCents: 0,
      centerCents: 0,
    });
  });

  it('refuses nonsense inputs rather than pricing them', () => {
    const t = pct(1000);
    for (const base of [0, -100, 1.5, NaN, 100_000_001]) {
      expect(() => priceLiveSeat({ basePriceCents: base, terms: t, split: personal })).toThrow(
        PricingError,
      );
    }
    expect(() =>
      priceLiveSeat({ basePriceCents: 100, discountCents: 101, terms: t, split: personal }),
    ).toThrow(/discount/);
    expect(() =>
      priceLiveSeat({ basePriceCents: 100, terms: pct(10_001), split: personal }),
    ).toThrow(PricingError);
    expect(() =>
      priceLiveSeat({
        basePriceCents: 100,
        terms: { ...pct(100), feeFixedCents: 5 },
        split: personal,
      }),
    ).toThrow(PricingError);
    expect(() => priceLiveSeat({ basePriceCents: 100, terms: t, split: center(101) })).toThrow(
      PricingError,
    );
  });

  it('rounds with integers only', () => {
    expect(mulDivRoundHalfUp(333, 1250, 10_000)).toBe(42);
    expect(mulDivRoundHalfUp(1, 1, 2)).toBe(1);
    expect(() => mulDivRoundHalfUp(1.5, 1, 2)).toThrow(RangeError);
  });
});

describe('money input', () => {
  it('reads plain EGP amounts into piasters', () => {
    expect(parseMoneyToCents('50')).toBe(5_000);
    expect(parseMoneyToCents('75')).toBe(7_500);
    expect(parseMoneyToCents('149.50')).toBe(14_950);
    expect(parseMoneyToCents('149.5')).toBe(14_950);
    expect(parseMoneyToCents(' 100 ')).toBe(10_000);
    expect(parseMoneyToCents('٧٥')).toBe(7_500);
    expect(parseMoneyToCents('١٤٩٫٥')).toBe(14_950);
    // 0.1 + 0.2 territory: exact, because no float is ever formed.
    expect(parseMoneyToCents('0.29')).toBe(29);
    expect(parseMoneyToCents('1.01')).toBe(101);
  });

  it('refuses anything that is not a plain amount', () => {
    for (const bad of [
      '',
      '-5',
      '1.005',
      '1e3',
      '1,000',
      '12.',
      '.5',
      'abc',
      '10 EGP',
      '9999999999',
      '+5',
    ]) {
      expect(parseMoneyToCents(bad)).toBeNull();
    }
    expect(parseMoneyToCents(null)).toBeNull();
    expect(parseMoneyToCents({})).toBeNull();
  });

  it('formats piasters back without floats', () => {
    expect(formatCents(14_950)).toBe('149.50');
    expect(formatCents(15_000)).toBe('150');
    expect(formatCents(5)).toBe('0.05');
  });
});
