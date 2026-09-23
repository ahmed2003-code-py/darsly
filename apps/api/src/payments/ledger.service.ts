import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { computeSplit } from './revenue-split';

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
 *   platform:cash                     — money the platform holds (real transfers)
 *   platform:cash-in-kind             — cash a receiver collected in person and
 *                                        immediately self-settled as their own
 *                                        earning (Phase 7; a balancing entry,
 *                                        not a liability — see recordPayment)
 *   platform:commission               — platform earnings
 *   teacher:<tenantId>:balance        — a teacher's withdrawable balance
 *   academy:<academyId>:balance       — a Center's withdrawable balance (Phase 7)
 *   teacher:<tenantId>:cash-liability — cash a teacher personally collected
 *                                        that is NOT theirs yet (Phase 7)
 *   academy:<academyId>:cash-liability — same, for a Center's desk (Phase 7)
 *
 * A :balance account is CREDIT-only in practice (never debited by a sale) —
 * it is what its holder actually earned and may withdraw. A :cash-liability
 * account is DEBIT-only in practice (nothing credits it back yet — there is
 * no remittance/settle-up flow) — a negative balance there is the expected,
 * standing record of what its holder still owes for cash it is physically
 * holding on someone else's behalf. The two are never the same account, so a
 * payout can never draw on money that belongs to the platform or another party.
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(private readonly prisma: PrismaService) {}

  private teacherAccount(tenantId: string) {
    return `teacher:${tenantId}:balance`;
  }

  /** The organisation's own balance account — a Center has its own; a PERSONAL workspace is the teacher's. */
  orgAccount(academy: { id: string; kind: 'PERSONAL' | 'CENTER' }) {
    return academy.kind === 'CENTER'
      ? `academy:${academy.id}:balance`
      : this.teacherAccount(academy.id);
  }

  /**
   * Phase 7 cash accounting. `:balance` is a payout-eligible earnings
   * account — it must only ever be CREDITED (what a party actually earned),
   * never debited to represent cash sitting in someone's pocket. Physically
   * holding cash that is not entirely one's own is a SEPARATE fact — a
   * liability, "money still to remit" — and lives on its own account, so it
   * can never be netted into, or mistaken for, withdrawable earnings.
   *
   * This account is debited only the RECEIVER'S NON-OWN portion of a cash
   * collection (the platform's fee, plus any other party's share) — never
   * the receiver's own share, and never the gross amount collected (see
   * recordPayment's two-leg cash entries). It is never auto-credited: there
   * is no remittance/settle-up flow yet (a later phase), so the obligation
   * persists exactly as booked — it does not shrink just because the
   * receiver later makes an unrelated online sale.
   */
  private cashLiabilityAccount(
    receiver: 'TEACHER' | 'CENTER',
    tenantId: string,
    academyId: string,
  ) {
    return receiver === 'CENTER'
      ? `academy:${academyId}:cash-liability`
      : `teacher:${tenantId}:cash-liability`;
  }

  /** How much of the cash a receiver collected is still unremitted (platform fee + any other party's share). Always ≥ 0. */
  async cashOwedCents(account: string, db: Db = this.prisma): Promise<number> {
    const balance = await this.balanceOf(account, db);
    return balance < 0 ? -balance : 0;
  }

  /** Convenience wrappers over cashOwedCents for the two receiver shapes. */
  teacherCashOwed(tenantId: string, db: Db = this.prisma): Promise<number> {
    return this.cashOwedCents(`teacher:${tenantId}:cash-liability`, db);
  }
  orgCashOwed(academyId: string, db: Db = this.prisma): Promise<number> {
    return this.cashOwedCents(`academy:${academyId}:cash-liability`, db);
  }

  private async balanceOf(account: string, db: Db): Promise<number> {
    const [credits, debits] = await Promise.all([
      db.ledgerEntry.aggregate({
        where: { account, direction: 'CREDIT' },
        _sum: { amountCents: true },
      }),
      db.ledgerEntry.aggregate({
        where: { account, direction: 'DEBIT' },
        _sum: { amountCents: true },
      }),
    ]);
    return (credits._sum.amountCents ?? 0) - (debits._sum.amountCents ?? 0);
  }

  /** Withdrawable balance of an organisation (credits − debits on its own account). */
  orgBalance(
    academy: { id: string; kind: 'PERSONAL' | 'CENTER' },
    db: Db = this.prisma,
  ): Promise<number> {
    return this.balanceOf(this.orgAccount(academy), db);
  }

  /** Lifetime earnings credited to an organisation's own account. */
  async orgEarnings(academy: { id: string; kind: 'PERSONAL' | 'CENTER' }) {
    const net = await this.prisma.ledgerEntry.aggregate({
      where: { account: this.orgAccount(academy), direction: 'CREDIT' },
      _sum: { amountCents: true },
    });
    return { netCents: net._sum.amountCents ?? 0 };
  }

  /** A student's prepaid wallet — a platform liability held for the student. */
  private walletAccount(studentId: string) {
    return `student:${studentId}:wallet`;
  }

  /**
   * Where a wallet contribution toward a still-PENDING payment sits, once
   * [reserveWalletPortion] takes it out of the student's spendable balance.
   * Neither an asset nor a liability the platform reports anywhere — just a
   * named holding pen so the same piasters can be released to the payment's
   * real destination (commission + teacher) at settlement, or handed straight
   * back to the student if the payment is rejected instead.
   */
  private paymentEscrowAccount(paymentId: string) {
    return `payment:${paymentId}:wallet-hold`;
  }

  /**
   * A student's spendable wallet balance: credits − debits on their wallet
   * account. Derived from the ledger, never stored, so it can never drift.
   */
  async walletBalance(studentId: string, db: Db = this.prisma): Promise<number> {
    const account = this.walletAccount(studentId);
    const [credits, debits] = await Promise.all([
      db.ledgerEntry.aggregate({
        where: { account, direction: 'CREDIT' },
        _sum: { amountCents: true },
      }),
      db.ledgerEntry.aggregate({
        where: { account, direction: 'DEBIT' },
        _sum: { amountCents: true },
      }),
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
   * Take part of a course's price out of the student's spendable balance the
   * moment they submit a mixed wallet+transfer payment, before any transfer has
   * happened. Without this, the same balance could fund a second concurrent
   * purchase while the first is still PENDING and waiting on a transfer — the
   * wallet would look untouched to both until one of them settled and
   * silently overdrew it.
   *
   * Parked in the payment's own escrow account rather than spent outright:
   * [recordPayment] releases it to commission/teacher on settlement, and
   * [releaseWalletReservation] hands it straight back if the payment is
   * rejected instead. Must run inside the same transaction that creates the
   * PENDING payment row.
   */
  async reserveWalletPortion(
    studentId: string,
    paymentId: string,
    amountCents: number,
    db: Db,
  ): Promise<void> {
    if (amountCents <= 0) return;
    await db.ledgerTransaction.create({
      data: {
        description: `wallet portion reserved for payment ${paymentId}`,
        entries: {
          create: [
            { account: this.walletAccount(studentId), direction: 'DEBIT', amountCents },
            { account: this.paymentEscrowAccount(paymentId), direction: 'CREDIT', amountCents },
          ],
        },
      },
    });
  }

  /**
   * The reverse of [reserveWalletPortion]: a rejected payment never happened,
   * so the balance it had set aside goes back to being spendable. Must run
   * inside the same transaction that flips the payment to REJECTED.
   */
  async releaseWalletReservation(
    studentId: string,
    paymentId: string,
    amountCents: number,
    db: Db,
  ): Promise<void> {
    if (amountCents <= 0) return;
    await db.ledgerTransaction.create({
      data: {
        description: `wallet portion released — payment ${paymentId} rejected`,
        entries: {
          create: [
            { account: this.paymentEscrowAccount(paymentId), direction: 'DEBIT', amountCents },
            { account: this.walletAccount(studentId), direction: 'CREDIT', amountCents },
          ],
        },
      },
    });
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

    // Where the money comes FROM depends on how it was paid, and a payment can
    // draw on up to two sources at once:
    //  - `method: WALLET` (paidFully): the ENTIRE amount was drawn from the
    //    wallet at settlement time, checked against the live balance right here
    //    (there is no PENDING period for this method — submit and settle happen
    //    in the same request, so nothing needed reserving in advance).
    //  - `walletCents > 0` on any other method (mixedWallet): part of the total
    //    was reserved out of the wallet back at submit time (see
    //    reserveWalletPortion) and is sitting in this payment's escrow account;
    //    settlement releases it from there rather than touching the wallet
    //    again. The rest (amountCents - walletCents) is the transfer that was
    //    actually matched or verified — real new cash, debited from
    //    platform:cash same as an ordinary transfer.
    // Either way, a transfer brings new cash into the platform and a wallet
    // contribution does not — debiting platform:cash for a wallet-funded
    // portion would invent money that was already counted once, when the
    // wallet was topped up.
    // Phase 7: where the net goes. PERSONAL → all to the teacher (unchanged);
    // CENTER → the configured Center/teacher split. Resolved inside the
    // settlement transaction so an unconfigured split rolls the whole flip back.
    const split = await computeSplit(db, payment, net);
    const academyId = split.academyId;
    const isCash = payment.method === 'CASH';

    const paidFully = payment.method === 'WALLET';
    // Defensive, not just decorative: a caller that hands in a hand-built
    // object (a unit test, or a future refactor) rather than a real Prisma row
    // could omit this column entirely, and `amountCents - undefined` is NaN —
    // which then survives every downstream check (`0 < NaN` is false) and
    // quietly books a transaction with no debit side at all.
    const walletCents = payment.walletCents ?? 0;
    const mixedWallet = !paidFully && walletCents > 0;
    if (paidFully) {
      // Checked here, inside the settlement transaction, so a balance spent by a
      // concurrent purchase fails this one rather than overdrawing the wallet.
      //
      // A typed refusal, not a bare Error. This is reached when a concurrent
      // purchase drained the wallet first — which is the system working, and is
      // the same answer the pre-check in payFromWallet already gives. Thrown
      // untyped it reached Nest's default filter as a 500, so a student who
      // simply could not afford a second course was shown "Internal server
      // error", and a payments endpoint reported server failures for a
      // condition that is not one. Seen as `201, 500, 409` in a three-way race.
      const balance = await this.walletBalance(payment.studentId, db);
      if (balance < payment.amountCents) {
        throw new BadRequestException({
          message: 'Wallet balance is not enough',
          code: 'INSUFFICIENT_BALANCE',
          balanceCents: balance,
          requiredCents: payment.amountCents,
        });
      }
    }
    const cashCents = paidFully ? 0 : payment.amountCents - walletCents;

    const debitEntries: Prisma.LedgerEntryCreateWithoutTransactionInput[] = [];
    if (paidFully) {
      debitEntries.push({
        account: this.walletAccount(payment.studentId),
        direction: 'DEBIT',
        amountCents: payment.amountCents,
      });
    } else if (isCash) {
      // Physical cash never reaches the platform: whoever received it holds the
      // whole amount. Debiting platform:cash would invent money the platform
      // never saw. But the whole amount collected is NOT all "owed" — the
      // receiver's OWN share is theirs the moment they hold it; only the rest
      // (the platform's fee, and — when a teacher collects on a Center course,
      // or vice versa — the other party's cut) is a real outstanding
      // obligation. Two legs, so the liability account reflects EXACTLY that
      // remainder, never the gross:
      //  1. the receiver's own share is "self-settled in kind" — a wash against
      //     a platform-wide account, purely to balance the entry, paired with
      //     the ordinary earnings credit below (identical in effect to an
      //     online sale: their :balance is credited only their share).
      //  2. the remainder is debited from the receiver's OWN cash-liability
      //     account (see cashLiabilityAccount) — an auditable, standing "still
      //     owe this" figure that never gets smaller on its own.
      const receiverOwnShare =
        payment.cashReceiver === 'CENTER' ? split.academyCents : split.teacherCents;
      const owedPortion = payment.amountCents - receiverOwnShare;
      if (receiverOwnShare > 0) {
        debitEntries.push({
          account: 'platform:cash-in-kind',
          direction: 'DEBIT',
          amountCents: receiverOwnShare,
          tenantId: payment.tenantId,
          academyId,
        });
      }
      if (owedPortion > 0) {
        const receiver = this.cashLiabilityAccount(
          payment.cashReceiver ?? 'TEACHER',
          payment.tenantId,
          academyId,
        );
        debitEntries.push({
          account: receiver,
          direction: 'DEBIT',
          amountCents: owedPortion,
          tenantId: payment.tenantId,
          academyId,
        });
      }
    } else {
      if (mixedWallet) {
        debitEntries.push({
          account: this.paymentEscrowAccount(paymentId),
          direction: 'DEBIT',
          amountCents: walletCents,
        });
      }
      if (cashCents > 0) {
        debitEntries.push({ account: 'platform:cash', direction: 'DEBIT', amountCents: cashCents });
      }
    }

    const txn = await db.ledgerTransaction.create({
      data: {
        description: `enrollment payment ${paymentId}`,
        paymentId,
        entries: {
          create: [
            ...debitEntries,
            // platform earnings (the service fee) — account name kept for continuity.
            {
              account: 'platform:commission',
              direction: 'CREDIT',
              amountCents: fee,
              tenantId: payment.tenantId,
              academyId,
            },
            // the Center's share of the net (CENTER only).
            ...(split.academyCents > 0
              ? [
                  {
                    account: `academy:${academyId}:balance`,
                    direction: 'CREDIT' as const,
                    amountCents: split.academyCents,
                    tenantId: payment.tenantId,
                    academyId,
                  },
                ]
              : []),
            // the teacher's withdrawable earning (all of the net for PERSONAL).
            ...(split.teacherCents > 0 || split.kind === 'PERSONAL'
              ? [
                  {
                    account: this.teacherAccount(payment.tenantId),
                    direction: 'CREDIT' as const,
                    amountCents: split.teacherCents,
                    tenantId: payment.tenantId,
                    academyId,
                  },
                ]
              : []),
          ],
        },
      },
    });

    // The readable half of the same fact, so the purchase shows up in the
    // student's own wallet history next to the top-up that funded it. Only the
    // portion actually drawn from the wallet counts as wallet activity — a
    // mixed payment's transferred remainder is not.
    const walletPortionSpent = paidFully ? payment.amountCents : mixedWallet ? walletCents : 0;
    if (walletPortionSpent > 0) {
      await db.walletTransaction.create({
        data: {
          studentId: payment.studentId,
          kind: 'PURCHASE',
          amountCents: -walletPortionSpent,
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
    // Phase 7: the payout draws on the organisation's own account (a Center's,
    // or the teacher's for a PERSONAL workspace). academyId was backfilled from
    // tenantId, so a legacy row resolves to the same account it always did.
    const academyId = payout.academyId ?? payout.tenantId;
    if (!academyId)
      throw new BadRequestException({
        message: 'Payout has no organisation',
        code: 'PAYOUT_UNSCOPED',
      });
    const academy = await db.academy.findUnique({
      where: { id: academyId },
      select: { id: true, kind: true },
    });
    const account = academy ? this.orgAccount(academy) : this.teacherAccount(academyId);

    await db.ledgerTransaction.create({
      data: {
        description: `payout ${payoutId}`,
        payoutId,
        entries: {
          create: [
            {
              account,
              direction: 'DEBIT',
              amountCents: payout.amountCents,
              tenantId: payout.tenantId,
              academyId,
            },
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
      db.ledgerEntry.aggregate({
        where: { account, direction: 'CREDIT' },
        _sum: { amountCents: true },
      }),
      db.ledgerEntry.aggregate({
        where: { account, direction: 'DEBIT' },
        _sum: { amountCents: true },
      }),
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
      this.prisma.ledgerEntry.aggregate({
        where: { account: 'platform:cash', direction: 'DEBIT' },
        _sum: { amountCents: true },
      }),
      this.prisma.ledgerEntry.aggregate({
        where: { account: 'platform:commission', direction: 'CREDIT' },
        _sum: { amountCents: true },
      }),
    ]);
    return {
      grossCents: cashIn._sum.amountCents ?? 0,
      commissionCents: commission._sum.amountCents ?? 0,
    };
  }

  /**
   * What each academy has earned, batched for a page of academies at once —
   * never one query per academy. Same account convention as recordPayment:
   * CREDIT on `teacher:<id>:balance` is net revenue, CREDIT on
   * `platform:commission` (scoped by tenantId) is the fee taken from it.
   */
  async academyRevenueBatch(
    academyIds: string[],
  ): Promise<Map<string, { netCents: number; feeCents: number }>> {
    const map = new Map<string, { netCents: number; feeCents: number }>();
    for (const id of academyIds) map.set(id, { netCents: 0, feeCents: 0 });
    if (academyIds.length === 0) return map;

    // Phase 7: keyed by organisation. "Net" is what was credited to the
    // organisation's OWN account — a Center's balance for a Center, the
    // teacher's for a PERSONAL workspace (whose account id == academy id).
    const [netRows, feeRows] = await Promise.all([
      this.prisma.ledgerEntry.groupBy({
        by: ['academyId'],
        where: {
          academyId: { in: academyIds },
          direction: 'CREDIT',
          account: {
            in: academyIds.flatMap((id) => [`teacher:${id}:balance`, `academy:${id}:balance`]),
          },
        },
        _sum: { amountCents: true },
      }),
      this.prisma.ledgerEntry.groupBy({
        by: ['academyId'],
        where: {
          academyId: { in: academyIds },
          direction: 'CREDIT',
          account: 'platform:commission',
        },
        _sum: { amountCents: true },
      }),
    ]);
    for (const r of netRows)
      if (r.academyId) map.get(r.academyId)!.netCents = r._sum.amountCents ?? 0;
    for (const r of feeRows)
      if (r.academyId) map.get(r.academyId)!.feeCents = r._sum.amountCents ?? 0;
    return map;
  }

  /**
   * Daily platform gross + fee for the last N days, zero-filled so a quiet day
   * still draws a point instead of leaving a gap in the trend line.
   */
  async revenueTrend(
    days: number,
  ): Promise<{ date: string; grossCents: number; feeCents: number }[]> {
    const rows = await this.prisma.$queryRaw<{ day: Date; gross: bigint; fee: bigint }[]>`
      WITH days AS (
        SELECT generate_series(
          date_trunc('day', now()) - (${days}::int - 1) * INTERVAL '1 day',
          date_trunc('day', now()),
          INTERVAL '1 day'
        ) AS day
      ), agg AS (
        SELECT
          date_trunc('day', "createdAt") AS day,
          SUM(CASE WHEN account = 'platform:cash' AND direction = 'DEBIT' THEN "amountCents" ELSE 0 END) AS gross,
          SUM(CASE WHEN account = 'platform:commission' AND direction = 'CREDIT' THEN "amountCents" ELSE 0 END) AS fee
        FROM "LedgerEntry"
        WHERE "createdAt" >= date_trunc('day', now()) - (${days}::int - 1) * INTERVAL '1 day'
          AND account IN ('platform:cash', 'platform:commission')
          AND "deletedAt" IS NULL
        GROUP BY day
      )
      SELECT d.day AS day, COALESCE(a.gross, 0) AS gross, COALESCE(a.fee, 0) AS fee
      FROM days d LEFT JOIN agg a ON a.day = d.day
      ORDER BY d.day ASC
    `;
    return rows.map((r) => ({
      date: r.day.toISOString().slice(0, 10),
      grossCents: Number(r.gross),
      feeCents: Number(r.fee),
    }));
  }

  /**
   * An academy's own net-revenue trend — CREDIT activity on its
   * teacher:<tenantId>:balance account, day by day, zero-filled. The
   * per-academy counterpart to revenueTrend (platform-wide gross + fee): an
   * academy sees only what it earns, never gross or the platform's
   * commission — see teacherEarnings() above for why.
   */
  async academyRevenueTrend(
    academy: { id: string; kind: 'PERSONAL' | 'CENTER' },
    days: number,
  ): Promise<{ date: string; netCents: number }[]> {
    const account = this.orgAccount(academy);
    const rows = await this.prisma.$queryRaw<{ day: Date; net: bigint }[]>`
      WITH days AS (
        SELECT generate_series(
          date_trunc('day', now()) - (${days}::int - 1) * INTERVAL '1 day',
          date_trunc('day', now()),
          INTERVAL '1 day'
        ) AS day
      ), agg AS (
        SELECT date_trunc('day', "createdAt") AS day, SUM("amountCents") AS net
        FROM "LedgerEntry"
        WHERE "createdAt" >= date_trunc('day', now()) - (${days}::int - 1) * INTERVAL '1 day'
          AND account = ${account} AND direction = 'CREDIT' AND "deletedAt" IS NULL
        GROUP BY day
      )
      SELECT d.day AS day, COALESCE(a.net, 0) AS net
      FROM days d LEFT JOIN agg a ON a.day = d.day
      ORDER BY d.day ASC
    `;
    return rows.map((r) => ({ date: r.day.toISOString().slice(0, 10), netCents: Number(r.net) }));
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
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002' &&
          attempt < 5
        ) {
          continue; // serial or paymentId collided — recompute and retry
        }
        this.logger.error(`ensureInvoice failed for ${paymentId}: ${String(e)}`);
        throw e;
      }
    }
    throw new Error(`ensureInvoice: exhausted serial retries for ${paymentId}`);
  }
}
