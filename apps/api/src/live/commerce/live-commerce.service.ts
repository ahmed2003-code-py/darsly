import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import {
  LivePurchase,
  LivePurchaseStatus,
  LiveRefundPolicy,
  LiveReplayPolicy,
  Prisma,
  RefundReason,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LedgerService } from '../../payments/ledger.service';
import { PaymentTargets } from '../../payments/payment-targets';
import { PaymentMatchingService } from '../../payments/payment-matching.service';
import { normalizePayerReference } from '../../payments/payer-reference';
import { checkProofAgainstClaim } from '../../payments/proof-check';
import { ProofReaderService } from '../../payments/proof-reader.service';
import { ProofStorageService } from '../../storage/proof-storage.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { CommercialTermsService, pricingRefusal, toSnapshot } from '../../commerce/commercial-terms.service';
import { PriceBreakdown, priceLiveSeat, PricingError } from '../../commerce/pricing';
import { LIVE_REFUND_WINDOW_HOURS } from '@darsly/shared-types';
import { livePendingEarnings } from './pending-earnings';

type Tx = Prisma.TransactionClient;

/** A screenshot a phone makes, not a document scan. */
const PROOF_MAX_BYTES = 1_200 * 1024;

/** How long a seat is held while the buyer goes to transfer (server time). */
export function holdMinutes(): number {
  const n = Number(process.env.LIVE_HOLD_MINUTES ?? 30);
  return Number.isFinite(n) ? Math.min(240, Math.max(5, Math.round(n))) : 30;
}

/**
 * The share of its scheduled length a class must actually have run (from the
 * teacher opening the room to its end) to count as delivered. Server-side and
 * configurable; conservative by default. A class that ran less is not paid
 * out by itself — it waits for a person (NEEDS_REVIEW).
 */
export function deliveryMinRatio(): number {
  const n = Number(process.env.LIVE_DELIVERY_MIN_RATIO ?? 0.5);
  return Number.isFinite(n) ? Math.min(1, Math.max(0.1, n)) : 0.5;
}
/** How long after its scheduled end a class nobody started is treated as a no-show. */
export const NO_SHOW_GRACE_MS = 60 * 60_000;

/**
 * Was this class delivered? Only the server's own record answers: it was
 * opened (startedAt), it was ended through endSession (status ENDED with an
 * endedAt — the teacher's end or the end sweep), it was not called off, and
 * it ran for at least the minimum share of its length. A browser pressing
 * "end" after two minutes produces a record that fails the last test.
 */
export function deliveryVerdict(s: {
  status: string;
  startedAt: Date | null;
  endedAt: Date | null;
  cancelledAt: Date | null;
  deletedAt: Date | null;
  durationMin: number;
}): { delivered: true } | { delivered: false; reason: string } {
  if (s.cancelledAt || s.deletedAt) return { delivered: false, reason: 'cancelled' };
  if (s.status !== 'ENDED' || !s.endedAt) return { delivered: false, reason: 'not ended' };
  if (!s.startedAt) return { delivered: false, reason: 'never started' };
  const ranMs = s.endedAt.getTime() - s.startedAt.getTime();
  if (ranMs < deliveryMinRatio() * s.durationMin * 60_000)
    return { delivered: false, reason: `ran ${Math.max(0, Math.round(ranMs / 60_000))} of ${s.durationMin} minutes` };
  return { delivered: true };
}

/** The states that hold a seat while unexpired. */
const HOLDING: LivePurchaseStatus[] = ['HELD', 'PAYMENT_PENDING'];
/** The states the one-active-purchase index covers (see the migration). */
export const ACTIVE: LivePurchaseStatus[] = ['HELD', 'PAYMENT_PENDING', 'CONFIRMED', 'DELIVERED', 'NEEDS_REVIEW'];

/**
 * Every allowed move of a purchase, and nothing else. A transition not listed
 * here is a bug, and is refused rather than written.
 */
const TRANSITIONS: Record<LivePurchaseStatus, LivePurchaseStatus[]> = {
  HELD: ['PAYMENT_PENDING', 'CONFIRMED', 'EXPIRED', 'CANCELLED_BY_STUDENT', 'CANCELLED_BY_TEACHER'],
  PAYMENT_PENDING: ['CONFIRMED', 'PAYMENT_REJECTED', 'OVERSOLD', 'CANCELLED_BY_TEACHER'],
  EXPIRED: ['PAYMENT_PENDING'],
  CONFIRMED: ['DELIVERED', 'CANCELLED_BY_STUDENT', 'CANCELLED_BY_TEACHER', 'NEEDS_REVIEW', 'REFUNDED', 'REFUND_PENDING'],
  NEEDS_REVIEW: ['DELIVERED', 'REFUNDED', 'REFUND_PENDING'],
  REFUND_PENDING: ['REFUNDED'],
  PAYMENT_REJECTED: [],
  CANCELLED_BY_STUDENT: [],
  CANCELLED_BY_TEACHER: [],
  REFUNDED: [],
  OVERSOLD: [],
  DELIVERED: [],
};

export function assertTransition(from: LivePurchaseStatus, to: LivePurchaseStatus) {
  if (!TRANSITIONS[from].includes(to)) {
    throw new ConflictException({
      message: `A purchase cannot go from ${from} to ${to}`,
      code: 'PURCHASE_STATE_CONFLICT',
      from,
      to,
    });
  }
}

/** The session as the commerce paths need it, read under its row lock. */
export interface LockedSession {
  id: string;
  tenantId: string;
  academyId: string | null;
  groupId: string | null;
  title: string;
  status: 'SCHEDULED' | 'LIVE' | 'ENDED';
  startsAt: Date;
  durationMin: number;
  capacity: number | null;
  accessMode: 'FREE' | 'PAID';
  priceCents: number | null;
  currency: string;
  refundPolicy: LiveRefundPolicy;
  replayPolicy: LiveReplayPolicy;
  replayDays: number | null;
  startedAt: Date | null;
  endedAt: Date | null;
  cancelledAt: Date | null;
  deletedAt: Date | null;
}

export const closesAtMs = (s: { startsAt: Date; durationMin: number }) =>
  s.startsAt.getTime() + s.durationMin * 60_000;

/**
 * Take a session's row lock and read it — including a cancelled (soft-deleted)
 * one, which the soft-delete filter would otherwise hide. Every path that
 * gives or takes a seat takes this lock FIRST (then the purchase's, then the
 * payment's), so two of them can never interleave into an oversold class and
 * never deadlock.
 */
