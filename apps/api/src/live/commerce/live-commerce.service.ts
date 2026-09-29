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
  PayoutMethod,
  LiveRefundPolicy,
  LiveReplayPolicy,
  Prisma,
  RefundReason,
} from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { LedgerService } from '../../payments/ledger.service';
import { PaymentTargets } from '../../payments/payment-targets';
import { PaymentMatchingService } from '../../payments/payment-matching.service';
import { paymentRow, paymentStage } from '../../payments/payment-stage';
import { normalizeDeclaration, normalizePayerReference } from '../../payments/payer-reference';
import { receivingHandles } from '../../payments/receiving-accounts';
import { checkProofAgainstClaim } from '../../payments/proof-check';
import { ProofReaderService } from '../../payments/proof-reader.service';
import { ProofStorageService } from '../../storage/proof-storage.service';
import { NotificationsService } from '../../notifications/notifications.service';
import {
  CommercialTermsService,
  pricingRefusal,
  toSnapshot,
} from '../../commerce/commercial-terms.service';
import { PriceBreakdown, priceLiveSeat, PricingError } from '../../commerce/pricing';
import { LIVE_REFUND_WINDOW_HOURS } from '@darsly/shared-types';
import { livePendingEarnings } from './pending-earnings';
import { releaseCouponUse, reserveCouponUse } from '../../payments/coupon-use';
import { mulDivRoundHalfUp } from '../../commerce/pricing';

type Tx = Prisma.TransactionClient;

/** The Darsly accounts a Live seat can be paid into (the destination). */
export const TRANSFER_METHODS = ['INSTAPAY', 'VODAFONE_CASH', 'BANK_TRANSFER', 'OTHER'] as const;

/** Before transferring: which Darsly account, and where the money comes from. */
export interface DeclareDto {
  method: string;
  source: 'WALLET' | 'BANK';
  senderWallet?: string;
  payerName?: string;
  reference?: string;
}

/** After transferring: the proof (plus, for a client that did not declare, the identity). */
export interface TransferClaimDto {
  method?: string;
  reference?: string;
  proofImageUrl?: string;
  source?: 'WALLET' | 'BANK';
  senderWallet?: string;
  payerName?: string;
}

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
    return {
      delivered: false,
      reason: `ran ${Math.max(0, Math.round(ranMs / 60_000))} of ${s.durationMin} minutes`,
    };
  return { delivered: true };
}

/** The states that hold a seat while unexpired. */
const HOLDING: LivePurchaseStatus[] = ['HELD', 'PAYMENT_PENDING'];
/** The states the one-active-purchase index covers (see the migration). */
export const ACTIVE: LivePurchaseStatus[] = [
  'HELD',
  'PAYMENT_PENDING',
  'CONFIRMED',
  'DELIVERED',
  'NEEDS_REVIEW',
];

/**
 * Every allowed move of a purchase, and nothing else. A transition not listed
 * here is a bug, and is refused rather than written.
 */
