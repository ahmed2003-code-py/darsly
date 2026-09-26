/**
 * The one authoritative price for a Live seat.
 *
 * Pure and integer-only: every amount is piasters, every percentage basis
 * points, and nothing here ever holds a fraction of a piaster. The inputs are
 * server data (the session's price, the academy's terms version, its agreed
 * split) — a browser never supplies any of them.
 *
 * The invariant every result satisfies, and every caller may rely on:
 *
 *     studentPaysCents = feeCents + teacherCents + centerCents
 *
 * so no piaster is created or lost between what a student pays and where it
 * ends up. Rounding is half-up, deterministic, and applied exactly twice: once
 * for a percentage fee, once for the Center/teacher split — and in both cases
 * the other side is the remainder, not a second rounding.
 */

import { LIVE_PRICE_MAX_CENTS } from '@darsly/shared-types';

export type FeeType = 'PERCENT' | 'FIXED';
export type FeeMode = 'ADDITIVE' | 'DEDUCTED';

export interface TermsSnapshot {
  id: string;
  feeType: FeeType;
  /** PERCENT: basis points (100 = 1%). */
  feeBps: number | null;
  /** FIXED: piasters. */
  feeFixedCents: number | null;
  feeMode: FeeMode;
  feeRefundableOnStudentCancel: boolean;
}

/** PERSONAL: everything after the fee is the teacher's. CENTER: split by the agreed percentage. */
export type SplitInput = { kind: 'PERSONAL' } | { kind: 'CENTER'; teacherSharePercent: number };

export interface PriceBreakdown {
  basePriceCents: number;
  discountCents: number;
  feeCents: number;
  studentPaysCents: number;
  /** What the seller side receives after Darsly's fee: teacherCents + centerCents. */
  commercialNetCents: number;
  teacherCents: number;
  centerCents: number;
  feeType: FeeType;
  feeMode: FeeMode;
  feeBps: number | null;
  feeFixedCents: number | null;
  termsVersionId: string;
  /** CENTER only. */
  teacherSharePercent: number | null;
}

/** The ceiling on one seat's price: 1,000,000 EGP. Keeps every product far inside 2^53. */
export const MAX_PRICE_CENTS = LIVE_PRICE_MAX_CENTS;

export class PricingError extends Error {
  constructor(
    readonly code:
      | 'PRICE_INVALID'
      | 'DISCOUNT_INVALID'
      | 'TERMS_INVALID'
      | 'SPLIT_INVALID'
      | 'FEE_EXCEEDS_PRICE',
    message: string,
  ) {
    super(message);
  }
}

const isWhole = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);

/** round(n * num / den), half-up, for non-negative integers — no floats involved. */
export function mulDivRoundHalfUp(n: number, num: number, den: number): number {
  if (!isWhole(n) || !isWhole(num) || !isWhole(den) || n < 0 || num < 0 || den <= 0) {
    throw new RangeError('mulDivRoundHalfUp: non-negative integers only');
  }
  const product = n * num;
  if (!Number.isSafeInteger(product)) throw new RangeError('mulDivRoundHalfUp: overflow');
  return Math.floor((product + Math.floor(den / 2)) / den);
}

function assertTerms(t: TermsSnapshot) {
  if (t.feeType === 'PERCENT') {
    if (!isWhole(t.feeBps) || t.feeBps < 0 || t.feeBps > 10_000 || t.feeFixedCents != null)
      throw new PricingError('TERMS_INVALID', 'A percentage fee needs basis points 0–10000');
    if (t.feeMode === 'DEDUCTED' && t.feeBps >= 10_000)
      throw new PricingError('TERMS_INVALID', 'A deducted fee of 100% leaves the seller nothing');
  } else if (t.feeType === 'FIXED') {
    if (!isWhole(t.feeFixedCents) || t.feeFixedCents < 0 || t.feeBps != null)
      throw new PricingError('TERMS_INVALID', 'A fixed fee needs a non-negative amount');
  } else {
    throw new PricingError('TERMS_INVALID', 'Unknown fee type');
  }
  if (t.feeMode !== 'ADDITIVE' && t.feeMode !== 'DEDUCTED')
    throw new PricingError('TERMS_INVALID', 'Unknown fee mode');
}