export async function lockSession(tx: Tx, sessionId: string): Promise<LockedSession | null> {
  const [s] = await tx.$queryRaw<LockedSession[]>`
    SELECT id, "tenantId", "academyId", "groupId", title, status::text AS status, "startsAt",
           "durationMin", capacity, "accessMode"::text AS "accessMode", "priceCents", currency,
           "refundPolicy"::text AS "refundPolicy", "replayPolicy"::text AS "replayPolicy",
           "replayDays", "startedAt", "endedAt", "cancelledAt", "deletedAt"
    FROM "LiveSession" WHERE id = ${sessionId} FOR UPDATE`;
  return s ?? null;
}

export async function lockPurchase(tx: Tx, purchaseId: string): Promise<LivePurchase | null> {
  await tx.$queryRaw`SELECT id FROM "LivePurchase" WHERE id = ${purchaseId} FOR UPDATE`;
  return tx.livePurchase.findUnique({ where: { id: purchaseId } });
}

/**
 * Seats spoken for right now: confirmed seats (bookings), plus purchases
 * still holding one. Read under the session lock, so the answer cannot change
 * before the caller acts on it.
 */
export async function seatsTaken(
  tx: Tx | PrismaService,
  sessionId: string,
  now: Date,
  excludePurchaseId?: string,
) {
  const [booked, held] = await Promise.all([
    tx.liveBooking.count({ where: { sessionId } }),
    tx.livePurchase.count({
      where: {
        sessionId,
        status: { in: HOLDING },
        holdExpiresAt: { gt: now },
        ...(excludePurchaseId ? { id: { not: excludePurchaseId } } : {}),
      },
    }),
  ]);
  return booked + held;
}

/**
 * Live commerce: buying a seat on a PAID live session.
 *
 * The purchase is the commercial record; the Payment is the cash; the ledger
 * is the money; the LiveBooking is the seat. Only a verified payment (the
 * listener's match, the wallet, or Darsly finance) turns a purchase into a
 * booking — never a submitted proof, never a pending row.
 */
@Injectable()
export class LiveCommerceService implements OnModuleInit {
  private readonly logger = new Logger(LiveCommerceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly terms: CommercialTermsService,
    private readonly targets: PaymentTargets,
    private readonly matching: PaymentMatchingService,
    private readonly notifications: NotificationsService,
    private readonly proofs: ProofStorageService,
    private readonly proofReader: ProofReaderService,
  ) {}

  onModuleInit() {
    this.targets.registerLive({
      verify: (paymentId, verifierId) => this.onPaymentVerified(paymentId, verifierId),
      reject: (paymentId, actorId, reason) => this.onPaymentRejected(paymentId, actorId, reason),
    });
  }

  // ── Pricing ─────────────────────────────────────────────────────────────

  /** Price a seat of this session now, under its academy's current terms. */
  private async price(session: LockedSession, db: Tx | PrismaService, discountCents = 0): Promise<{
    breakdown: PriceBreakdown;
    feeRefundable: boolean;
  }> {
    if (session.accessMode !== 'PAID' || session.priceCents == null) {
      throw new BadRequestException({ message: 'This session is free', code: 'SESSION_IS_FREE' });
    }
    const academyId = session.academyId ?? session.tenantId;
    const terms = await this.terms.effectiveFor(academyId, new Date(), db);
    const split = await this.terms.splitFor(academyId, session.tenantId, db);
    try {
      return {
        breakdown: priceLiveSeat({
          basePriceCents: session.priceCents,
          discountCents,
          terms: toSnapshot(terms),
          split,
        }),
        feeRefundable: terms.feeRefundableOnStudentCancel,
      };
    } catch (e) {
      if (e instanceof PricingError) pricingRefusal(e);
      throw e;
    }
  }

  /**
   * What a buyer sees before buying: the one number they pay, the seats left,
   * the refund and replay rules. Never the split — that is between Darsly and
   * the seller.
   */
  async quote(sessionId: string, studentUserId: string | null) {
    const session = await (async () => {
      const [s] = await this.prisma.$queryRaw<LockedSession[]>`
        SELECT id, "tenantId", "academyId", "groupId", title, status::text AS status, "startsAt",
               "durationMin", capacity, "accessMode"::text AS "accessMode", "priceCents", currency,
               "refundPolicy"::text AS "refundPolicy", "replayPolicy"::text AS "replayPolicy",
               "replayDays", "startedAt", "endedAt", "cancelledAt", "deletedAt"
        FROM "LiveSession" WHERE id = ${sessionId}`;
      return s ?? null;
    })();
    if (!session || session.deletedAt) throw new NotFoundException('Session not found');
    const now = new Date();
    const taken = await seatsTaken(this.prisma, sessionId, now);
    const base = {
      sessionId,
      accessMode: session.accessMode,
      currency: session.currency,
      capacity: session.capacity,
      seatsLeft: session.capacity != null ? Math.max(0, session.capacity - taken) : null,
      refundPolicy: session.refundPolicy,
      refundWindowHours: LIVE_REFUND_WINDOW_HOURS[session.refundPolicy],
      replayPolicy: session.replayPolicy,
      replayDays: session.replayDays,
      closed: session.status === 'ENDED' || now.getTime() >= closesAtMs(session),
    };
    let mine: Awaited<ReturnType<LiveCommerceService['view']>> | null = null;
    if (studentUserId) {
      const student = await this.prisma.studentProfile.findUnique({ where: { userId: studentUserId } });
      const p = student
        ? await this.prisma.livePurchase.findFirst({
            where: { sessionId, studentId: student.id },
            orderBy: { createdAt: 'desc' },
            include: { payment: true, refunds: true },
          })
        : null;
      mine = p ? this.view(p) : null;
    }
    if (session.accessMode !== 'PAID') return { ...base, studentPaysCents: 0, purchase: mine };
    const { breakdown } = await this.price(session, this.prisma);
    return { ...base, studentPaysCents: breakdown.studentPaysCents, purchase: mine };
  }

  // ── Buying ──────────────────────────────────────────────────────────────

  private async studentOf(userId: string) {
    const s = await this.prisma.studentProfile.findUnique({
      where: { userId },
      include: { user: { select: { fullName: true } } },
    });
    if (!s) throw new ForbiddenException({ message: 'Only a student can buy a seat', code: 'NOT_A_STUDENT' });
    return s;
  }

