import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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
   * teacher's balance. Idempotent per payment (skips if a transaction exists).
   */
  async recordPayment(paymentId: string): Promise<void> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { ledgerTransaction: true },
    });
    if (!payment || payment.status !== 'PAID' || payment.amountCents <= 0) return;
    if (payment.ledgerTransaction) return; // already recorded

    const teacher = await this.prisma.teacherProfile.findUnique({
      where: { id: payment.tenantId },
      select: { commissionPercent: true },
    });
    const commissionPct = teacher?.commissionPercent ?? 20;
    const commission = Math.round((payment.amountCents * commissionPct) / 100);
    const teacherShare = payment.amountCents - commission;

    await this.prisma.ledgerTransaction.create({
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
    await this.ensureInvoice(paymentId);
  }

  /** Money leaves the teacher's balance back to platform cash on payout completion. */
  async recordPayout(payoutId: string): Promise<void> {
    const payout = await this.prisma.payoutRequest.findUnique({
      where: { id: payoutId },
      include: { ledgerTransaction: true },
    });
    if (!payout || payout.ledgerTransaction) return;

    await this.prisma.ledgerTransaction.create({
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
  async teacherBalance(tenantId: string): Promise<number> {
    const account = this.teacherAccount(tenantId);
    const [credits, debits] = await Promise.all([
      this.prisma.ledgerEntry.aggregate({ where: { account, direction: 'CREDIT' }, _sum: { amountCents: true } }),
      this.prisma.ledgerEntry.aggregate({ where: { account, direction: 'DEBIT' }, _sum: { amountCents: true } }),
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

  /** DRS-INV-YYYY-NNNNNN invoice on first paid record. */
  private async ensureInvoice(paymentId: string) {
    const existing = await this.prisma.invoice.findUnique({ where: { paymentId } });
    if (existing) return existing;
    const year = new Date().getFullYear();
    const count = await this.prisma.invoice.count();
    const serial = `DRS-INV-${year}-${String(count + 1).padStart(6, '0')}`;
    return this.prisma.invoice.create({ data: { paymentId, serial } });
  }
}
