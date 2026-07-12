import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Accepts either the base client or an interactive-transaction client, so
 * callers can book the ledger atomically with the payment/enrollment status
 * change (no "PAID but never credited" window).
 */
type Db = PrismaService | Prisma.TransactionClient;

/**
 * Double-entry ledger. Every financial fact is a balanced LedgerTransaction:
 * the sum of DEBIT amounts equals the sum of CREDIT amounts. Entries are
 * immutable; corrections are new transactions. All amounts are integer piasters.
 *
 * Accounts:
 *   platform:cash               — money the platform holds
 *   platform:commission         — platform earnings
 *   teacher:<tenantId>:balance  — a teacher's withdrawable balance
 *
 * A teacher's withdrawable balance = Σ CREDIT − Σ DEBIT on their balance account.
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(private readonly prisma: PrismaService) {}

  private teacherAccount(tenantId: string) {
    return `teacher:${tenantId}:balance`;
  }

  /**
   * Record a paid enrollment: cash in, split into platform commission and the
   * teacher's balance. Idempotent per payment (the LedgerTransaction.paymentId
   * unique constraint is the ultimate guard against double-credit). Pass the
   * transaction client to book it atomically with the status flip.
   * Invoice generation is deliberately NOT done here — see ensureInvoice.
   */
  async recordPayment(paymentId: string, db: Db = this.prisma): Promise<void> {
    const payment = await db.payment.findUnique({
      where: { id: paymentId },
      include: { ledgerTransaction: true },
    });
    if (!payment || payment.status !== 'PAID' || payment.amountCents <= 0) return;
    if (payment.ledgerTransaction) return; // already recorded

    const teacher = await db.teacherProfile.findUnique({
      where: { id: payment.tenantId },
      select: { commissionPercent: true },
    });
    const commissionPct = teacher?.commissionPercent ?? 20;
    const commission = Math.round((payment.amountCents * commissionPct) / 100);
    const teacherShare = payment.amountCents - commission;

    await db.ledgerTransaction.create({
      data: {
        description: `enrollment payment ${paymentId}`,
        paymentId,
        entries: {
          create: [
            { account: 'platform:cash', direction: 'DEBIT', amountCents: payment.amountCents },
            { account: 'platform:commission', direction: 'CREDIT', amountCents: commission, tenantId: payment.tenantId },
            { account: this.teacherAccount(payment.tenantId), direction: 'CREDIT', amountCents: teacherShare, tenantId: payment.tenantId },
          ],
        },
      },
    });
  }

  /** Money leaves the teacher's balance back to platform cash on payout completion. */
  async recordPayout(payoutId: string, db: Db = this.prisma): Promise<void> {
    const payout = await db.payoutRequest.findUnique({
      where: { id: payoutId },
      include: { ledgerTransaction: true },
    });
    if (!payout || payout.ledgerTransaction) return;

    await db.ledgerTransaction.create({
      data: {
        description: `payout ${payoutId}`,
        payoutId,
        entries: {
          create: [
            { account: this.teacherAccount(payout.tenantId), direction: 'DEBIT', amountCents: payout.amountCents, tenantId: payout.tenantId },
            { account: 'platform:cash', direction: 'CREDIT', amountCents: payout.amountCents },
          ],
        },
      },
    });
  }

  /** Withdrawable balance for a teacher (credits − debits on their balance account). */
  async teacherBalance(tenantId: string, db: Db = this.prisma): Promise<number> {
    const account = this.teacherAccount(tenantId);
    const [credits, debits] = await Promise.all([
      db.ledgerEntry.aggregate({ where: { account, direction: 'CREDIT' }, _sum: { amountCents: true } }),
      db.ledgerEntry.aggregate({ where: { account, direction: 'DEBIT' }, _sum: { amountCents: true } }),
    ]);
    return (credits._sum.amountCents ?? 0) - (debits._sum.amountCents ?? 0);
  }

  /** Lifetime gross + commission + net for a teacher (for the wallet header). */
  async teacherEarnings(tenantId: string) {
    const account = this.teacherAccount(tenantId);
    const [net, commission] = await Promise.all([
      this.prisma.ledgerEntry.aggregate({ where: { account, direction: 'CREDIT' }, _sum: { amountCents: true } }),
      this.prisma.ledgerEntry.aggregate({ where: { account: 'platform:commission', tenantId }, _sum: { amountCents: true } }),
    ]);
    const netCents = net._sum.amountCents ?? 0;
    const commissionCents = commission._sum.amountCents ?? 0;
    return { grossCents: netCents + commissionCents, commissionCents, netCents };
  }

  /** Platform-wide totals for the admin financials view. */
  async platformTotals() {
    const [cashIn, commission] = await Promise.all([
      this.prisma.ledgerEntry.aggregate({ where: { account: 'platform:cash', direction: 'DEBIT' }, _sum: { amountCents: true } }),
      this.prisma.ledgerEntry.aggregate({ where: { account: 'platform:commission', direction: 'CREDIT' }, _sum: { amountCents: true } }),
    ]);
    return {
      grossCents: cashIn._sum.amountCents ?? 0,
      commissionCents: commission._sum.amountCents ?? 0,
    };
  }

  /**
   * DRS-INV-YYYY-NNNNNN invoice on first paid record. Idempotent per payment.
   * Deriving the serial from count() can race two concurrent payments onto the
   * same serial, so we retry on a unique-constraint conflict (on either the
   * paymentId or the serial) — safe to run outside the money-critical
   * transaction because a failure here never un-credits a teacher.
   */
  async ensureInvoice(paymentId: string) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const existing = await this.prisma.invoice.findUnique({ where: { paymentId } });
      if (existing) return existing;
      const year = new Date().getFullYear();
      const count = await this.prisma.invoice.count();
      const serial = `DRS-INV-${year}-${String(count + 1 + attempt).padStart(6, '0')}`;
      try {
        return await this.prisma.invoice.create({ data: { paymentId, serial } });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && attempt < 5) {
          continue; // serial or paymentId collided — recompute and retry
        }
        this.logger.error(`ensureInvoice failed for ${paymentId}: ${String(e)}`);
        throw e;
      }
    }
    throw new Error(`ensureInvoice: exhausted serial retries for ${paymentId}`);
  }
}