  /** Whether this session can be sold to this buyer at all, right now. */
  private async assertBuyable(tx: Tx, s: LockedSession | null, studentId: string | null, now: Date) {
    if (!s || s.deletedAt || s.cancelledAt) throw new NotFoundException('Session not found');
    if (s.accessMode !== 'PAID')
      throw new BadRequestException({ message: 'This session is free — book it instead', code: 'SESSION_IS_FREE' });
    if (s.status === 'ENDED' || now.getTime() >= closesAtMs(s))
      throw new ConflictException({ message: 'This session has ended', code: 'SESSION_ENDED' });
    // A group's class is sold to that group only. A paid seat on an
    // academy-wide class needs no course enrollment: the seat is the product.
    if (s.groupId && studentId) {
      const member = await tx.groupMembership.findFirst({
        where: { groupId: s.groupId, studentId },
        select: { id: true },
      });
      if (!member)
        throw new ForbiddenException({ message: 'This session is for a group you are not in', code: 'NOT_IN_GROUP' });
    }
  }

  private async assertSeatFree(tx: Tx, s: LockedSession, now: Date, excludePurchaseId?: string) {
    if (s.capacity == null) return;
    if ((await seatsTaken(tx, s.id, now, excludePurchaseId)) >= s.capacity) {
      throw new ConflictException({ message: 'The session is full', code: 'SESSION_FULL' });
    }
  }

  private purchaseData(
    s: LockedSession,
    breakdown: PriceBreakdown,
    feeRefundable: boolean,
    buyer: { studentId: string },
  ) {
    return {
      sessionId: s.id,
      studentId: buyer.studentId,
      academyId: s.academyId ?? s.tenantId,
      tenantId: s.tenantId,
      currency: s.currency,
      basePriceCents: breakdown.basePriceCents,
      discountCents: breakdown.discountCents,
      feeType: breakdown.feeType,
      feeMode: breakdown.feeMode,
      feeBps: breakdown.feeBps,
      feeFixedCents: breakdown.feeFixedCents,
      feeCents: breakdown.feeCents,
      studentPaysCents: breakdown.studentPaysCents,
      teacherCents: breakdown.teacherCents,
      centerCents: breakdown.centerCents,
      teacherSharePercent: breakdown.teacherSharePercent,
      termsVersionId: breakdown.termsVersionId,
      feeRefundableOnStudentCancel: feeRefundable,
      refundPolicy: s.refundPolicy,
      replayPolicy: s.replayPolicy,
      replayDays: s.replayDays,
    };
  }

