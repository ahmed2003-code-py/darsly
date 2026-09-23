import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Take one use of a coupon, atomically, inside the caller's transaction.
 *
 * For a capped coupon the conditional updateMany (usedCount < maxUses) is the
 * race guard: two concurrent takers can never both pass a maxUses:1 coupon —
 * the DB serialises the increments and the loser matches zero rows. Throws
 * COUPON_LIMIT_REACHED so the caller's whole transaction rolls back.
 *
 * Every route that grants a discount goes through here — bank transfer, card
 * checkout, and a coupon that makes a course free — so a "one use" coupon
 * means one use however it is redeemed.
 */
export async function reserveCouponUse(
  tx: Prisma.TransactionClient,
  couponId: string,
  maxUses: number | null,
): Promise<void> {
  if (maxUses == null) {
    await tx.coupon.update({ where: { id: couponId }, data: { usedCount: { increment: 1 } } });
    return;
  }
  const reserved = await tx.coupon.updateMany({
    where: { id: couponId, usedCount: { lt: maxUses } },
    data: { usedCount: { increment: 1 } },
  });
  if (reserved.count === 0) {
    throw new ConflictException({
      message: 'Coupon usage limit reached',
      code: 'COUPON_LIMIT_REACHED',
    });
  }
}

/** Give a reserved use back (floored at zero) — a payment that failed or was rejected. */
export async function releaseCouponUse(
  tx: Prisma.TransactionClient,
  couponId: string | null,
): Promise<void> {
  if (!couponId) return;
  await tx.coupon.updateMany({
    where: { id: couponId, usedCount: { gt: 0 } },
    data: { usedCount: { decrement: 1 } },
  });
}