/**
 * Price one seat.
 *
 * The discount comes off the seller's price first; the fee is then worked out
 * on what remains (so a coupon shrinks Darsly's percentage with it, exactly as
 * course coupons do today). A discount that takes the price to zero makes the
 * whole seat free of charge: no fee, nothing to split — but the session stays
 * PAID, which is the caller's business, not arithmetic's.
 */
export function priceLiveSeat(input: {
  basePriceCents: number;
  discountCents?: number;
  terms: TermsSnapshot;
  split: SplitInput;
}): PriceBreakdown {
  const { basePriceCents, terms, split } = input;
  const discountCents = input.discountCents ?? 0;
  if (!isWhole(basePriceCents) || basePriceCents <= 0 || basePriceCents > MAX_PRICE_CENTS)
    throw new PricingError('PRICE_INVALID', 'The price must be a whole number of piasters above zero');
  if (!isWhole(discountCents) || discountCents < 0 || discountCents > basePriceCents)
    throw new PricingError('DISCOUNT_INVALID', 'The discount must be between zero and the price');
  assertTerms(terms);
  let teacherSharePercent: number | null = null;
  if (split.kind === 'CENTER') {
    if (!isWhole(split.teacherSharePercent) || split.teacherSharePercent < 0 || split.teacherSharePercent > 100)
      throw new PricingError('SPLIT_INVALID', 'The teacher share must be 0–100%');
    teacherSharePercent = split.teacherSharePercent;
  }

  const base = basePriceCents - discountCents;
  const snapshot = {
    basePriceCents,
    discountCents,
    feeType: terms.feeType,
    feeMode: terms.feeMode,
    feeBps: terms.feeBps,
    feeFixedCents: terms.feeFixedCents,
    termsVersionId: terms.id,
    teacherSharePercent,
  };
  if (base === 0) {
    return {
      ...snapshot,
      feeCents: 0,
      studentPaysCents: 0,
      commercialNetCents: 0,
      teacherCents: 0,
      centerCents: 0,
    };
  }

  const feeCents =
    terms.feeType === 'PERCENT'
      ? mulDivRoundHalfUp(base, terms.feeBps as number, 10_000)
      : (terms.feeFixedCents as number);

  let studentPaysCents: number;
  let commercialNetCents: number;
  if (terms.feeMode === 'ADDITIVE') {
    studentPaysCents = base + feeCents;
    commercialNetCents = base;
  } else {
    // The seller must keep something: a fee that swallows the whole price is
    // a configuration that cannot sell this seat, not a free lunch for Darsly.
    if (feeCents >= base)
      throw new PricingError('FEE_EXCEEDS_PRICE', 'Darsly’s fee would take the whole price');
    studentPaysCents = base;
    commercialNetCents = base - feeCents;
  }

  const teacherCents =
    split.kind === 'CENTER'
      ? mulDivRoundHalfUp(commercialNetCents, split.teacherSharePercent, 100)
      : commercialNetCents;
  const centerCents = commercialNetCents - teacherCents;

  const result: PriceBreakdown = {
    ...snapshot,
    feeCents,
    studentPaysCents,
    commercialNetCents,
    teacherCents,
    centerCents,
  };
  assertBalanced(result);
  return result;
}

/** The invariant, checked on every result — a broken price is a bug, never a sale. */
export function assertBalanced(p: {
  studentPaysCents: number;
  feeCents: number;
  teacherCents: number;
  centerCents: number;
}) {
  const parts = [p.studentPaysCents, p.feeCents, p.teacherCents, p.centerCents];
  if (!parts.every((x) => isWhole(x) && x >= 0))
    throw new PricingError('PRICE_INVALID', 'Negative or fractional amount in a price');
  if (p.studentPaysCents !== p.feeCents + p.teacherCents + p.centerCents)
    throw new PricingError('PRICE_INVALID', 'Price does not balance');
}

export { parseMoneyToCents, formatCents } from '@darsly/shared-types';