  /**
   * Reserve a seat to pay for by transfer.
   *
   * Idempotent per student and session: a second press, a second tab or a
   * retried request returns the purchase already in progress (the partial
   * unique index backs this up if two arrive in the same instant). The seat is
   * held for `holdMinutes()` of server time — long enough to make a transfer,
   * short enough that an abandoned checkout gives the seat back.
   */
  async hold(userId: string, sessionId: string) {
    const student = await this.studentOf(userId);
    const now = new Date();
    try {
      const purchase = await this.prisma.$transaction(async (tx) => {
        const s = await lockSession(tx, sessionId);
        const existing = await tx.livePurchase.findFirst({
          where: { sessionId, studentId: student.id, status: { in: ACTIVE } },
        });
        if (existing) return existing;
        await this.assertBuyable(tx, s, student.id, now);
        await this.assertSeatFree(tx, s!, now);
        const { breakdown, feeRefundable } = await this.price(s!, tx);
        const hold = new Date(Math.min(now.getTime() + holdMinutes() * 60_000, closesAtMs(s!)));
        return tx.livePurchase.create({
          data: {
            ...this.purchaseData(s!, breakdown, feeRefundable, { studentId: student.id }),
            status: 'HELD',
            holdExpiresAt: hold,
          },
        });
      });
      return this.byId(purchase.id);
    } catch (e) {
      // Two requests in the same instant: the index let one through; this is
      // the other, and the answer is the purchase the first one made.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existing = await this.prisma.livePurchase.findFirst({
          where: { sessionId, studentId: student.id, status: { in: ACTIVE } },
        });
        if (existing) return this.byId(existing.id);
      }
      throw e;
    }
  }

  /**
   * The buyer says they have transferred the money: here is the proof and the
   * number it came from. A PENDING Payment is created for exactly the frozen
   * price — the only thing the listener will match — and the seat is kept for
   * them until the class ends while it is verified. The proof is evidence,
   * never verification.
   */
  async submitTransfer(
    userId: string,
    purchaseId: string,
    dto: { method: string; reference?: string; proofImageUrl?: string },
  ) {
    const student = await this.studentOf(userId);
    const pre = await this.prisma.livePurchase.findUnique({ where: { id: purchaseId } });
    if (!pre || pre.studentId !== student.id) throw new NotFoundException('Purchase not found');
    if (!['INSTAPAY', 'VODAFONE_CASH', 'BANK_TRANSFER', 'OTHER'].includes(dto.method)) {
      throw new BadRequestException({ message: 'Choose how you transferred', code: 'METHOD_INVALID' });
    }
    const handles = await this.receivingHandles();
    const reference = normalizePayerReference(dto.method as never, dto.reference, handles);
    const reading = await this.proofReader.read(dto.proofImageUrl ?? '');
    const check = checkProofAgainstClaim(reading, { amountCents: pre.studentPaysCents }, handles);
    if (check.verdict === 'DISAGREES') {
      throw new BadRequestException({ message: check.problems.join(' '), code: 'PROOF_DISAGREES', problems: check.problems });
    }
    const proofKey = await this.proofs.store('payments', dto.proofImageUrl ?? '', PROOF_MAX_BYTES);
    const now = new Date();
    let paymentId: string;
    try {
      paymentId = await this.prisma.$transaction(async (tx) => {
        const s = await lockSession(tx, pre.sessionId);
        const p = await lockPurchase(tx, purchaseId);
        if (!p) throw new NotFoundException('Purchase not found');
        if (p.status === 'PAYMENT_PENDING' || p.status === 'CONFIRMED') {
          throw new ConflictException({ message: 'A payment for this seat was already sent', code: 'PAYMENT_ALREADY_SUBMITTED' });
        }
        if (p.status !== 'HELD' && p.status !== 'EXPIRED') {
          throw new ConflictException({ message: 'This purchase is closed', code: 'PURCHASE_CLOSED', status: p.status });
        }
        if (!s || s.deletedAt || s.cancelledAt) throw new NotFoundException('Session not found');
        if (p.status === 'EXPIRED') {
          // Their hold lapsed, but they may already have transferred: the
          // money is accepted either way. If another purchase of theirs is
          // live they should use that one.
          const other = await tx.livePurchase.findFirst({
            where: { sessionId: p.sessionId, studentId: student.id, status: { in: ACTIVE }, id: { not: p.id } },
          });
          if (other)
            throw new ConflictException({ message: 'You have another purchase for this session', code: 'ANOTHER_PURCHASE_ACTIVE' });
        }
        // Keep (or retake) the seat until the class ends while the payment is
        // verified. If the class has filled meanwhile, the payment is still
        // taken — verification then gives the seat if one opened, or refunds.
        let keep: Date | null = new Date(closesAtMs(s));
        if (p.status === 'EXPIRED' || (p.holdExpiresAt && p.holdExpiresAt <= now)) {
          const full = s.capacity != null && (await seatsTaken(tx, s.id, now, p.id)) >= s.capacity;
          const over = now.getTime() >= closesAtMs(s);
          if (full || over) keep = null;
        }
        assertTransition(p.status, 'PAYMENT_PENDING');
        const payment = await tx.payment.create({
          data: {
            studentId: student.id,
            livePurchaseId: p.id,
            tenantId: p.tenantId,
            academyId: p.academyId,
            amountCents: p.studentPaysCents,
            feeCents: p.feeCents,
            netCents: p.teacherCents + p.centerCents,
            currency: p.currency,
            gateway: 'manual',
            method: dto.method as never,
            proofImageUrl: proofKey,
            proofReading: (reading ?? undefined) as never,
            reference,
            status: 'PENDING',
          },
        });
        await tx.livePurchase.update({
          where: { id: p.id },
          data: { status: 'PAYMENT_PENDING', holdExpiresAt: keep },
        });
        return payment.id;
      });
    } catch (e) {
      await this.proofs.discard(proofKey).catch(() => undefined);
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({ message: 'A payment for this seat was already sent', code: 'PAYMENT_ALREADY_SUBMITTED' });
      }
      throw e;
    }
    // Students often transfer first and fill the form after: an SMS that is
    // already here is matched now instead of waiting for a human.
    await this.matching.reconcilePayment(paymentId).catch((e) =>
      this.logger.warn(`live.reconcile payment=${paymentId} failed: ${(e as Error).message}`),
    );
    return this.byId(purchaseId);
  }

  private async receivingHandles(): Promise<string[]> {
    const accounts = await this.prisma.platformPaymentAccount.findMany({ select: { handle: true } });
    return accounts.map((a) => a.handle);
  }

  /**
   * Buy a seat from the Darsly Wallet: reserve it, pay for it and confirm it
   * in ONE serializable transaction. Either all of it happens — a seat, a
   * wallet debit into the purchase's holding account, a booking — or none of
   * it does (not enough balance, the class filled, a concurrent spend of the
   * same balance). Serializable is the same guard every other wallet spend
   * uses (see ManualPaymentsService.SERIALIZABLE), so a course purchase and a
   * seat purchase cannot both spend the same money.
   */
  async payWithWallet(userId: string, sessionId: string) {
    const student = await this.studentOf(userId);
    for (let attempt = 0; ; attempt++) {
      try {
        const out = await this.prisma.$transaction(
          async (tx) => {
            const now = new Date();
            const s = await lockSession(tx, sessionId);
            let p = await tx.livePurchase.findFirst({
              where: { sessionId, studentId: student.id, status: { in: ACTIVE } },
            });
            if (p && p.status !== 'HELD') {
              if (p.status === 'PAYMENT_PENDING')
                throw new ConflictException({ message: 'A transfer for this seat is being verified', code: 'PAYMENT_ALREADY_SUBMITTED' });
              return { purchaseId: p.id, already: true };
            }
            await this.assertBuyable(tx, s, student.id, now);
            if (p) {
              // They held a seat for a transfer, then chose the wallet: the
              // same purchase and the same frozen price, paid differently.
              if (!p.holdExpiresAt || p.holdExpiresAt <= now) await this.assertSeatFree(tx, s!, now, p.id);
            } else {
              await this.assertSeatFree(tx, s!, now);
              const { breakdown, feeRefundable } = await this.price(s!, tx);
              p = await tx.livePurchase.create({
                data: {
                  ...this.purchaseData(s!, breakdown, feeRefundable, { studentId: student.id }),
                  status: 'HELD',
                  holdExpiresAt: new Date(closesAtMs(s!)),
                },
              });
            }
            const balance = await this.ledger.walletBalance(student.id, tx);
            if (balance < p.studentPaysCents) {
              throw new BadRequestException({
                message: 'Wallet balance is not enough',
                code: 'INSUFFICIENT_BALANCE',
                balanceCents: balance,
                requiredCents: p.studentPaysCents,
              });
            }
            const payment = await tx.payment.create({
              data: {
                studentId: student.id,
                livePurchaseId: p.id,
                tenantId: p.tenantId,
                academyId: p.academyId,
                amountCents: p.studentPaysCents,
                walletCents: p.studentPaysCents,
                feeCents: p.feeCents,
                netCents: p.teacherCents + p.centerCents,
                currency: p.currency,
                gateway: 'manual',
                method: 'WALLET',
                status: 'PENDING',
              },
            });
            await this.settleAndSeat(tx, s!, p, payment.id, 'wallet', now);
            return { purchaseId: p.id, paymentId: payment.id, already: false };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20_000, maxWait: 10_000 },
        );
        if (out.paymentId) await this.afterConfirmed(out.purchaseId, out.paymentId);
        return this.byId(out.purchaseId);
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && (e.code === 'P2034' || e.code === 'P2002') && attempt < 4) {
          continue;
        }
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2034') {
          throw new ConflictException({ message: 'Busy — please try again', code: 'WALLET_CONCURRENT_WRITE' });
        }
        throw e;
      }
    }
  }

  // ── Verification (the one pipeline hands Live payments here) ────────────

  /**
   * Inside the caller's transaction, with the session and purchase already
   * locked: flip the payment to PAID+settled (compare-and-swap, so exactly
   * one caller ever does), book the money into the purchase's holding
   * account, and give the seat — or, when there is no seat to give, refund
   * the whole amount. Returns false when another caller already handled it.
   */
  private async settleAndSeat(
    tx: Tx,
    s: LockedSession,
    p: LivePurchase,
    paymentId: string,
    verifierId: string,
    now: Date,
  ): Promise<'CONFIRMED' | 'OVERSOLD' | 'CANCELLED_BY_TEACHER' | false> {
    const flip = await tx.payment.updateMany({
      where: { id: paymentId, status: 'PENDING' },
      data: { status: 'PAID', paidAt: now, settledAt: now, verifiedById: verifierId },
    });
    if (flip.count === 0) return false;
    await this.ledger.recordPayment(paymentId, tx);

    // The class was called off while the money was on its way.
    if (s.deletedAt || s.cancelledAt) {
      assertTransition(p.status, 'CANCELLED_BY_TEACHER');
      await tx.livePurchase.update({
        where: { id: p.id },
        data: { status: 'CANCELLED_BY_TEACHER', cancelledAt: now, holdExpiresAt: null, cancelReason: 'session cancelled' },
      });
      await this.fullRefund(tx, p.id, 'TEACHER_CANCEL', verifierId);
      return 'CANCELLED_BY_TEACHER';
    }
    // Their own unexpired hold is their seat; otherwise one must still be free
    // and the class still ahead. Money that finds no seat is not kept.
    const holding = p.holdExpiresAt != null && p.holdExpiresAt > now && HOLDING.includes(p.status);
    const over = s.status === 'ENDED' || now.getTime() >= closesAtMs(s);
    const full = s.capacity != null && (await seatsTaken(tx, s.id, now, p.id)) >= s.capacity;
    if (!holding && (over || full)) {
      assertTransition(p.status, 'OVERSOLD');
      await tx.livePurchase.update({
        where: { id: p.id },
        data: { status: 'OVERSOLD', holdExpiresAt: null, reviewReason: over ? 'class already over' : 'class full' },
      });
      await this.fullRefund(tx, p.id, 'OVERSOLD', verifierId);
      return 'OVERSOLD';
    }
    assertTransition(p.status, 'CONFIRMED');
    await tx.livePurchase.update({
      where: { id: p.id },
      data: { status: 'CONFIRMED', confirmedAt: now, holdExpiresAt: null },
    });
    await tx.liveBooking.create({ data: { sessionId: s.id, studentId: p.studentId as string, purchaseId: p.id } });
    return 'CONFIRMED';
  }

  async onPaymentVerified(paymentId: string, verifierId: string): Promise<{ ok: true; alreadyHandled?: boolean }> {
    const pay = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: { id: true, status: true, livePurchaseId: true, livePurchase: { select: { sessionId: true } } },
    });
    if (!pay?.livePurchaseId || !pay.livePurchase) throw new NotFoundException('Payment not found');
    if (pay.status !== 'PENDING') return { ok: true, alreadyHandled: true };
    const sessionId = pay.livePurchase.sessionId;
    const outcome = await this.prisma.$transaction(
      async (tx) => {
        const now = new Date();
        const s = await lockSession(tx, sessionId);
        const p = await lockPurchase(tx, pay.livePurchaseId as string);
        if (!s || !p) throw new NotFoundException('Purchase not found');
        return this.settleAndSeat(tx, s, p, paymentId, verifierId, now);
      },
      { timeout: 20_000, maxWait: 10_000 },
    );
    if (outcome === false) return { ok: true, alreadyHandled: true };
    if (outcome === 'CONFIRMED') await this.afterConfirmed(pay.livePurchaseId, paymentId);
    else await this.afterRefunded(pay.livePurchaseId, outcome);
    return { ok: true };
  }

  async onPaymentRejected(paymentId: string, actorId: string, reason?: string): Promise<{ ok: true }> {
    const pay = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: { livePurchaseId: true, livePurchase: { select: { sessionId: true } } },
    });
    if (!pay?.livePurchaseId || !pay.livePurchase) throw new NotFoundException('Payment not found');
    const sessionId = pay.livePurchase.sessionId;
    const studentId = await this.prisma.$transaction(async (tx) => {
      await lockSession(tx, sessionId);
      const p = await lockPurchase(tx, pay.livePurchaseId as string);
      const flip = await tx.payment.updateMany({
        where: { id: paymentId, status: 'PENDING' },
        data: { status: 'REJECTED', rejectedReason: reason?.trim() || null, verifiedById: actorId },
      });
      if (flip.count === 0) throw new BadRequestException({ message: 'Payment is not pending', code: 'NOT_PENDING' });
      if (p && p.status === 'PAYMENT_PENDING') {
        await tx.livePurchase.update({
          where: { id: p.id },
          data: { status: 'PAYMENT_REJECTED', holdExpiresAt: null, reviewReason: reason?.trim() || null },
        });
      }
      return p?.studentId ?? null;
    });
    if (studentId) {
      await this.notifyStudent(
        studentId,
        'لم يتم تأكيد الدفعة ❌',
        reason?.trim()
          ? `دفعتك لحجز الجلسة لم تُقبل. السبب: ${reason.trim()}`
          : 'دفعتك لحجز الجلسة لم تُقبل. تقدر تحجز من جديد وترفع إثبات صحيح.',
      );
    }
    return { ok: true };
  }

  // ── Refunds (the part every path needs) ──────────────────────────────────

  /**
   * What is still refundable of a purchase, part by part: the frozen amounts
   * minus every refund not rejected. Refunds and the release both draw on
   * these same parts, so together they can never exceed what was paid.
   */
  async remainingParts(tx: Tx, p: LivePurchase) {
    const refunded = await tx.refund.aggregate({
      where: { livePurchaseId: p.id, status: { not: 'REJECTED' } },
      _sum: { feeRefundCents: true, teacherRefundCents: true, centerRefundCents: true },
    });
    return {
      fee: p.feeCents - (refunded._sum.feeRefundCents ?? 0),
      teacher: p.teacherCents - (refunded._sum.teacherRefundCents ?? 0),
      center: p.centerCents - (refunded._sum.centerRefundCents ?? 0),
    };
  }

  /**
   * Return everything still refundable (the seat was never delivered).
   * Registered buyers get it in their wallet at once; the refund row, the
   * ledger transaction and the wallet line are written together.
   */
  async fullRefund(tx: Tx, purchaseId: string, reason: RefundReason, actorId: string | null) {
    const p = await tx.livePurchase.findUniqueOrThrow({ where: { id: purchaseId }, include: { payment: true } });
    const parts = await this.remainingParts(tx, p);
    return this.refundParts(tx, p, reason, parts, actorId);
  }

  /** Book one refund of the given parts. Idempotent per (purchase, reason). */
  async refundParts(
    tx: Tx,
    p: LivePurchase & { payment: { id: string; status: string } | null },
    reason: RefundReason,
    parts: { fee: number; teacher: number; center: number },
    actorId: string | null,
  ) {
    const amount = parts.fee + parts.teacher + parts.center;
    // Nothing was paid (a free seat of a paid session) or nothing is left:
    // there is nothing to return, and a zero refund is not a record.
    if (amount <= 0 || !p.payment || p.payment.status !== 'PAID') return null;
    const existing = await tx.refund.findUnique({ where: { livePurchaseId_reason: { livePurchaseId: p.id, reason } } });
    if (existing) return existing;
    if (!p.studentId) throw new Error('guest refunds are booked by the guest refund flow');
    const refund = await tx.refund.create({
      data: {
        livePurchaseId: p.id,
        paymentId: p.payment.id,
        reason,
        destination: 'WALLET',
        status: 'COMPLETED',
        amountCents: amount,
        feeRefundCents: parts.fee,
        teacherRefundCents: parts.teacher,
        centerRefundCents: parts.center,
        requestedById: actorId,
        decidedById: actorId,
        decidedAt: new Date(),
        completedAt: new Date(),
      },
    });
    const txnId = await this.ledger.bookLiveRefund(
      {
        refundId: refund.id,
        purchaseId: p.id,
        amountCents: amount,
        destination: { wallet: p.studentId },
        tenantId: p.tenantId,
        academyId: p.academyId,
      },
      tx,
    );
    await tx.refund.update({ where: { id: refund.id }, data: { ledgerTxnId: txnId } });
    await tx.walletTransaction.create({
      data: {
        studentId: p.studentId,
        kind: 'REFUND',
        amountCents: amount,
        description: reason === 'STUDENT_CANCEL' ? 'استرداد إلغاء حجز جلسة' : 'استرداد حجز جلسة',
        paymentId: p.payment.id,
        ledgerTxnId: txnId,
      },
    });
    return refund;
  }

  // ── Delivery: held money becomes earnings, exactly once ─────────────────

  /** The account a Center's share is credited to (null for a PERSONAL academy). */
  private async centerAccountFor(tx: Tx, academyId: string) {
    const a = await tx.academy.findUnique({ where: { id: academyId }, select: { kind: true } });
    return a?.kind === 'CENTER' ? `academy:${academyId}:balance` : null;
  }

  /**
   * Release one purchase's remaining held money under its frozen snapshot.
   * Called with the session and purchase locked. Idempotent: releasedAt is
   * the guard here, and the ledger key the guard beneath it.
   */
  private async releaseInTx(tx: Tx, p: LivePurchase, now: Date) {
    if (p.releasedAt) return false;
    const parts = await this.remainingParts(tx, p);
    await this.ledger.releaseLivePurchase(
      {
        purchaseId: p.id,
        tenantId: p.tenantId,
        academyId: p.academyId,
        centerAccount: await this.centerAccountFor(tx, p.academyId),
        parts,
      },
      tx,
    );
    await tx.livePurchase.update({
      where: { id: p.id },
      data: {
        releasedAt: now,
        ...(p.status === 'CONFIRMED' || p.status === 'NEEDS_REVIEW'
          ? { status: 'DELIVERED' as const, deliveredAt: now }
          : {}),
      },
    });
    return true;
  }

  /**
   * The sweep after classes end. For each purchase whose class is over:
   * delivered → its money is released (seat buyers, and the part a student
   * who cancelled late did not get back); not delivered → NEEDS_REVIEW, and
   * nothing moves until finance decides. Also flags classes nobody ever
   * started. Every decision is re-made under the locks, so retries and
   * replicas are harmless.
   */
  async releaseDelivered(limit = 50): Promise<{ released: number; review: number }> {
    const now = new Date();
    const candidates = await this.prisma.livePurchase.findMany({
      where: {
        releasedAt: null,
        payment: { status: 'PAID' },
        OR: [
          { status: 'CONFIRMED', session: { status: 'ENDED', cancelledAt: null } },
          { status: 'CANCELLED_BY_STUDENT', session: { status: 'ENDED', cancelledAt: null } },
          // Never started, and well past its end: a no-show to be reviewed.
          {
            status: 'CONFIRMED',
            session: { status: 'SCHEDULED', startedAt: null, startsAt: { lt: new Date(now.getTime() - NO_SHOW_GRACE_MS) } },
          },
        ],
      },
      select: { id: true, sessionId: true },
      take: limit,
      orderBy: { createdAt: 'asc' },
    });
    let released = 0;
    let review = 0;
    for (const c of candidates) {
      const r = await this.prisma.$transaction(async (tx) => {
        const s = await lockSession(tx, c.sessionId);
        const p = await lockPurchase(tx, c.id);
        if (!s || !p || p.releasedAt) return null;
        // A cancelled class is never paid out: its refunds are the cancellation's.
        if (s.cancelledAt || s.deletedAt) return null;
        if (s.status === 'SCHEDULED' && !s.startedAt) {
          if (p.status !== 'CONFIRMED' || closesAtMs(s) + NO_SHOW_GRACE_MS > now.getTime()) return null;
          assertTransition(p.status, 'NEEDS_REVIEW');
          await tx.livePurchase.update({ where: { id: p.id }, data: { status: 'NEEDS_REVIEW', reviewReason: 'never started' } });
          return 'review' as const;
        }
        const verdict = deliveryVerdict(s);
        if (verdict.delivered) {
          if (p.status !== 'CONFIRMED' && p.status !== 'CANCELLED_BY_STUDENT') return null;
          return (await this.releaseInTx(tx, p, now)) ? ('released' as const) : null;
        }
        if (p.status === 'CONFIRMED') {
          assertTransition(p.status, 'NEEDS_REVIEW');
          await tx.livePurchase.update({ where: { id: p.id }, data: { status: 'NEEDS_REVIEW', reviewReason: verdict.reason } });
          return 'review' as const;
        }
        return null;
      });
      if (r === 'released') released++;
      if (r === 'review') review++;
    }
    return { released, review };
  }

  /** Finance decides a reviewed purchase was delivered after all: release it. */
  async adminRelease(purchaseId: string, adminId: string) {
    const pre = await this.prisma.livePurchase.findUnique({ where: { id: purchaseId } });
    if (!pre) throw new NotFoundException('Purchase not found');
    await this.prisma.$transaction(async (tx) => {
      await lockSession(tx, pre.sessionId);
      const p = await lockPurchase(tx, purchaseId);
      if (!p) throw new NotFoundException('Purchase not found');
      if (p.releasedAt) return;
      if (p.status !== 'NEEDS_REVIEW')
        throw new ConflictException({ message: 'Only a purchase under review is released by hand', code: 'PURCHASE_STATE_CONFLICT' });
      await this.releaseInTx(tx, p, new Date());
    });
    await this.audit(adminId, 'live.purchase.release', purchaseId, {});
    return this.byId(purchaseId);
  }

  /**
   * Finance refunds a purchase in full (a class that did not really happen, a
   * no-show, a complaint upheld). The seat and access go; nothing is released.
   */
  async adminRefund(purchaseId: string, adminId: string, reason: 'ADMIN' | 'NO_SHOW' = 'ADMIN') {
    const pre = await this.prisma.livePurchase.findUnique({ where: { id: purchaseId } });
    if (!pre) throw new NotFoundException('Purchase not found');
    await this.prisma.$transaction(async (tx) => {
      await lockSession(tx, pre.sessionId);
      const p = await lockPurchase(tx, purchaseId);
      if (!p) throw new NotFoundException('Purchase not found');
      if (p.status === 'REFUNDED' || p.status === 'REFUND_PENDING') return;
      if (p.releasedAt)
        throw new ConflictException({ message: 'Earnings were already released for this purchase', code: 'ALREADY_RELEASED' });
      if (p.status !== 'NEEDS_REVIEW' && p.status !== 'CONFIRMED')
        throw new ConflictException({ message: 'This purchase cannot be refunded by hand', code: 'PURCHASE_STATE_CONFLICT' });
      await tx.liveBooking.deleteMany({ where: { purchaseId: p.id } });
      assertTransition(p.status, 'REFUNDED');
      await tx.livePurchase.update({ where: { id: p.id }, data: { status: 'REFUNDED', cancelledAt: new Date(), cancelReason: reason } });
      await this.fullRefund(tx, p.id, reason, adminId);
    });
    await this.audit(adminId, 'live.purchase.refund', purchaseId, { reason });
    return this.byId(purchaseId);
  }

  pendingEarnings(where: { academyId: string; tenantId?: string }, side: 'teacher' | 'center') {
    return livePendingEarnings(this.prisma, where, side);
  }

  private async audit(actorUserId: string, action: string, entityId: string, meta: Record<string, unknown>) {
    await this.prisma.auditLog
      .create({ data: { actorUserId, action, entity: 'LivePurchase', entityId, meta: meta as never } })
      .catch(() => undefined);
  }

  // ── Cancellation ────────────────────────────────────────────────────────

  /**
   * How much of a purchase a STUDENT's own cancellation returns, from the
   * policy frozen at purchase time and the server's clock. Inside the window:
   * everything, except Darsly's fee when the terms said it is kept. Outside
   * it (or NO_REFUND): nothing — the seat is still released.
   */
  studentRefundParts(
    p: Pick<LivePurchase, 'refundPolicy' | 'feeRefundableOnStudentCancel'>,
    remaining: { fee: number; teacher: number; center: number },
    startsAt: Date,
    now: Date,
  ) {
    const hours = LIVE_REFUND_WINDOW_HOURS[p.refundPolicy];
    const inWindow = hours != null && now.getTime() <= startsAt.getTime() - hours * 3600_000;
    if (!inWindow) return { fee: 0, teacher: 0, center: 0, inWindow };
    return {
      fee: p.feeRefundableOnStudentCancel ? remaining.fee : 0,
      teacher: remaining.teacher,
      center: remaining.center,
      inWindow,
    };
  }

  /**
   * A student gives their seat back. Only before the class starts; a payment
   * still being verified cannot be cancelled from under the verifier. The
   * seat and the access go at once (the booking is deleted); what comes back
   * is the stored policy's answer, to the wallet, in the same transaction.
   * A second press finds the purchase already cancelled and changes nothing.
   */
  async cancelByStudent(userId: string, purchaseId: string) {
    const student = await this.studentOf(userId);
    const pre = await this.prisma.livePurchase.findUnique({ where: { id: purchaseId } });
    if (!pre || pre.studentId !== student.id) throw new NotFoundException('Purchase not found');
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const s = await lockSession(tx, pre.sessionId);
      await lockPurchase(tx, purchaseId);
      const p = await tx.livePurchase.findUniqueOrThrow({ where: { id: purchaseId }, include: { payment: true } });
      if (p.status === 'CANCELLED_BY_STUDENT') return;
      if (p.status === 'PAYMENT_PENDING')
        throw new ConflictException({ message: 'Your payment is being verified — it cannot be cancelled now', code: 'PAYMENT_UNDER_REVIEW' });
      if (p.status !== 'HELD' && p.status !== 'CONFIRMED')
        throw new ConflictException({ message: 'This purchase cannot be cancelled', code: 'PURCHASE_STATE_CONFLICT', status: p.status });
      if (!s) throw new NotFoundException('Session not found');
      if (p.status === 'CONFIRMED' && (s.status !== 'SCHEDULED' || now.getTime() >= s.startsAt.getTime())) {
        throw new ConflictException({ message: 'لا يمكن إلغاء الحجز بعد بدء الحصة', code: 'CANCEL_WINDOW_CLOSED' });
      }
      assertTransition(p.status, 'CANCELLED_BY_STUDENT');
      await tx.liveBooking.deleteMany({ where: { purchaseId: p.id } });
      await tx.livePurchase.update({
        where: { id: p.id },
        data: { status: 'CANCELLED_BY_STUDENT', cancelledAt: now, holdExpiresAt: null, cancelReason: 'student' },
      });
      if (p.status === 'CONFIRMED') {
        const remaining = await this.remainingParts(tx, p);
        const parts = this.studentRefundParts(p, remaining, s.startsAt, now);
        await this.refundParts(tx, p, 'STUDENT_CANCEL', parts, userId);
      }
    });
    await this.audit(userId, 'live.purchase.cancel.student', purchaseId, {});
    return this.byId(purchaseId);
  }

  /**
   * The teacher (or the academy) called the class off: every buyer gets back
   * everything they still have in it — a confirmed seat in full, a student
   * who had cancelled late the part they had not got back — and nobody is
   * paid. Held seats are simply released. Each purchase in its own
   * transaction under the locks; the refund is unique per purchase and
   * reason, so running this again (a retry, the sweep) changes nothing.
   */
  async onSessionCancelled(sessionId: string, actorId: string | null): Promise<{ refunded: number }> {
    const rows = await this.prisma.livePurchase.findMany({
      where: {
        sessionId,
        releasedAt: null,
        status: { in: ['HELD', 'CONFIRMED', 'NEEDS_REVIEW', 'CANCELLED_BY_STUDENT'] },
      },
      select: { id: true },
    });
    let refunded = 0;
    for (const r of rows) {
      const did = await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        const s = await lockSession(tx, sessionId);
        if (!s || !(s.cancelledAt || s.deletedAt)) return false;
        const p = await lockPurchase(tx, r.id);
        if (!p || p.releasedAt) return false;
        if (p.status === 'HELD') {
          await tx.livePurchase.update({
            where: { id: p.id },
            data: { status: 'CANCELLED_BY_TEACHER', cancelledAt: now, holdExpiresAt: null, cancelReason: 'session cancelled' },
          });
          return false;
        }
        if (p.status === 'CONFIRMED' || p.status === 'NEEDS_REVIEW') {
          await tx.liveBooking.deleteMany({ where: { purchaseId: p.id } });
          await tx.livePurchase.update({
            where: { id: p.id },
            data: { status: 'CANCELLED_BY_TEACHER', cancelledAt: now, cancelReason: 'session cancelled' },
          });
        } else if (p.status !== 'CANCELLED_BY_STUDENT') {
          return false;
        }
        const refund = await this.fullRefund(tx, p.id, 'TEACHER_CANCEL', actorId);
        return !!refund;
      });
      if (did) {
        refunded++;
        await this.afterRefunded(r.id, 'CANCELLED_BY_TEACHER');
      }
    }
    return { refunded };
  }

  /** Cancelled classes whose refunds are not all booked yet (a crash mid-way): finished here. */
  async sweepCancelled(limit = 20): Promise<number> {
    const sessions = await this.prisma.livePurchase.findMany({
      where: {
        releasedAt: null,
        status: { in: ['HELD', 'CONFIRMED', 'NEEDS_REVIEW'] },
        session: { cancelledAt: { not: null } },
      },
      select: { sessionId: true },
      distinct: ['sessionId'],
      take: limit,
    });
    let n = 0;
    for (const s of sessions) n += (await this.onSessionCancelled(s.sessionId, null)).refunded;
    return n;
  }

  // ── Holds that lapse ─────────────────────────────────────────────────────

  /**
   * Give back seats whose hold lapsed with no payment sent. Each under the
   * session lock, re-checked there, so a payment submitted in the same
   * instant wins (it moves the purchase out of HELD first). Safe to run on
   * every replica and to repeat.
   */
  async expireHolds(limit = 50): Promise<number> {
    const now = new Date();
    const due = await this.prisma.livePurchase.findMany({
      where: { status: 'HELD', holdExpiresAt: { lte: now } },
      select: { id: true, sessionId: true },
      take: limit,
      orderBy: { holdExpiresAt: 'asc' },
    });
    let expired = 0;
    for (const d of due) {
      const done = await this.prisma.$transaction(async (tx) => {
        await lockSession(tx, d.sessionId);
        const p = await lockPurchase(tx, d.id);
        if (!p || p.status !== 'HELD' || !p.holdExpiresAt || p.holdExpiresAt > new Date()) return false;
        await tx.livePurchase.update({ where: { id: p.id }, data: { status: 'EXPIRED', holdExpiresAt: null } });
        return true;
      });
      if (done) expired++;
    }
    return expired;
  }

  // ── Reading ──────────────────────────────────────────────────────────────

  async byId(purchaseId: string) {
    const p = await this.prisma.livePurchase.findUniqueOrThrow({
      where: { id: purchaseId },
      include: { payment: true, refunds: true },
    });
    return this.view(p);
  }

  /** The buyer's view: their price, their state, their payment — never the split. */
  view(p: LivePurchase & { payment: any; refunds: any[] }) {
    return {
      id: p.id,
      sessionId: p.sessionId,
      status: p.status,
      holdExpiresAt: p.holdExpiresAt,
      studentPaysCents: p.studentPaysCents,
      currency: p.currency,
      refundPolicy: p.refundPolicy,
      replayPolicy: p.replayPolicy,
      replayDays: p.replayDays,
      confirmedAt: p.confirmedAt,
      cancelledAt: p.cancelledAt,
      payment: p.payment
        ? {
            id: p.payment.id,
            status: p.payment.status,
            method: p.payment.method,
            rejectedReason: p.payment.rejectedReason,
            createdAt: p.payment.createdAt,
          }
        : null,
      refunds: p.refunds.map((r) => ({
        id: r.id,
        reason: r.reason,
        status: r.status,
        destination: r.destination,
        amountCents: r.amountCents,
        createdAt: r.createdAt,
        completedAt: r.completedAt,
      })),
    };
  }

  async mine(userId: string) {
    const student = await this.studentOf(userId);
    const rows = await this.prisma.livePurchase.findMany({
      where: { studentId: student.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { payment: true, refunds: true, session: { select: { title: true, startsAt: true, durationMin: true } } },
    });
    return rows.map((p) => ({ ...this.view(p), session: p.session }));
  }

  // ── After the fact (outside the money transaction) ──────────────────────

  private async afterConfirmed(purchaseId: string, paymentId: string) {
    await this.ledger.ensureInvoice(paymentId).catch((e) =>
      this.logger.warn(`live.invoice payment=${paymentId} failed: ${(e as Error).message}`),
    );
    const p = await this.prisma.livePurchase.findUnique({
      where: { id: purchaseId },
      include: { session: { select: { title: true, tenantId: true } } },
    });
    if (!p?.studentId) return;
    await this.notifyStudent(p.studentId, 'تم تأكيد حجزك ✅', `مكانك في «${p.session.title}» اتأكد. هتلاقيها في جلساتك المباشرة.`, {
      sessionId: p.sessionId,
    });
    const teacher = await this.prisma.teacherProfile.findUnique({ where: { id: p.session.tenantId }, select: { userId: true } });
    if (teacher)
      await this.notifications
        .create({
          userId: teacher.userId,
          type: 'LIVE_SESSION_REMINDER',
          title: 'حجز مدفوع جديد 💳',
          body: `طالب حجز مكانه في «${p.session.title}».`,
          meta: { sessionId: p.sessionId },
        })
        .catch(() => undefined);
  }

  private async afterRefunded(purchaseId: string, outcome: 'OVERSOLD' | 'CANCELLED_BY_TEACHER') {
    const p = await this.prisma.livePurchase.findUnique({
      where: { id: purchaseId },
      include: { session: { select: { title: true } } },
    });
    if (!p?.studentId) return;
    await this.notifyStudent(
      p.studentId,
      'رجّعنالك فلوسك 💰',
      outcome === 'OVERSOLD'
        ? `دفعتك لـ«${p.session.title}» اتأكدت بعد ما الأماكن خلصت، فالمبلغ كله رجع لمحفظتك.`
        : `«${p.session.title}» اتلغت، فالمبلغ كله رجع لمحفظتك.`,
      { sessionId: p.sessionId },
    );
  }

  private async notifyStudent(studentId: string, title: string, body: string, meta: Record<string, unknown> = {}) {
    const s = await this.prisma.studentProfile.findUnique({ where: { id: studentId }, select: { userId: true } });
    if (s)
      await this.notifications
        .create({ userId: s.userId, type: 'LIVE_SESSION_REMINDER', title, body, meta })
        .catch(() => undefined);
  }
}