const TRANSITIONS: Record<LivePurchaseStatus, LivePurchaseStatus[]> = {
  // HELD → PAYMENT_REJECTED: a declared transfer Darsly refused before it was claimed.
  HELD: [
    'PAYMENT_PENDING',
    'CONFIRMED',
    'EXPIRED',
    'CANCELLED_BY_STUDENT',
    'CANCELLED_BY_TEACHER',
    'PAYMENT_REJECTED',
  ],
  PAYMENT_PENDING: ['CONFIRMED', 'PAYMENT_REJECTED', 'OVERSOLD', 'CANCELLED_BY_TEACHER'],
  // A declared payment outlives its hold: money that lands late still gets a
  // seat if one is free and the class is ahead, and is refunded if not.
  EXPIRED: ['PAYMENT_PENDING', 'CONFIRMED', 'OVERSOLD'],
  CONFIRMED: [
    'DELIVERED',
    'CANCELLED_BY_STUDENT',
    'CANCELLED_BY_TEACHER',
    'NEEDS_REVIEW',
    'REFUNDED',
    'REFUND_PENDING',
  ],
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

/**
 * Whether this student holds an approved admission exception for this class:
 * a teacher let them past a full booking capacity. It lifts the "full" check
 * for them alone — never the payment: a paid seat is still bought and paid
 * for through the ordinary path. Checked under the session's row lock by
 * every caller, like the capacity it stands in for.
 */
export async function hasAdmission(tx: Tx | PrismaService, sessionId: string, studentId: string | null) {
  if (!studentId) return false;
  const a = await tx.liveAdmissionRequest.findFirst({
    where: { sessionId, studentId, status: 'APPROVED' },
    select: { id: true },
  });
  return !!a;
}

/**
 * A seat was created for this student: an approved exception becomes USED
 * (tied to the seat), and a request still pending is closed — they got in
 * the ordinary way.
 */
export async function consumeAdmission(
  tx: Tx,
  sessionId: string,
  studentId: string,
  link: { bookingId?: string; purchaseId?: string | null },
) {
  const now = new Date();
  await tx.liveAdmissionRequest.updateMany({
    where: { sessionId, studentId, status: 'APPROVED' },
    data: { status: 'USED', usedAt: now, bookingId: link.bookingId ?? null, purchaseId: link.purchaseId ?? null },
  });
  await tx.liveAdmissionRequest.updateMany({
    where: { sessionId, studentId, status: 'PENDING' },
    data: { status: 'CANCELLED', decidedAt: now },
  });
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
  const [booked, guests, held] = await Promise.all([
    tx.liveBooking.count({ where: { sessionId } }),
    // A guest's confirmed seat has no LiveBooking (that is a student's row);
    // it is counted from the purchase instead.
    tx.livePurchase.count({
      where: { sessionId, guestBuyerId: { not: null }, status: 'CONFIRMED' },
    }),
    tx.livePurchase.count({
      where: {
        sessionId,
        status: { in: HOLDING },
        holdExpiresAt: { gt: now },
        ...(excludePurchaseId ? { id: { not: excludePurchaseId } } : {}),
      },
    }),
  ]);
  return booked + guests + held;
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
    private readonly jwt: JwtService,
  ) {}

  onModuleInit() {
    this.targets.registerLive({
      verify: (paymentId, verifierId) => this.onPaymentVerified(paymentId, verifierId),
      reject: (paymentId, actorId, reason) => this.onPaymentRejected(paymentId, actorId, reason),
    });
  }

  // ── Pricing ─────────────────────────────────────────────────────────────

  /** Price a seat of this session now, under its academy's current terms. */
  private async price(
    session: LockedSession,
    db: Tx | PrismaService,
    discountCents = 0,
  ): Promise<{
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
   * A FREE session's seat: every amount zero. The terms version is recorded
   * only because every seat names one; no fee applies and none is owed.
   */
  private async freeSeat(
    session: LockedSession,
    db: Tx | PrismaService,
  ): Promise<{ breakdown: PriceBreakdown; feeRefundable: boolean }> {
    const terms = await this.terms.effectiveFor(
      session.academyId ?? session.tenantId,
      new Date(),
      db,
    );
    return {
      breakdown: {
        basePriceCents: 0,
        discountCents: 0,
        feeCents: 0,
        studentPaysCents: 0,
        commercialNetCents: 0,
        teacherCents: 0,
        centerCents: 0,
        feeType: terms.feeType,
        feeMode: terms.feeMode,
        feeBps: terms.feeBps,
        feeFixedCents: terms.feeFixedCents,
        termsVersionId: terms.id,
        teacherSharePercent: null,
      },
      feeRefundable: false,
    };
  }

  /**
   * A coupon for this seat, checked in full: it is this teacher's, made for
   * live seats (LIVE or ALL — a COURSE coupon never applies), for this session
   * if it names one, active, unexpired, not used up, and within its
   * per-student limit. The discount comes off the seller's price. A code that
   * fails any of it is refused with a reason, never silently ignored.
   */
  private async resolveLiveCoupon(
    db: Tx | PrismaService,
    s: LockedSession,
    code: string,
    studentId: string | null,
  ) {
    const coupon = await db.coupon.findFirst({
      where: { tenantId: s.tenantId, code: code.trim().toUpperCase(), deletedAt: null },
    });
    const refuse = (message: string, why: string) => {
      throw new BadRequestException({ message, code: 'COUPON_INVALID', reason: why });
    };
    if (!coupon || !coupon.isActive || coupon.scope === 'COURSE' || coupon.courseId)
      refuse('This code is not valid for this session', 'not-found');
    if (coupon!.liveSessionId && coupon!.liveSessionId !== s.id)
      refuse('This code is for another session', 'other-session');
    if (coupon!.expiresAt && coupon!.expiresAt <= new Date())
      refuse('This code has expired', 'expired');
    if (coupon!.maxUses != null && coupon!.usedCount >= coupon!.maxUses)
      refuse('This code has been used up', 'used-up');
    if (coupon!.maxUsesPerStudent != null && studentId) {
      const mine = await db.livePurchase.count({
        where: { couponId: coupon!.id, studentId, status: { in: ACTIVE } },
      });
      if (mine >= coupon!.maxUsesPerStudent)
        refuse('You have already used this code', 'per-student');
    }
    const base = s.priceCents as number;
    const discountCents = coupon!.percentOff
      ? mulDivRoundHalfUp(base, coupon!.percentOff, 100)
      : Math.min(coupon!.amountOffCents ?? 0, base);
    return { couponId: coupon!.id, maxUses: coupon!.maxUses, discountCents };
  }

  /** Price with a coupon, where a coupon that breaks the terms is the coupon's fault. */
  private async priceWithCoupon(
    db: Tx | PrismaService,
    s: LockedSession,
    code: string | undefined,
    studentId: string | null,
  ) {
    if (!code?.trim()) return { ...(await this.price(s, db)), coupon: null };
    const coupon = await this.resolveLiveCoupon(db, s, code, studentId);
    try {
      return { ...(await this.price(s, db, coupon.discountCents)), coupon };
    } catch (e) {
      if ((e as { response?: { code?: string } })?.response?.code === 'FEE_EXCEEDS_PRICE') {
        throw new BadRequestException({
          message: 'This code cannot be used on this session',
          code: 'COUPON_INVALID',
          reason: 'below-fee',
        });
      }
      throw e;
    }
  }

  /**
   * What a buyer sees before buying: the one number they pay, the seats left,
   * the refund and replay rules. Never the split — that is between Darsly and
   * the seller.
   */
  async quote(sessionId: string, studentUserId: string | null, couponCode?: string) {
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
    let mine: (ReturnType<LiveCommerceService['view']> & { paymentStage: string }) | null = null;
    if (studentUserId) {
      const student = await this.prisma.studentProfile.findUnique({
        where: { userId: studentUserId },
      });
      const p = student
        ? await this.prisma.livePurchase.findFirst({
            where: { sessionId, studentId: student.id },
            orderBy: { createdAt: 'desc' },
            include: { payment: true, refunds: true },
          })
        : null;
      mine = p ? { ...this.view(p), paymentStage: await this.paymentStage(p) } : null;
    }
    if (session.accessMode !== 'PAID') return { ...base, studentPaysCents: 0, purchase: mine };
    const { breakdown } = await this.price(session, this.prisma);
    if (!couponCode?.trim())
      return { ...base, studentPaysCents: breakdown.studentPaysCents, purchase: mine };
    // A preview only: the code is checked, nothing is reserved.
    const studentId = studentUserId
      ? ((
          await this.prisma.studentProfile.findUnique({
            where: { userId: studentUserId },
            select: { id: true },
          })
        )?.id ?? null)
      : null;
    const withCoupon = await this.priceWithCoupon(this.prisma, session, couponCode, studentId);
    return {
      ...base,
      studentPaysCents: withCoupon.breakdown.studentPaysCents,
      fullPriceCents: breakdown.studentPaysCents,
      discountCents: withCoupon.breakdown.discountCents,
      purchase: mine,
    };
  }

  // ── Buying ──────────────────────────────────────────────────────────────

  private async studentOf(userId: string) {
    const s = await this.prisma.studentProfile.findUnique({
      where: { userId },
      include: { user: { select: { fullName: true } } },
    });
    if (!s)
      throw new ForbiddenException({
        message: 'Only a student can buy a seat',
        code: 'NOT_A_STUDENT',
      });
    return s;
  }

  /** Whether this session can be sold to this buyer at all, right now. */
  private async assertBuyable(
    tx: Tx,
    s: LockedSession | null,
    studentId: string | null,
    now: Date,
    allowFree = false,
  ) {
    if (!s || s.deletedAt || s.cancelledAt) throw new NotFoundException('Session not found');
    if (s.accessMode !== 'PAID' && !allowFree)
      throw new BadRequestException({
        message: 'This session is free — book it instead',
        code: 'SESSION_IS_FREE',
      });
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
        throw new ForbiddenException({
          message: 'This session is for a group you are not in',
          code: 'NOT_IN_GROUP',
        });
    }
  }

  private async assertSeatFree(
    tx: Tx,
    s: LockedSession,
    now: Date,
    excludePurchaseId?: string,
    /** A student with an approved admission exception passes a full class (they still pay). */
    studentId?: string,
  ) {
    if (s.capacity == null) return;
    if ((await seatsTaken(tx, s.id, now, excludePurchaseId)) >= s.capacity) {
      if (studentId && (await hasAdmission(tx, s.id, studentId))) return;
      throw new ConflictException({ message: 'The session is full', code: 'SESSION_FULL' });
    }
  }

  private purchaseData(
    s: LockedSession,
    breakdown: PriceBreakdown,
    feeRefundable: boolean,
    buyer: { studentId: string } | { guestBuyerId: string },
  ) {
    return {
      sessionId: s.id,
      ...buyer,
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
   * Write a new purchase: HELD for a while (or until `holdUntilMs`), with its
   * coupon's use taken in the same transaction — or, when the coupon makes
   * the seat cost nothing, CONFIRMED at once with its seat. A 100%-off seat
   * of a PAID session is still a PAID purchase: no payment, no ledger, no
   * refund owed, and nothing to release.
   */
  private async createPurchase(
    tx: Tx,
    s: LockedSession,
    breakdown: PriceBreakdown,
    feeRefundable: boolean,
    coupon: { couponId: string; maxUses: number | null } | null,
    buyer: { studentId: string } | { guestBuyerId: string },
    now: Date,
    holdUntilMs?: number,
    extra: { accessTokenHash?: string } = {},
  ) {
    if (coupon) await reserveCouponUse(tx, coupon.couponId, coupon.maxUses);
    const free = breakdown.studentPaysCents === 0;
    const p = await tx.livePurchase.create({
      data: {
        ...this.purchaseData(s, breakdown, feeRefundable, buyer),
        couponId: coupon?.couponId ?? null,
        ...extra,
        ...(free
          ? { status: 'CONFIRMED' as const, confirmedAt: now, holdExpiresAt: null }
          : {
              status: 'HELD' as const,
              holdExpiresAt: new Date(
                Math.min(holdUntilMs ?? now.getTime() + holdMinutes() * 60_000, closesAtMs(s)),
              ),
            }),
      },
    });
    if (free && 'studentId' in buyer) {
      const booking = await tx.liveBooking.create({
        data: { sessionId: s.id, studentId: buyer.studentId, purchaseId: p.id },
      });
      await consumeAdmission(tx, s.id, buyer.studentId, { bookingId: booking.id, purchaseId: p.id });
    }
    return p;
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
  async hold(userId: string, sessionId: string, couponCode?: string) {
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
        await this.assertSeatFree(tx, s!, now, undefined, student.id);
        await this.supersedeStaleDeclarations(tx, sessionId, student.id);
        const { breakdown, feeRefundable, coupon } = await this.priceWithCoupon(
          tx,
          s!,
          couponCode,
          student.id,
        );
        return this.createPurchase(
          tx,
          s!,
          breakdown,
          feeRefundable,
          coupon,
          { studentId: student.id },
          now,
        );
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
   * A new checkout for a session makes an old, never-claimed declaration for
   * it moot: its hold lapsed and nobody said they paid. It is closed (REJECTED,
   * with the reason) so two open payments of one buyer never compete for the
   * same transfer — the new one is where a late SMS belongs. A declaration
   * already matched to a transfer, or claimed with proof, is left alone.
   */
  private async supersedeStaleDeclarations(tx: Tx, sessionId: string, studentId: string) {
    const stale = await tx.payment.findMany({
      where: {
        status: 'PENDING',
        claimedAt: null,
        livePurchase: { sessionId, studentId, status: 'EXPIRED' },
      },
      select: { id: true },
    });
    for (const p of stale) {
      const matched = await tx.paymentEvent.findFirst({
        where: { matchedPaymentId: p.id },
        select: { id: true },
      });
      if (matched) continue;
      await tx.payment.updateMany({
        where: { id: p.id, status: 'PENDING', claimedAt: null },
        data: {
          status: 'REJECTED',
          rejectedReason: 'superseded by a new checkout before any transfer was claimed',
        },
      });
    }
  }

  /**
   * A seat given back before any transfer was claimed takes its declaration
   * with it: an open PENDING payment would otherwise stay a candidate for a
   * transfer that now pays for nothing. If money does arrive after all, it is
   * unmatched and goes to finance (match elsewhere, or return it).
   */
  private async closeDeclaration(tx: Tx, purchaseId: string, why: string) {
    const d = await tx.payment.findUnique({
      where: { livePurchaseId: purchaseId },
      select: { id: true, status: true, claimedAt: true },
    });
    if (!d || d.status !== 'PENDING' || d.claimedAt) return;
    const matched = await tx.paymentEvent.findFirst({
      where: { matchedPaymentId: d.id },
      select: { id: true },
    });
    if (matched) return;
    await tx.payment.updateMany({
      where: { id: d.id, status: 'PENDING', claimedAt: null },
      data: { status: 'REJECTED', rejectedReason: why },
    });
  }

  /**
   * BEFORE the buyer is shown where to send money: say where it comes from.
   *
   * This writes the PENDING Payment for exactly the frozen price, with the
   * buyer's sending identity (their wallet number, or — for a bank / InstaPay
   * transfer — the account holder's name). From this moment the listener has a
   * candidate: an SMS that lands one second after the transfer finds the
   * payment already waiting, instead of a purchase with nothing to match
   * (which is what stranded the 27 Sep 2026 production test).
   *
   * Repeatable while nothing has been claimed or matched: a typo is fixed by
   * declaring again. The purchase stays HELD — the seat is still on its hold
   * clock until the buyer says they have transferred.
   */
  async declareTransfer(userId: string, purchaseId: string, dto: DeclareDto) {
    const student = await this.studentOf(userId);
    const pre = await this.prisma.livePurchase.findUnique({ where: { id: purchaseId } });
    if (!pre || pre.studentId !== student.id) throw new NotFoundException('Purchase not found');
    await this.declareFor(pre, student.id, dto);
    return this.byId(purchaseId);
  }

  async guestDeclareTransfer(raw: string, dto: DeclareDto) {
    const p = await this.guestPurchase(raw);
    await this.declareFor(p, null, dto);
    return this.guestStatus(raw);
  }

  private async declareFor(pre: LivePurchase, studentId: string | null, dto: DeclareDto) {
    if (!TRANSFER_METHODS.includes(dto.method as never)) {
      throw new BadRequestException({
        message: 'Choose which Darsly account you are sending to',
        code: 'METHOD_INVALID',
      });
    }
    const declared = normalizeDeclaration(dto, await this.receivingHandles());
    const paymentId = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const s = await lockSession(tx, pre.sessionId);
      const p = await lockPurchase(tx, pre.id);
      if (!p) throw new NotFoundException('Purchase not found');
      if (!s || s.deletedAt || s.cancelledAt) throw new NotFoundException('Session not found');
      if (
        p.status === 'EXPIRED' ||
        (p.status === 'HELD' && p.holdExpiresAt && p.holdExpiresAt <= now)
      ) {
        // Before any money moves, a lapsed hold is a new checkout, not a
        // declaration against a seat that is no longer theirs.
        throw new ConflictException({
          message: 'Your hold has expired — start again',
          code: 'HOLD_EXPIRED',
        });
      }
      if (p.status !== 'HELD') {
        throw new ConflictException({
          message: 'A payment for this seat was already sent',
          code: 'PAYMENT_ALREADY_SUBMITTED',
          status: p.status,
        });
      }
      const existing = await tx.payment.findUnique({ where: { livePurchaseId: p.id } });
      const fields = {
        method: dto.method as never,
        transferSource: declared.source,
        reference: declared.reference,
        payerName: declared.payerName,
      };
      if (existing) {
        const matched = await tx.paymentEvent.findFirst({
          where: { matchedPaymentId: existing.id },
          select: { id: true },
        });
        if (existing.status !== 'PENDING' || existing.claimedAt || matched) {
          throw new ConflictException({
            message: 'A payment for this seat was already sent',
            code: 'PAYMENT_ALREADY_SUBMITTED',
          });
        }
        await tx.payment.update({ where: { id: existing.id }, data: fields });
        return existing.id;
      }
      const payment = await tx.payment.create({
        data: {
          studentId,
          livePurchaseId: p.id,
          tenantId: p.tenantId,
          academyId: p.academyId,
          amountCents: p.studentPaysCents,
          feeCents: p.feeCents,
          netCents: p.teacherCents + p.centerCents,
          currency: p.currency,
          gateway: 'manual',
          status: 'PENDING',
          ...fields,
        },
      });
      return payment.id;
    });
    // They may have transferred before declaring: an SMS already here is
    // decided now, by the same policy as one that arrives later.
    await this.matching
      .reconcilePayment(paymentId)
      .catch((e) =>
        this.logger.warn(`live.reconcile payment=${paymentId} failed: ${(e as Error).message}`),
      );
  }

  /**
   * The buyer says they have transferred the money: here is the proof. It is
   * attached to the payment they declared (or, for a client that skipped the
   * declaration, a PENDING Payment is created now exactly as before), and the
   * seat is kept for them until the class ends while it is verified. The
   * proof is evidence, never verification.
   */
  async submitTransfer(userId: string, purchaseId: string, dto: TransferClaimDto) {
    const student = await this.studentOf(userId);
    const pre = await this.prisma.livePurchase.findUnique({ where: { id: purchaseId } });
    if (!pre || pre.studentId !== student.id) throw new NotFoundException('Purchase not found');
    await this.submitTransferFor(pre, student.id, dto);
    return this.byId(purchaseId);
  }

  /** Shared by students and guests. */
  private async submitTransferFor(
    pre: LivePurchase,
    studentId: string | null,
    dto: TransferClaimDto,
  ) {
    const purchaseId = pre.id;
    const handles = await this.receivingHandles();
    const declared = await this.prisma.payment.findUnique({
      where: { livePurchaseId: purchaseId },
    });
    if (declared && declared.status === 'PAID') return; // the SMS beat the proof: already confirmed
    if (declared && (declared.status !== 'PENDING' || declared.claimedAt)) {
      throw new ConflictException({
        message: 'A payment for this seat was already sent',
        code: 'PAYMENT_ALREADY_SUBMITTED',
      });
    }
    // Without a declaration (an older client), the identity comes with the proof.
    let identity: {
      method: string;
      transferSource: 'WALLET' | 'BANK' | null;
      reference: string;
      payerName: string | null;
    } | null = null;
    if (!declared) {
      if (!TRANSFER_METHODS.includes(dto.method as never)) {
        throw new BadRequestException({
          message: 'Choose how you transferred',
          code: 'METHOD_INVALID',
        });
      }
      if (dto.source) {
        const d = normalizeDeclaration({ ...dto, source: dto.source }, handles);
        identity = {
          method: dto.method as string,
          transferSource: d.source,
          reference: d.reference,
          payerName: d.payerName,
        };
      } else {
        const reference = normalizePayerReference(dto.method as never, dto.reference, handles);
        identity = {
          method: dto.method as string,
          transferSource: dto.method === 'VODAFONE_CASH' ? 'WALLET' : null,
          reference,
          payerName: null,
        };
      }
    }
    const reading = await this.proofReader.read(dto.proofImageUrl ?? '');
    const check = checkProofAgainstClaim(reading, { amountCents: pre.studentPaysCents }, handles);
    if (check.verdict === 'DISAGREES') {
      throw new BadRequestException({
        message: check.problems.join(' '),
        code: 'PROOF_DISAGREES',
        problems: check.problems,
      });
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
          throw new ConflictException({
            message: 'A payment for this seat was already sent',
            code: 'PAYMENT_ALREADY_SUBMITTED',
          });
        }
        if (p.status !== 'HELD' && p.status !== 'EXPIRED') {
          throw new ConflictException({
            message: 'This purchase is closed',
            code: 'PURCHASE_CLOSED',
            status: p.status,
          });
        }
        if (!s || s.deletedAt || s.cancelledAt) throw new NotFoundException('Session not found');
        if (p.status === 'EXPIRED' && studentId) {
          // Their hold lapsed, but they may already have transferred: the
          // money is accepted either way. If another purchase of theirs is
          // live they should use that one.
          const other = await tx.livePurchase.findFirst({
            where: { sessionId: p.sessionId, studentId, status: { in: ACTIVE }, id: { not: p.id } },
          });
          if (other)
            throw new ConflictException({
              message: 'You have another purchase for this session',
              code: 'ANOTHER_PURCHASE_ACTIVE',
            });
        }
        // Keep (or retake) the seat until the class ends while the payment is
        // verified. If the class has filled meanwhile, the payment is still
        // taken — verification then gives the seat if one opened, or refunds.
        let keep: Date | null = new Date(closesAtMs(s));
        if (p.status === 'EXPIRED' || (p.holdExpiresAt && p.holdExpiresAt <= now)) {
          const full =
            s.capacity != null &&
            (await seatsTaken(tx, s.id, now, p.id)) >= s.capacity &&
            !(await hasAdmission(tx, s.id, p.studentId));
          const over = now.getTime() >= closesAtMs(s);
          if (full || over) keep = null;
        }
        assertTransition(p.status, 'PAYMENT_PENDING');
        let id: string;
        if (declared) {
          // Claimed exactly once: only a still-open, still-unclaimed declaration flips.
          const flip = await tx.payment.updateMany({
            where: { id: declared.id, status: 'PENDING', claimedAt: null },
            data: {
              proofImageUrl: proofKey,
              proofReading: (reading ?? undefined) as never,
              claimedAt: now,
            },
          });
          if (flip.count === 0) {
            throw new ConflictException({
              message: 'A payment for this seat was already sent',
              code: 'PAYMENT_ALREADY_SUBMITTED',
            });
          }
          id = declared.id;
        } else {
          const payment = await tx.payment.create({
            data: {
              studentId,
              livePurchaseId: p.id,
              tenantId: p.tenantId,
              academyId: p.academyId,
              amountCents: p.studentPaysCents,
              feeCents: p.feeCents,
              netCents: p.teacherCents + p.centerCents,
              currency: p.currency,
              gateway: 'manual',
              method: identity!.method as never,
              transferSource: identity!.transferSource,
              payerName: identity!.payerName,
              proofImageUrl: proofKey,
              proofReading: (reading ?? undefined) as never,
              reference: identity!.reference,
              claimedAt: now,
              status: 'PENDING',
            },
          });
          id = payment.id;
        }
        await tx.livePurchase.update({
          where: { id: p.id },
          data: { status: 'PAYMENT_PENDING', holdExpiresAt: keep },
        });
        return id;
      });
    } catch (e) {
      await this.proofs.discard(proofKey).catch(() => undefined);
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({
          message: 'A payment for this seat was already sent',
          code: 'PAYMENT_ALREADY_SUBMITTED',
        });
      }
      throw e;
    }
    // Buyers often transfer first and fill the form after: an SMS that is
    // already here is decided now instead of waiting for a human.
    await this.matching
      .reconcilePayment(paymentId)
      .catch((e) =>
        this.logger.warn(`live.reconcile payment=${paymentId} failed: ${(e as Error).message}`),
      );
  }

  private receivingHandles(): Promise<string[]> {
    return receivingHandles(this.prisma);
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
  async payWithWallet(userId: string, sessionId: string, couponCode?: string) {
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
                throw new ConflictException({
                  message: 'A transfer for this seat is being verified',
                  code: 'PAYMENT_ALREADY_SUBMITTED',
                });
              return { purchaseId: p.id, already: true };
            }
            await this.assertBuyable(tx, s, student.id, now);
            if (p) {
              // A transfer already declared for this seat may be on its way:
              // paying again from the wallet could take the money twice.
              const declared = await tx.payment.findUnique({
                where: { livePurchaseId: p.id },
                select: { id: true },
              });
              if (declared)
                throw new ConflictException({
                  message: 'You already started a transfer for this seat',
                  code: 'TRANSFER_ALREADY_STARTED',
                });
              // They held a seat for a transfer, then chose the wallet: the
              // same purchase and the same frozen price, paid differently.
              if (!p.holdExpiresAt || p.holdExpiresAt <= now)
                await this.assertSeatFree(tx, s!, now, p.id, student.id);
            } else {
              await this.assertSeatFree(tx, s!, now, undefined, student.id);
              const { breakdown, feeRefundable, coupon } = await this.priceWithCoupon(
                tx,
                s!,
                couponCode,
                student.id,
              );
              p = await this.createPurchase(
                tx,
                s!,
                breakdown,
                feeRefundable,
                coupon,
                { studentId: student.id },
                now,
                closesAtMs(s!),
              );
              // A 100%-off seat is already confirmed: nothing to pay.
              if (p.status === 'CONFIRMED') return { purchaseId: p.id, already: false };
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
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            timeout: 20_000,
            maxWait: 10_000,
          },
        );
        if (out.paymentId) await this.afterConfirmed(out.purchaseId, out.paymentId);
        return this.byId(out.purchaseId);
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          (e.code === 'P2034' || e.code === 'P2002') &&
          attempt < 4
        ) {
          continue;
        }
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2034') {
          throw new ConflictException({
            message: 'Busy — please try again',
            code: 'WALLET_CONCURRENT_WRITE',
          });
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
        data: {
          status: 'CANCELLED_BY_TEACHER',
          cancelledAt: now,
          holdExpiresAt: null,
          cancelReason: 'session cancelled',
        },
      });
      await this.fullRefund(tx, p.id, 'TEACHER_CANCEL', verifierId);
      return 'CANCELLED_BY_TEACHER';
    }
    // Their own unexpired hold is their seat; otherwise one must still be free
    // and the class still ahead. Money that finds no seat is not kept.
    const holding = p.holdExpiresAt != null && p.holdExpiresAt > now && HOLDING.includes(p.status);
    const over = s.status === 'ENDED' || now.getTime() >= closesAtMs(s);
    const full =
      s.capacity != null &&
      (await seatsTaken(tx, s.id, now, p.id)) >= s.capacity &&
      !(await hasAdmission(tx, s.id, p.studentId));
    if (!holding && (over || full)) {
      assertTransition(p.status, 'OVERSOLD');
      await tx.livePurchase.update({
        where: { id: p.id },
        data: {
          status: 'OVERSOLD',
          holdExpiresAt: null,
          reviewReason: over ? 'class already over' : 'class full',
        },
      });
      await releaseCouponUse(tx, p.couponId);
      await this.fullRefund(tx, p.id, 'OVERSOLD', verifierId);
      return 'OVERSOLD';
    }
    assertTransition(p.status, 'CONFIRMED');
    await tx.livePurchase.update({
      where: { id: p.id },
      data: { status: 'CONFIRMED', confirmedAt: now, holdExpiresAt: null },
    });
    // A student's seat is their LiveBooking; a guest's is the confirmed
    // purchase itself (counted by seatsTaken, checked by guestSeat).
    if (p.studentId) {
      const booking = await tx.liveBooking.create({
        data: { sessionId: s.id, studentId: p.studentId, purchaseId: p.id },
      });
      await consumeAdmission(tx, s.id, p.studentId, { bookingId: booking.id, purchaseId: p.id });
    }
    return 'CONFIRMED';
  }

  async onPaymentVerified(
    paymentId: string,
    verifierId: string,
  ): Promise<{ ok: true; alreadyHandled?: boolean }> {
    const pay = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: {
        id: true,
        status: true,
        livePurchaseId: true,
        livePurchase: { select: { sessionId: true } },
      },
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

  async onPaymentRejected(
    paymentId: string,
    actorId: string,
    reason?: string,
  ): Promise<{ ok: true }> {
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
      if (flip.count === 0)
        throw new BadRequestException({ message: 'Payment is not pending', code: 'NOT_PENDING' });
      if (p && (p.status === 'PAYMENT_PENDING' || p.status === 'HELD')) {
        await tx.livePurchase.update({
          where: { id: p.id },
          data: {
            status: 'PAYMENT_REJECTED',
            holdExpiresAt: null,
            reviewReason: reason?.trim() || null,
          },
        });
        await releaseCouponUse(tx, p.couponId);
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
    const p = await tx.livePurchase.findUniqueOrThrow({
      where: { id: purchaseId },
      include: { payment: true },
    });
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
    destination?: { method: PayoutMethod; details: { holderName: string; handle: string } },
  ) {
    const amount = parts.fee + parts.teacher + parts.center;
    // Nothing was paid (a free seat of a paid session) or nothing is left:
    // there is nothing to return, and a zero refund is not a record.
    if (amount <= 0 || !p.payment || p.payment.status !== 'PAID') return null;
    const existing = await tx.refund.findUnique({
      where: { livePurchaseId_reason: { livePurchaseId: p.id, reason } },
    });
    if (existing) return existing;
    if (!p.studentId) {
      // A guest has no wallet: the refund is owed, and Darsly finance sends it
      // by hand to an account the guest names. Nothing moves in the ledger
      // until finance marks it transferred; until then the money stays held
      // (and is never released to the seller, being already promised back).
      await this.revokeGuestAccess(tx, p);
      return tx.refund.create({
        data: {
          livePurchaseId: p.id,
          paymentId: p.payment.id,
          reason,
          destination: 'MANUAL_TRANSFER',
          status: 'REQUESTED',
          amountCents: amount,
          feeRefundCents: parts.fee,
          teacherRefundCents: parts.teacher,
          centerRefundCents: parts.center,
          requestedById: actorId,
          ...(destination
            ? {
                destinationMethod: destination.method,
                destinationDetails: destination.details as never,
              }
            : {}),
        },
      });
    }
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
          // A late cancellation's retained part — unless it is already waiting
          // for a person (below), so it never occupies the sweep for ever.
          {
            status: 'CANCELLED_BY_STUDENT',
            reviewReason: null,
            session: { status: 'ENDED', cancelledAt: null },
          },
          // Never started, and well past its end: a no-show to be reviewed.
          {
            status: 'CONFIRMED',
            session: {
              status: 'SCHEDULED',
              startedAt: null,
              startsAt: { lt: new Date(now.getTime() - NO_SHOW_GRACE_MS) },
            },
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
          if (p.status !== 'CONFIRMED' || closesAtMs(s) + NO_SHOW_GRACE_MS > now.getTime())
            return null;
          assertTransition(p.status, 'NEEDS_REVIEW');
          await tx.livePurchase.update({
            where: { id: p.id },
            data: { status: 'NEEDS_REVIEW', reviewReason: 'never started' },
          });
          return 'review' as const;
        }
        const verdict = deliveryVerdict(s);
        if (verdict.delivered) {
          if (p.status !== 'CONFIRMED' && p.status !== 'CANCELLED_BY_STUDENT') return null;
          return (await this.releaseInTx(tx, p, now)) ? ('released' as const) : null;
        }
        if (p.status === 'CONFIRMED') {
          assertTransition(p.status, 'NEEDS_REVIEW');
          await tx.livePurchase.update({
            where: { id: p.id },
            data: { status: 'NEEDS_REVIEW', reviewReason: verdict.reason },
          });
          return 'review' as const;
        }
        if (p.status === 'CANCELLED_BY_STUDENT') {
          // What a late canceller did not get back, for a class that was not
          // really delivered: a person decides (release or refund it).
          await tx.livePurchase.update({
            where: { id: p.id },
            data: { reviewReason: verdict.reason },
          });
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
      const underReview =
        p.status === 'NEEDS_REVIEW' || (p.status === 'CANCELLED_BY_STUDENT' && p.reviewReason);
      if (!underReview)
        throw new ConflictException({
          message: 'Only a purchase under review is released by hand',
          code: 'PURCHASE_STATE_CONFLICT',
        });
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
        throw new ConflictException({
          message: 'Earnings were already released for this purchase',
          code: 'ALREADY_RELEASED',
        });
      if (p.status === 'CANCELLED_BY_STUDENT' && p.reviewReason) {
        // The retained part of a late cancellation, returned after all.
        await this.fullRefund(tx, p.id, 'ADMIN', adminId);
        await tx.livePurchase.update({
          where: { id: p.id },
          data: { reviewReason: `${p.reviewReason}; refunded` },
        });
        return;
      }
      if (p.status !== 'NEEDS_REVIEW' && p.status !== 'CONFIRMED')
        throw new ConflictException({
          message: 'This purchase cannot be refunded by hand',
          code: 'PURCHASE_STATE_CONFLICT',
        });
      await tx.liveBooking.deleteMany({ where: { purchaseId: p.id } });
      // A guest's refund is sent by hand, so it is pending until finance
      // marks the transfer done; a student's lands in the wallet now.
      const to = p.guestBuyerId ? 'REFUND_PENDING' : 'REFUNDED';
      assertTransition(p.status, to);
      await tx.livePurchase.update({
        where: { id: p.id },
        data: { status: to, cancelledAt: new Date(), cancelReason: reason },
      });
      await this.fullRefund(tx, p.id, reason, adminId);
    });
    await this.audit(adminId, 'live.purchase.refund', purchaseId, { reason });
    return this.byId(purchaseId);
  }

  pendingEarnings(where: { academyId: string; tenantId?: string }, side: 'teacher' | 'center') {
    return livePendingEarnings(this.prisma, where, side);
  }

  private async audit(
    actorUserId: string,
    action: string,
    entityId: string,
    meta: Record<string, unknown>,
  ) {
    await this.prisma.auditLog
      .create({
        data: { actorUserId, action, entity: 'LivePurchase', entityId, meta: meta as never },
      })
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
      const p = await tx.livePurchase.findUniqueOrThrow({
        where: { id: purchaseId },
        include: { payment: true },
      });
      if (p.status === 'CANCELLED_BY_STUDENT') return;
      if (p.status === 'PAYMENT_PENDING')
        throw new ConflictException({
          message: 'Your payment is being verified — it cannot be cancelled now',
          code: 'PAYMENT_UNDER_REVIEW',
        });
      if (p.status !== 'HELD' && p.status !== 'CONFIRMED')
        throw new ConflictException({
          message: 'This purchase cannot be cancelled',
          code: 'PURCHASE_STATE_CONFLICT',
          status: p.status,
        });
      if (!s) throw new NotFoundException('Session not found');
      if (
        p.status === 'CONFIRMED' &&
        (s.status !== 'SCHEDULED' || now.getTime() >= s.startsAt.getTime())
      ) {
        throw new ConflictException({
          message: 'لا يمكن إلغاء الحجز بعد بدء الحصة',
          code: 'CANCEL_WINDOW_CLOSED',
        });
      }
      assertTransition(p.status, 'CANCELLED_BY_STUDENT');
      await tx.liveBooking.deleteMany({ where: { purchaseId: p.id } });
      await tx.livePurchase.update({
        where: { id: p.id },
        data: {
          status: 'CANCELLED_BY_STUDENT',
          cancelledAt: now,
          holdExpiresAt: null,
          cancelReason: 'student',
        },
      });
      if (p.status === 'HELD') {
        await releaseCouponUse(tx, p.couponId);
        await this.closeDeclaration(tx, p.id, 'the buyer cancelled before claiming a transfer');
      }
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
  async onSessionCancelled(
    sessionId: string,
    actorId: string | null,
  ): Promise<{ refunded: number }> {
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
            data: {
              status: 'CANCELLED_BY_TEACHER',
              cancelledAt: now,
              holdExpiresAt: null,
              cancelReason: 'session cancelled',
            },
          });
          await releaseCouponUse(tx, p.couponId);
          await this.closeDeclaration(
            tx,
            p.id,
            'the session was cancelled before a transfer was claimed',
          );
          return false;
        }
        if (p.status === 'CONFIRMED' || p.status === 'NEEDS_REVIEW') {
          await tx.liveBooking.deleteMany({ where: { purchaseId: p.id } });
          await tx.livePurchase.update({
            where: { id: p.id },
            data: {
              status: 'CANCELLED_BY_TEACHER',
              cancelledAt: now,
              cancelReason: 'session cancelled',
            },
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
        if (!p || p.status !== 'HELD' || !p.holdExpiresAt || p.holdExpiresAt > new Date())
          return false;
        await tx.livePurchase.update({
          where: { id: p.id },
          data: { status: 'EXPIRED', holdExpiresAt: null },
        });
        // The seat was never paid for: its coupon use goes back.
        await releaseCouponUse(tx, p.couponId);
        return true;
      });
      if (done) expired++;
    }
    return expired;
  }

  // ── Guests: a paid seat without an account ──────────────────────────────

  /** SHA-256 of a raw access secret — the only form in which it is stored. */
  static hashToken(raw: string) {
    return createHash('sha256').update(raw, 'utf8').digest('hex');
  }

  /**
   * A guest's purchase, by its access secret. An unknown secret and a
   * malformed one get the same answer as each other, so a probe learns
   * nothing about which secrets exist.
   */
  private async guestPurchase(raw: string) {
    const ok = typeof raw === 'string' && /^[A-Za-z0-9_-]{43}$/.test(raw);
    const p = ok
      ? await this.prisma.livePurchase.findUnique({
          where: { accessTokenHash: LiveCommerceService.hashToken(raw) },
          include: { payment: true, refunds: true, guestBuyer: true },
        })
      : null;
    if (!p || !p.guestBuyer)
      throw new NotFoundException({ message: 'Not found', code: 'ACCESS_NOT_FOUND' });
    return p as typeof p & { guestBuyer: NonNullable<typeof p.guestBuyer> };
  }

  /**
   * What anyone may read about a public session: a PAID one to buy a seat on,
   * or a FREE one to take a seat on. A group's class is for its group and is
   * never public. The state is the server's (it owns the clock): whether the
   * doors are open, whether the teacher has started, whether it is over.
   */
  async publicOffer(sessionId: string) {
    const [s] = await this.prisma.$queryRaw<
      (LockedSession & { description: string; teacherName: string })[]
    >`
      SELECT s.id, s."tenantId", s."academyId", s."groupId", s.title, s.description, s.status::text AS status,
             s."startsAt", s."durationMin", s.capacity, s."accessMode"::text AS "accessMode", s."priceCents",
             s.currency, s."refundPolicy"::text AS "refundPolicy", s."replayPolicy"::text AS "replayPolicy",
             s."replayDays", s."startedAt", s."endedAt", s."cancelledAt", s."deletedAt", u."fullName" AS "teacherName"
      FROM "LiveSession" s JOIN "TeacherProfile" t ON t.id = s."tenantId" JOIN "User" u ON u.id = t."userId"
      WHERE s.id = ${sessionId}`;
    if (!s || s.deletedAt || s.cancelledAt || s.groupId) {
      throw new NotFoundException('Session not found');
    }
    const q = await this.quote(sessionId, null);
    const now = Date.now();
    const closesAt = closesAtMs(s);
    return {
      id: s.id,
      title: s.title,
      description: s.description,
      teacherName: s.teacherName,
      startsAt: s.startsAt,
      durationMin: s.durationMin,
      status: s.status,
      live: s.status === 'LIVE' && now < closesAt,
      joinOpensAt: new Date(s.startsAt.getTime() - 15 * 60_000),
      closesAt: new Date(closesAt),
      serverNow: new Date(now),
      ...q,
    };
  }

  /**
   * A guest takes a seat. Only a display name is asked; a GUEST user (no
   * email, phone, username or password — it can never sign in) and a
   * GuestBuyer are made for them, and the seat is held exactly as a
   * student's is. The access secret is 256 random bits, returned once and
   * stored only as its SHA-256.
   */
  async guestHold(sessionId: string, displayName: string, couponCode?: string) {
    const name = (displayName ?? '').replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 60) {
      throw new BadRequestException({
        message: 'Enter your name (2–60 characters)',
        code: 'GUEST_NAME_INVALID',
      });
    }
    await this.publicOffer(sessionId);
    const raw = randomBytes(32).toString('base64url');
    const now = new Date();
    const purchase = await this.prisma.$transaction(async (tx) => {
      const s = await lockSession(tx, sessionId);
      await this.assertBuyable(tx, s, null, now, true);
      if (s!.groupId) throw new NotFoundException('Session not found');
      await this.assertSeatFree(tx, s!, now);
      // A free class: a zero seat, confirmed at once — no coupon, no payment.
      const { breakdown, feeRefundable, coupon } =
        s!.accessMode === 'PAID'
          ? await this.priceWithCoupon(tx, s!, couponCode, null)
          : { ...(await this.freeSeat(s!, tx)), coupon: null };
      const user = await tx.user.create({ data: { role: 'GUEST', fullName: name } });
      const guest = await tx.guestBuyer.create({ data: { userId: user.id, displayName: name } });
      return this.createPurchase(
        tx,
        s!,
        breakdown,
        feeRefundable,
        coupon,
        { guestBuyerId: guest.id },
        now,
        undefined,
        {
          accessTokenHash: LiveCommerceService.hashToken(raw),
        },
      );
    });
    return { accessToken: raw, purchase: await this.byId(purchase.id) };
  }

  /** The guest's page: their purchase and the class, nothing more. */
  async guestStatus(raw: string) {
    const p = await this.guestPurchase(raw);
    const s = await this.prisma.$queryRaw<LockedSession[]>`
      SELECT id, "tenantId", "academyId", "groupId", title, status::text AS status, "startsAt",
             "durationMin", capacity, "accessMode"::text AS "accessMode", "priceCents", currency,
             "refundPolicy"::text AS "refundPolicy", "replayPolicy"::text AS "replayPolicy",
             "replayDays", "startedAt", "endedAt", "cancelledAt", "deletedAt"
      FROM "LiveSession" WHERE id = ${p.sessionId}`;
    const session = s[0];
    const now = Date.now();
    const joinOpensAt = session.startsAt.getTime() - 15 * 60_000;
    return {
      ...this.view(p),
      guestName: p.guestBuyer.displayName,
      // What a refund still needs from the guest, if one is owed.
      refunds: p.refunds.map((r) => ({
        id: r.id,
        reason: r.reason,
        status: r.status,
        amountCents: r.amountCents,
        needsDestination: r.status === 'REQUESTED' && !r.destinationMethod,
        destinationMethod: r.destinationMethod,
        createdAt: r.createdAt,
        completedAt: r.completedAt,
      })),
      session: {
        id: session.id,
        title: session.title,
        startsAt: session.startsAt,
        durationMin: session.durationMin,
        status: session.status,
        accessMode: session.accessMode,
        cancelled: !!(session.cancelledAt || session.deletedAt),
        joinOpensAt: new Date(joinOpensAt),
        closesAt: new Date(closesAtMs(session)),
        live: session.status === 'LIVE' && now < closesAtMs(session),
        over: session.status === 'ENDED' || now >= closesAtMs(session),
      },
      serverNow: new Date(now),
      free: p.basePriceCents === 0,
      paymentStage: await this.paymentStage(p),
      canEnter:
        p.status === 'CONFIRMED' &&
        !session.cancelledAt &&
        !session.deletedAt &&
        session.status === 'LIVE' &&
        now >= joinOpensAt &&
        now < closesAtMs(session),
    };
  }

  /** The guest's transfer proof — the same path, and the same rules, as a student's. */
  async guestSubmitTransfer(raw: string, dto: TransferClaimDto) {
    const p = await this.guestPurchase(raw);
    await this.submitTransferFor(p, null, dto);
    return this.guestStatus(raw);
  }

  /**
   * A short-lived token for the classroom of this one session, for a guest
   * whose seat is confirmed (or whose class was delivered — its chat and a
   * replay the seat includes). Refused once the purchase is cancelled or
   * refunded; and every token already issued dies then too, because the
   * guest's device sessions are revoked with the refund.
   */
  async guestClassroomToken(raw: string) {
    const p = await this.guestPurchase(raw);
    if (!['CONFIRMED', 'DELIVERED', 'NEEDS_REVIEW'].includes(p.status)) {
      throw new ForbiddenException({ message: 'This seat is not active', code: 'SEAT_NOT_ACTIVE' });
    }
    const s = await this.prisma.liveSession.findUnique({
      where: { id: p.sessionId },
      select: { id: true },
    });
    if (!s)
      throw new ForbiddenException({ message: 'This seat is not active', code: 'SEAT_NOT_ACTIVE' });
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: p.guestBuyer.userId } });
    const device = await this.prisma.deviceSession.create({
      data: {
        userId: user.id,
        // A guest never gets a refresh token: this hash matches nothing.
        refreshTokenHash: `guest:${randomBytes(16).toString('hex')}`,
        deviceName: 'guest classroom',
      },
    });
    const ttl = Number(process.env.JWT_ACCESS_TTL) > 0 ? Number(process.env.JWT_ACCESS_TTL) : 900;
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, role: 'GUEST', sessionId: device.id, liveSessionId: p.sessionId },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: ttl, algorithm: 'HS256' },
    );
    return {
      accessToken,
      expiresInSec: ttl,
      liveSessionId: p.sessionId,
      user: { id: user.id, role: 'GUEST' as const, fullName: user.fullName },
    };
  }

  /** Every classroom token a guest holds stops working (refund, cancellation). */
  private async revokeGuestAccess(tx: Tx, p: Pick<LivePurchase, 'guestBuyerId'>) {
    if (!p.guestBuyerId) return;
    const g = await tx.guestBuyer.findUnique({
      where: { id: p.guestBuyerId },
      select: { userId: true },
    });
    if (!g) return;
    await tx.deviceSession.updateMany({
      where: { userId: g.userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'LIVE_SEAT_REFUNDED' },
    });
  }

  private refundDestination(dto: { method?: string; holderName?: string; handle?: string }) {
    const method = dto.method as PayoutMethod;
    if (!['INSTAPAY', 'VODAFONE_CASH', 'BANK_TRANSFER'].includes(method))
      throw new BadRequestException({
        message: 'Choose how to receive the refund',
        code: 'REFUND_METHOD_INVALID',
      });
    const holderName = (dto.holderName ?? '').trim().slice(0, 80);
    const handle = (dto.handle ?? '').replace(/\s+/g, '').slice(0, 64);
    if (holderName.length < 2 || handle.length < 4)
      throw new BadRequestException({
        message: 'Enter the account name and number',
        code: 'REFUND_DESTINATION_INVALID',
      });
    if (method === 'VODAFONE_CASH' && !/^01[0125]\d{8}$/.test(handle.replace(/^\+?20/, '0')))
      throw new BadRequestException({
        message: 'Enter the wallet number (01xxxxxxxxx)',
        code: 'REFUND_DESTINATION_INVALID',
      });
    return { method, details: { holderName, handle } };
  }

  /**
   * A guest gives the seat back (same windows as a student). What is owed is
   * recorded as a refund request carrying the account they want it sent to;
   * the seat and any classroom token go at once.
   */
  async guestCancel(raw: string, dto: { method?: string; holderName?: string; handle?: string }) {
    const pre = await this.guestPurchase(raw);
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const s = await lockSession(tx, pre.sessionId);
      await lockPurchase(tx, pre.id);
      const p = await tx.livePurchase.findUniqueOrThrow({
        where: { id: pre.id },
        include: { payment: true },
      });
      if (p.status === 'CANCELLED_BY_STUDENT') return;
      if (p.status === 'PAYMENT_PENDING')
        throw new ConflictException({
          message: 'Your payment is being verified — it cannot be cancelled now',
          code: 'PAYMENT_UNDER_REVIEW',
        });
      if (p.status !== 'HELD' && p.status !== 'CONFIRMED')
        throw new ConflictException({
          message: 'This purchase cannot be cancelled',
          code: 'PURCHASE_STATE_CONFLICT',
          status: p.status,
        });
      if (!s) throw new NotFoundException('Session not found');
      if (
        p.status === 'CONFIRMED' &&
        (s.status !== 'SCHEDULED' || now.getTime() >= s.startsAt.getTime())
      )
        throw new ConflictException({
          message: 'لا يمكن إلغاء الحجز بعد بدء الحصة',
          code: 'CANCEL_WINDOW_CLOSED',
        });
      let destination: ReturnType<LiveCommerceService['refundDestination']> | undefined;
      let parts = { fee: 0, teacher: 0, center: 0 };
      if (p.status === 'CONFIRMED') {
        const remaining = await this.remainingParts(tx, p);
        const { inWindow, ...pp } = this.studentRefundParts(p, remaining, s.startsAt, now);
        void inWindow;
        parts = pp;
        if (pp.fee + pp.teacher + pp.center > 0) destination = this.refundDestination(dto);
      }
      assertTransition(p.status, 'CANCELLED_BY_STUDENT');
      await tx.livePurchase.update({
        where: { id: p.id },
        data: {
          status: 'CANCELLED_BY_STUDENT',
          cancelledAt: now,
          holdExpiresAt: null,
          cancelReason: 'guest',
        },
      });
      await this.revokeGuestAccess(tx, p);
      if (p.status === 'HELD') {
        await releaseCouponUse(tx, p.couponId);
        await this.closeDeclaration(tx, p.id, 'the buyer cancelled before claiming a transfer');
      }
      if (p.status === 'CONFIRMED')
        await this.refundParts(tx, p, 'STUDENT_CANCEL', parts, null, destination);
    });
    return this.guestStatus(raw);
  }

  /** Where a guest wants an owed refund sent (a teacher's cancellation, an oversold seat). */
  async guestRefundDestination(
    raw: string,
    refundId: string,
    dto: { method?: string; holderName?: string; handle?: string },
  ) {
    const p = await this.guestPurchase(raw);
    const d = this.refundDestination(dto);
    const r = await this.prisma.refund.updateMany({
      where: { id: refundId, livePurchaseId: p.id, status: 'REQUESTED' },
      data: { destinationMethod: d.method, destinationDetails: d.details as never },
    });
    if (r.count === 0)
      throw new NotFoundException({ message: 'Not found', code: 'REFUND_NOT_FOUND' });
    return this.guestStatus(raw);
  }

  // ── Finance: money that arrived with nothing to match ───────────────────

  /**
   * Seats a transfer could pay for, for the recovery screen: a purchase that
   * never got a Payment (the buyer's form failed, or they never finished it),
   * still HELD or already EXPIRED, whose frozen price is exactly this amount.
   */
  async recoveryCandidates(amountCents: number) {
    const rows = await this.prisma.livePurchase.findMany({
      where: {
        status: { in: ['HELD', 'EXPIRED'] },
        studentPaysCents: amountCents,
        payment: { is: null },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        session: {
          select: {
            id: true,
            title: true,
            startsAt: true,
            durationMin: true,
            status: true,
            cancelledAt: true,
          },
        },
        student: { select: { user: { select: { fullName: true } } } },
        guestBuyer: { select: { displayName: true } },
      },
    });
    const now = Date.now();
    return rows.map((p) => ({
      purchaseId: p.id,
      status: p.status,
      createdAt: p.createdAt,
      studentPaysCents: p.studentPaysCents,
      buyerName: p.student?.user.fullName ?? p.guestBuyer?.displayName ?? null,
      guest: !!p.guestBuyerId,
      session: {
        id: p.session.id,
        title: p.session.title,
        startsAt: p.session.startsAt,
        status: p.session.status,
        cancelled: !!p.session.cancelledAt,
        // Money attached to a class that is over becomes a refund, not a seat.
        over: p.session.status === 'ENDED' || now >= closesAtMs(p.session),
      },
    }));
  }

  /**
   * Recovery: a transfer arrived for a seat whose buyer never got a Payment
   * written (the incident of 27 Sep 2026). Darsly finance attaches it.
   *
   * In ONE transaction, under the session lock then the purchase lock: the
   * purchase must still have no payment and be HELD or EXPIRED, the amount must
   * be its frozen price to the piaster, the transfer must be on a transfer rail
   * and still unclaimed. A PENDING Payment is created for it, the transfer is
   * claimed by compare-and-swap (so it cannot also be matched or returned),
   * and the purchase moves to PAYMENT_PENDING — the same shape a buyer's own
   * claim produces. Then the ORDINARY admin verification runs: capacity is
   * checked, a class that is already over (or full) turns the money into a
   * full refund, the ledger is booked by the usual path. Nothing here grants
   * a seat by itself.
   *
   * A retry after success finds the payment already tied to this transfer
   * and returns the purchase as it is; any other state is refused.
   */
  async adminAttachTransfer(eventId: string, purchaseId: string, adminId: string, reason: string) {
    const why = (reason ?? '').trim().slice(0, 300);
    if (why.length < 3)
      throw new BadRequestException({ message: 'Say why', code: 'REASON_REQUIRED' });
    const pre = await this.prisma.livePurchase.findUnique({
      where: { id: purchaseId },
      include: { payment: true },
    });
    if (!pre) throw new NotFoundException('Purchase not found');
    const event = await this.prisma.paymentEvent.findUnique({ where: { id: eventId } });
    if (!event) throw new NotFoundException('Event not found');
    if (pre.payment) {
      // Idempotent retry: this transfer already became this purchase's payment.
      if (event.matchedPaymentId === pre.payment.id)
        return { ...(await this.byId(purchaseId)), already: true };
      throw new ConflictException({
        message: 'This purchase already has a payment',
        code: 'PURCHASE_HAS_PAYMENT',
      });
    }
    if (event.status !== 'UNMATCHED' && event.status !== 'AMBIGUOUS') {
      throw new ConflictException({
        message: 'This transfer is already claimed',
        code: 'EVENT_ALREADY_CLAIMED',
        status: event.status,
      });
    }
    if (!TRANSFER_METHODS.includes(event.provider as never)) {
      throw new BadRequestException({ message: 'Not a transfer', code: 'METHOD_INVALID' });
    }
    if (event.amountCents !== pre.studentPaysCents) {
      throw new BadRequestException({
        message: `Transfer is ${event.amountCents} but the seat costs ${pre.studentPaysCents}`,
        code: 'AMOUNT_MISMATCH',
      });
    }
    const paymentId = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const s = await lockSession(tx, pre.sessionId);
      const p = await lockPurchase(tx, purchaseId);
      if (!p || !s) throw new NotFoundException('Purchase not found');
      if (p.status !== 'HELD' && p.status !== 'EXPIRED') {
        throw new ConflictException({
          message: 'This purchase cannot take a payment',
          code: 'PURCHASE_STATE_CONFLICT',
          status: p.status,
        });
      }
      if (await tx.payment.findUnique({ where: { livePurchaseId: p.id }, select: { id: true } })) {
        throw new ConflictException({
          message: 'This purchase already has a payment',
          code: 'PURCHASE_HAS_PAYMENT',
        });
      }
      const payment = await tx.payment.create({
        data: {
          studentId: p.studentId,
          livePurchaseId: p.id,
          tenantId: p.tenantId,
          academyId: p.academyId,
          amountCents: p.studentPaysCents,
          feeCents: p.feeCents,
          netCents: p.teacherCents + p.centerCents,
          currency: p.currency,
          gateway: 'manual',
          method: event.provider,
          reference: null,
          payerName: event.payerName,
          claimedAt: now,
          recordedByUserId: adminId,
          note: `recovered from transfer ${eventId}: ${why}`.slice(0, 300),
          status: 'PENDING',
        },
      });
      const claim = await tx.paymentEvent.updateMany({
        where: {
          id: eventId,
          status: { in: ['UNMATCHED', 'AMBIGUOUS'] },
          matchedPaymentId: null,
          matchedTopupId: null,
        },
        data: {
          status: 'MATCHED',
          matchedPaymentId: payment.id,
          note: `attached by admin ${adminId}: ${why}`.slice(0, 500),
        },
      });
      if (claim.count === 0) {
        throw new ConflictException({
          message: 'This transfer is already claimed',
          code: 'EVENT_ALREADY_CLAIMED',
        });
      }
      // The same shape a buyer's claim produces; verification decides the seat.
      const keepable =
        !s.deletedAt &&
        !s.cancelledAt &&
        now.getTime() < closesAtMs(s) &&
        (s.capacity == null ||
          (await seatsTaken(tx, s.id, now, p.id)) < s.capacity ||
          (await hasAdmission(tx, s.id, p.studentId)));
      assertTransition(p.status, 'PAYMENT_PENDING');
      await tx.livePurchase.update({
        where: { id: p.id },
        data: {
          status: 'PAYMENT_PENDING',
          holdExpiresAt: keepable ? new Date(closesAtMs(s)) : null,
        },
      });
      return payment.id;
    });
    await this.audit(adminId, 'live.transfer.attach', purchaseId, {
      eventId,
      paymentId,
      reason: why,
    });
    // The ordinary admin verification: Live handler, capacity, oversold refund, ledger.
    await this.matching.verifyByAdmin(adminId, paymentId);
    return { ...(await this.byId(purchaseId)), already: false };
  }

  // ── Finance: refunds sent by hand ────────────────────────────────────────

  /** Approve a requested manual refund (it must say where to send it). Once. */
  async approveRefund(refundId: string, adminId: string) {
    const r = await this.prisma.refund.findUnique({ where: { id: refundId } });
    if (!r) throw new NotFoundException('Refund not found');
    if (r.status === 'APPROVED' || r.status === 'COMPLETED') return r;
    if (r.status !== 'REQUESTED')
      throw new ConflictException({ message: 'Refund is not open', code: 'REFUND_STATE_CONFLICT' });
    if (!r.destinationMethod)
      throw new ConflictException({
        message: 'The buyer has not said where to send it',
        code: 'REFUND_NO_DESTINATION',
      });
    await this.prisma.refund.updateMany({
      where: { id: refundId, status: 'REQUESTED' },
      data: { status: 'APPROVED', decidedById: adminId, decidedAt: new Date() },
    });
    await this.audit(adminId, 'live.refund.approve', r.livePurchaseId, { refundId });
    return this.prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
  }

  /**
   * Finance sent the money. The refund's ledger transaction (held → out of
   * platform cash, keyed `refund:<id>`) is written in the same step as the
   * status, under the session lock; a second press finds it COMPLETED.
   */
  async completeRefund(refundId: string, adminId: string, transferReference: string) {
    const ref = (transferReference ?? '').trim().slice(0, 120);
    if (ref.length < 3)
      throw new BadRequestException({
        message: 'Enter the transfer reference',
        code: 'TRANSFER_REFERENCE_REQUIRED',
      });
    const pre = await this.prisma.refund.findUnique({
      where: { id: refundId },
      include: { livePurchase: true },
    });
    if (!pre) throw new NotFoundException('Refund not found');
    await this.prisma.$transaction(async (tx) => {
      await lockSession(tx, pre.livePurchase.sessionId);
      const p = await lockPurchase(tx, pre.livePurchaseId);
      const r = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
      if (r.status === 'COMPLETED') return;
      if (r.status !== 'APPROVED')
        throw new ConflictException({
          message: 'Approve the refund first',
          code: 'REFUND_STATE_CONFLICT',
        });
      const txnId = await this.ledger.bookLiveRefund(
        {
          refundId: r.id,
          purchaseId: r.livePurchaseId,
          amountCents: r.amountCents,
          destination: { transferredOut: true },
          tenantId: p?.tenantId,
          academyId: p?.academyId,
        },
        tx,
      );
      await tx.refund.update({
        where: { id: r.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          transferReference: ref,
          ledgerTxnId: txnId,
        },
      });
      if (p?.status === 'REFUND_PENDING') {
        await tx.livePurchase.update({ where: { id: p.id }, data: { status: 'REFUNDED' } });
      }
    });
    await this.audit(adminId, 'live.refund.complete', pre.livePurchaseId, {
      refundId,
      transferReference: ref,
    });
    return this.prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
  }

  /** Refuse a manual refund. Its parts become releasable again (not refunded twice, not lost). */
  async rejectRefund(refundId: string, adminId: string, reason: string) {
    const why = (reason ?? '').trim().slice(0, 500);
    if (!why) throw new BadRequestException({ message: 'Say why', code: 'REASON_REQUIRED' });
    const r = await this.prisma.refund.updateMany({
      where: { id: refundId, status: { in: ['REQUESTED', 'APPROVED'] } },
      data: {
        status: 'REJECTED',
        rejectedReason: why,
        decidedById: adminId,
        decidedAt: new Date(),
      },
    });
    const row = await this.prisma.refund.findUnique({ where: { id: refundId } });
    if (!row) throw new NotFoundException('Refund not found');
    if (r.count === 0 && row.status !== 'REJECTED')
      throw new ConflictException({ message: 'Refund is not open', code: 'REFUND_STATE_CONFLICT' });
    await this.audit(adminId, 'live.refund.reject', row.livePurchaseId, { refundId, reason: why });
    return row;
  }

  // ── Reading ──────────────────────────────────────────────────────────────

  /**
   * Where the buyer's money stands, in the words the buyer needs:
   *
   *   AWAITING_TRANSFER — they declared, nothing has arrived yet;
   *   PROOF_SENT        — they said they transferred; nothing matched yet;
   *   UNDER_REVIEW      — a transfer of exactly their amount, on their rail,
   *                       arrived after they declared and could not be tied to
   *                       them automatically: a person is checking it. They
   *                       must NOT be told to pay again;
   *   CONFIRMED / REJECTED — decided.
   *
   * Only the existence of such a transfer is said, never whose it is.
   */
  /** Where the buyer's money stands — the shared answer (see payments/payment-stage.ts). */
  paymentStage(p: {
    payment: {
      status: string;
      claimedAt: Date | null;
      method: string | null;
      amountCents: number;
      walletCents: number;
      createdAt: Date;
    } | null;
  }) {
    return paymentStage(this.prisma, p.payment ? paymentRow(p.payment) : null);
  }

  async byId(purchaseId: string) {
    const p = await this.prisma.livePurchase.findUniqueOrThrow({
      where: { id: purchaseId },
      include: { payment: true, refunds: true },
    });
    return { ...this.view(p), paymentStage: await this.paymentStage(p) };
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
            // The buyer's own declaration, so the checkout can show what they
            // said and let them fix it until they claim the transfer.
            transferSource: p.payment.transferSource ?? null,
            senderWallet: p.payment.transferSource === 'WALLET' ? p.payment.reference : null,
            payerName: p.payment.payerName ?? null,
            claimedAt: p.payment.claimedAt ?? null,
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
      include: {
        payment: true,
        refunds: true,
        session: { select: { title: true, startsAt: true, durationMin: true } },
      },
    });
    return rows.map((p) => ({ ...this.view(p), session: p.session }));
  }

  // ── After the fact (outside the money transaction) ──────────────────────

  private async afterConfirmed(purchaseId: string, paymentId: string) {
    await this.ledger
      .ensureInvoice(paymentId)
      .catch((e) =>
        this.logger.warn(`live.invoice payment=${paymentId} failed: ${(e as Error).message}`),
      );
    const p = await this.prisma.livePurchase.findUnique({
      where: { id: purchaseId },
      include: { session: { select: { title: true, tenantId: true } } },
    });
    if (!p) return;
    if (p.studentId)
      await this.notifyStudent(
        p.studentId,
        'تم تأكيد حجزك ✅',
        `مكانك في «${p.session.title}» اتأكد. هتلاقيها في جلساتك المباشرة.`,
        {
          sessionId: p.sessionId,
        },
      );
    const teacher = await this.prisma.teacherProfile.findUnique({
      where: { id: p.session.tenantId },
      select: { userId: true },
    });
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

  private async notifyStudent(
    studentId: string,
    title: string,
    body: string,
    meta: Record<string, unknown> = {},
  ) {
    const s = await this.prisma.studentProfile.findUnique({
      where: { id: studentId },
      select: { userId: true },
    });
    if (s)
      await this.notifications
        .create({ userId: s.userId, type: 'LIVE_SESSION_REMINDER', title, body, meta })
        .catch(() => undefined);
  }
}
