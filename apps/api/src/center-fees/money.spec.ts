import { allocateOldestFirst, chargeStatus, MAX_CENTS, percentOf } from './money';

describe('center fees — money arithmetic', () => {
  it('percentages round half up, in integers', () => {
    expect(percentOf(50_000, 1_000)).toBe(5_000); // 10% of 500.00
    expect(percentOf(33_333, 1_000)).toBe(3_333); // 10% of 333.33 = 33.333 → 33.33
    expect(percentOf(5, 1_250)).toBe(1); // 12.5% of 0.05 = 0.00625 → 0.01
    expect(percentOf(4, 1_250)).toBe(1); // 0.005 → 0.01 (half up)
    expect(percentOf(3, 1_250)).toBe(0); // 0.00375 → 0.00
    expect(percentOf(9_999, 10_000)).toBe(9_999); // 100%
    expect(percentOf(MAX_CENTS, 10_000)).toBe(MAX_CENTS);
    expect(() => percentOf(10.5, 100)).toThrow();
  });

  it('no binary float drift: 0.10 + 0.20 is 0.30', () => {
    const { allocations, leftoverCents } = allocateOldestFirst(30, [
      { chargeId: 'a', outstandingCents: 10 },
      { chargeId: 'b', outstandingCents: 20 },
    ]);
    expect(allocations.reduce((s, a) => s + a.amountCents, 0)).toBe(30);
    expect(leftoverCents).toBe(0);
  });

  it('oldest first, partial on the last, leftover reported', () => {
    const open = [
      { chargeId: 'oct', outstandingCents: 30_000 },
      { chargeId: 'book', outstandingCents: 10_000 },
      { chargeId: 'nov', outstandingCents: 30_000 },
    ];
    expect(allocateOldestFirst(40_000, open)).toEqual({
      allocations: [
        { chargeId: 'oct', amountCents: 30_000 },
        { chargeId: 'book', amountCents: 10_000 },
      ],
      leftoverCents: 0,
    });
    expect(allocateOldestFirst(45_000, open).allocations.at(-1)).toEqual({
      chargeId: 'nov',
      amountCents: 5_000,
    });
    expect(allocateOldestFirst(80_000, open).leftoverCents).toBe(10_000);
    expect(allocateOldestFirst(1, [{ chargeId: 'x', outstandingCents: 0 }]).allocations).toEqual(
      [],
    );
  });

  it('property: allocations never exceed the amount or any charge, and reconcile', () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    for (let i = 0; i < 2_000; i++) {
      const open = Array.from({ length: 1 + rnd(6) }, (_, k) => ({
        chargeId: `c${k}`,
        outstandingCents: rnd(3) === 0 ? 0 : 1 + rnd(200_000),
      }));
      const owed = open.reduce((s, c) => s + c.outstandingCents, 0);
      const amount = 1 + rnd(owed + 50_000);
      const { allocations, leftoverCents } = allocateOldestFirst(amount, open);
      const sum = allocations.reduce((s, a) => s + a.amountCents, 0);
      expect(sum + leftoverCents).toBe(amount);
      expect(leftoverCents).toBe(Math.max(0, amount - owed));
      for (const a of allocations) {
        expect(a.amountCents).toBeGreaterThan(0);
        expect(a.amountCents).toBeLessThanOrEqual(
          open.find((c) => c.chargeId === a.chargeId)!.outstandingCents,
        );
      }
    }
  });

  it('status comes from the numbers and the server date', () => {
    const base = {
      netCents: 50_000,
      paidCents: 0,
      outstandingCents: 50_000,
      voided: false,
      dueOn: '2026-10-05',
    };
    expect(chargeStatus(base, '2026-10-01')).toBe('UPCOMING');
    expect(chargeStatus(base, '2026-10-05')).toBe('DUE');
    expect(chargeStatus(base, '2026-10-06')).toBe('OVERDUE');
    expect(
      chargeStatus({ ...base, paidCents: 20_000, outstandingCents: 30_000 }, '2026-10-01'),
    ).toBe('PARTIALLY_PAID');
    expect(
      chargeStatus({ ...base, paidCents: 20_000, outstandingCents: 30_000 }, '2026-10-09'),
    ).toBe('OVERDUE');
    expect(chargeStatus({ ...base, paidCents: 50_000, outstandingCents: 0 }, '2026-12-01')).toBe(
      'PAID',
    );
    expect(chargeStatus({ ...base, voided: true }, '2026-12-01')).toBe('VOID');
  });
});
