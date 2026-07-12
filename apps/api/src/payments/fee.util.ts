import { FeeType } from '@prisma/client';

/**
 * The platform service fee the STUDENT pays ON TOP of the academy's price — never
 * a deduction from the academy. All amounts are integer piasters.
 *
 *   student pays (total) = netCents (academy earning) + feeCents (this)
 */
export function computeServiceFee(
  feeType: FeeType,
  feeValue: number,
  netCents: number,
): number {
  if (netCents <= 0) return 0; // free enrolments carry no fee
  if (feeType === 'FIXED') return Math.max(0, Math.round(feeValue));
  return Math.round((netCents * feeValue) / 100);
}
