import { PrismaService } from '../../prisma/prisma.service';

/**
 * What an academy (or one teacher inside it) is owed from Live seats and not
 * yet paid out: the frozen shares of purchases whose class has not been
 * released, less anything refunded. Derived from the purchases every time and
 * never stored — the AVAILABLE balance stays the ledger's alone.
 *
 * A plain function (not a service method) so the wallet in the payments
 * module can read it without depending on the Live module.
 */
export async function livePendingEarnings(
  prisma: PrismaService,
  where: { academyId: string; tenantId?: string },
  side: 'teacher' | 'center',
): Promise<{ pendingCents: number; pendingSeats: number }> {
  const rows = await prisma.livePurchase.findMany({
    where: {
      academyId: where.academyId,
      ...(where.tenantId ? { tenantId: where.tenantId } : {}),
      releasedAt: null,
      status: { in: ['CONFIRMED', 'NEEDS_REVIEW', 'CANCELLED_BY_STUDENT'] },
      payment: { status: 'PAID' },
    },
    select: {
      teacherCents: true,
      centerCents: true,
      refunds: {
        where: { status: { not: 'REJECTED' } },
        select: { teacherRefundCents: true, centerRefundCents: true },
      },
    },
  });
  let pendingCents = 0;
  let pendingSeats = 0;
  for (const p of rows) {
    const refunded = p.refunds.reduce(
      (a, r) => a + (side === 'teacher' ? r.teacherRefundCents : r.centerRefundCents),
      0,
    );
    const left = (side === 'teacher' ? p.teacherCents : p.centerCents) - refunded;
    if (left > 0) {
      pendingCents += left;
      pendingSeats++;
    }
  }
  return { pendingCents, pendingSeats };
}
