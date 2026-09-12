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

  /** A student's prepaid wallet — a platform liability held for the student. */
  private walletAccount(studentId: string) {
    return `student:${studentId}:wallet`;
  }

  /**
   * A student's spendable wallet balance: credits − debits on their wallet
   * account. Derived from the ledger, never stored, so it can never drift.
   */
  async walletBalance(studentId: string, db: Db = this.prisma): Promise<number> {
    const account = this.walletAccount(studentId);
    const [credits, debits] = await Promise.all([
      db.ledgerEntry.aggregate({ where: { account, direction: 'CREDIT' }, _sum: { amountCents: true } }),
      db.ledgerEntry.aggregate({ where: { account, direction: 'DEBIT' }, _sum: { amountCents: true } }),
    ]);
    return (credits._sum.amountCents ?? 0) - (debits._sum.amountCents ?? 0);
  }

  /**
   * Add funds to a student's wallet: real cash entered the platform, and the
   * platform now owes it to the student. DEBIT platform:cash (asset up),
   * CREDIT student:<id>:wallet (liability up). Returns the ledger transaction id
   * so the caller can stamp its WalletTransaction mirror row. Pass the tx client
   * to book it atomically with the top-up status flip.
   */
  async creditWallet(
    studentId: string,
    amountCents: number,
    description: string,
    db: Db = this.prisma,
  ): Promise<string> {
    if (amountCents <= 0) throw new Error('creditWallet: amount must be positive');
    const txn = await db.ledgerTransaction.create({
      data: {
        description,
        entries: {
          create: [
            { account: 'platform:cash', direction: 'DEBIT', amountCents },
            { account: this.walletAccount(studentId), direction: 'CREDIT', amountCents },
          ],
        },
      },
    });
    return txn.id;
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

    // Additive-fee model: amountCents (paid) = platform fee + academy net. The
    // fee/net are frozen on the Payment at submit time; fall back to the legacy
    // commission split for old rows that predate the fee columns.
    let fee = payment.feeCents ?? null;
    let net = payment.netCents ?? null;
    if (fee == null || net == null) {
      const teacher = await db.teacherProfile.findUnique({
        where: { id: payment.tenantId },
        select: { commissionPercent: true },
      });
      const commissionPct = teacher?.commissionPercent ?? 20;
      fee = Math.round((payment.amountCents * commissionPct) / 100);
      net = payment.amountCents - fee;
    }

    // Where the money comes FROM depends on how it was paid. A transfer brings
    // new cash into the platform; a wallet payment does not — that cash arrived
    // when the wallet was topped up and has been sitting as a liability ever
    // since. Debiting platform:cash again for a wallet purchase would invent
    // money that was already counted once.
    const fromWallet = payment.method === 'WALLET';
    if (fromWallet) {
      // Checked here, inside the settlement transaction, so a balance spent by a
      // concurrent purchase fails this one rather than overdrawing the wallet.
      const balance = await this.walletBalance(payment.studentId, db);
      if (balance < payment.amountCents) {
        throw new Error(`insufficient wallet balance for payment ${paymentId}`);
      }
    }

    const txn = await db.ledgerTransaction.create({
      data: {
        description: `enrollment payment ${paymentId}`,
        paymentId,
        entries: {
          create: [
            fromWallet
              // The student's prepaid balance pays for it: the liability drops.
              ? { account: this.walletAccount(payment.studentId), direction: 'DEBIT', amountCents: payment.amountCents }
              // platform:cash holds the full amount the student paid.
              : { account: 'platform:cash', direction: 'DEBIT', amountCents: payment.amountCents },
            // platform earnings (the service fee) — account name kept for continuity.
            { account: 'platform:commission', direction: 'CREDIT', amountCents: fee, tenantId: payment.tenantId },
            // the academy's withdrawable earning.
            { account: this.teacherAccount(payment.tenantId), direction: 'CREDIT', amountCents: net, tenantId: payment.tenantId },
          ],
        },
      },
    });

    // The readable half of the same fact, so the purchase shows up in the
    // student's own wallet history next to the top-up that funded it.
    if (fromWallet) {
      await db.walletTransaction.create({
        data: {
          studentId: payment.studentId,
          kind: 'PURCHASE',
          amountCents: -payment.amountCents,
          description: 'شراء دورة',
          courseId: payment.courseId,
          paymentId,
          ledgerTxnId: txn.id,
        },
      });
    }
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
  /**
   * What the academy has earned — and nothing else.
   *
   * This used to return gross and the platform's commission alongside it, and the
   * wallet spread all three onto the screen. The fee is additive: the academy is
   * credited the price it set, in full, so gross and commission are the
   * platform's side of the transaction and are none of the academy's business.
   * Platform-wide figures live in platformTotals(), for the admin.
   */
  async teacherEarnings(tenantId: string) {
    const net = await this.prisma.ledgerEntry.aggregate({
      where: { account: this.teacherAccount(tenantId), direction: 'CREDIT' },
      _sum: { amountCents: true },
    });
    return { netCents: net._sum.amountCents ?? 0 };
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
