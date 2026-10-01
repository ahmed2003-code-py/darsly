/**
 * Center Operations C4 — money arithmetic.
 *
 * Every amount is an integer number of minor units (piasters for EGP: 500 EGP
 * = 50000), in the academy's currency, and the API only ever accepts and
 * returns integers. Nothing here touches a float on the way to a stored
 * value: a percentage is integer basis points and rounds with integer math.
 */

/** The most one row may carry: 1,000,000.00 in major units. Sums fit a JS number exactly. */
export const MAX_CENTS = 100_000_000;

/**
 * A percentage of an amount, rounded half up to the minor unit, in integers:
 * 10% of 333.33 is 33.33; 12.5% of 0.05 is 0.01. amount ≤ 1e8 and
 * bps ≤ 1e4 keep the product under 2^53.
 */
export function percentOf(amountCents: number, bps: number): number {
  if (!Number.isSafeInteger(amountCents) || !Number.isSafeInteger(bps))
    throw new Error('integers only');
  return Math.floor((amountCents * bps + 5_000) / 10_000);
}

/**
 * Split an amount across what is owed, oldest first: each charge takes up to
 * what it still owes. Returns the allocations and what is left over (> 0
 * means the amount is more than everything owed).
 */
export function allocateOldestFirst(
  amountCents: number,
  open: { chargeId: string; outstandingCents: number }[],
): { allocations: { chargeId: string; amountCents: number }[]; leftoverCents: number } {
  let left = amountCents;
  const allocations: { chargeId: string; amountCents: number }[] = [];
  for (const c of open) {
    if (left <= 0) break;
    if (c.outstandingCents <= 0) continue;
    const take = Math.min(left, c.outstandingCents);
    allocations.push({ chargeId: c.chargeId, amountCents: take });
    left -= take;
  }
  return { allocations, leftoverCents: left };
}

export type ChargeStatus = 'VOID' | 'PAID' | 'OVERDUE' | 'PARTIALLY_PAID' | 'DUE' | 'UPCOMING';

/**
 * A charge's state, derived (never stored): from what it owes, what was paid,
 * its due date and the academy's local today (the server's clock — a phone
 * with the wrong date changes nothing).
 */
export function chargeStatus(
  b: {
    netCents: number;
    paidCents: number;
    outstandingCents: number;
    voided: boolean;
    dueOn: string;
  },
  today: string,
): ChargeStatus {
  if (b.voided) return 'VOID';
  if (b.outstandingCents <= 0) return 'PAID';
  if (b.dueOn < today) return 'OVERDUE';
  if (b.paidCents > 0) return 'PARTIALLY_PAID';
  if (b.dueOn === today) return 'DUE';
  return 'UPCOMING';
}
