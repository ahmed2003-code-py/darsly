import { PrismaService } from '../prisma/prisma.service';
import { methodsFor } from './payment-matching.service';

/**
 * Where a buyer's money stands, in the words the buyer needs — one answer for
 * every target (a Live seat, a course, a wallet top-up):
 *
 *   AWAITING_TRANSFER — declared; nothing has arrived yet;
 *   PROOF_SENT        — they said they transferred; nothing matched yet;
 *   UNDER_REVIEW      — a transfer of exactly their amount, on their rail,
 *                       arrived after they declared and could not be tied to
 *                       them automatically: a person is checking it. They
 *                       must NOT be told to pay again;
 *   CONFIRMED / REJECTED — decided.
 *
 * Only the existence of such a transfer is said, never whose it is.
 */
export type PaymentStage =
  'NONE' | 'AWAITING_TRANSFER' | 'PROOF_SENT' | 'UNDER_REVIEW' | 'CONFIRMED' | 'REJECTED';

export async function paymentStage(
  prisma: Pick<PrismaService, 'paymentEvent'>,
  row: {
    /** CONFIRMED / REJECTED once decided; null while open. */
    decided: 'CONFIRMED' | 'REJECTED' | null;
    claimedAt: Date | null;
    method: string | null;
    /** What the transfer itself has to carry (after any wallet part). */
    dueCents: number;
    createdAt: Date;
  } | null,
): Promise<PaymentStage> {
  if (!row) return 'NONE';
  if (row.decided) return row.decided;
  if (!row.method || row.method === 'WALLET' || row.method === 'CASH') {
    return row.claimedAt ? 'PROOF_SENT' : 'AWAITING_TRANSFER';
  }
  const seen = await prisma.paymentEvent.count({
    where: {
      status: { in: ['UNMATCHED', 'AMBIGUOUS'] },
      matchedPaymentId: null,
      matchedTopupId: null,
      provider: { in: methodsFor(row.method) as never[] },
      amountCents: row.dueCents,
      occurredAt: { gte: new Date(row.createdAt.getTime() - 30 * 60_000) },
    },
  });
  if (seen > 0) return 'UNDER_REVIEW';
  return row.claimedAt ? 'PROOF_SENT' : 'AWAITING_TRANSFER';
}

/** A Payment row, in the helper's terms. */
export function paymentRow(p: {
  status: string;
  claimedAt: Date | null;
  method: string | null;
  amountCents: number;
  walletCents?: number | null;
  createdAt: Date;
}) {
  return {
    decided:
      p.status === 'PAID' || p.status === 'REFUNDED'
        ? ('CONFIRMED' as const)
        : p.status === 'REJECTED' || p.status === 'FAILED'
          ? ('REJECTED' as const)
          : null,
    claimedAt: p.claimedAt,
    method: p.method,
    dueCents: p.amountCents - (p.walletCents ?? 0),
    createdAt: p.createdAt,
  };
}

/** A WalletTopup row, in the helper's terms. */
export function topupRow(t: {
  status: string;
  claimedAt: Date | null;
  method: string;
  amountCents: number;
  createdAt: Date;
}) {
  return {
    decided:
      t.status === 'APPROVED'
        ? ('CONFIRMED' as const)
        : t.status === 'REJECTED'
          ? ('REJECTED' as const)
          : null,
    claimedAt: t.claimedAt,
    method: t.method,
    dueCents: t.amountCents,
    createdAt: t.createdAt,
  };
}
