import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PaymentEvent, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isIncomingTransfer, parsePayerName } from '../device/sms-parser';
import { ProofReading } from './proof-reader.service';
import { ManualPaymentsService } from './manual-payments.service';
import { WalletService } from '../wallet/wallet.service';
import { decideMatch, MatchCandidate, MatchDecision } from './match-policy';
import { receivingHandles } from './receiving-accounts';
import { eventEvidence, normRef } from './transfer-evidence';

export interface PaymentEventDto {
  provider: 'INSTAPAY' | 'VODAFONE_CASH' | 'BANK_TRANSFER' | 'OTHER';
  amountCents: number;
  reference?: string;
  occurredAt?: string;
  rawMessage?: string;
  deviceId?: string;
  /**
   * A globally unique id for the *transfer event itself* — the SMS message hash
   * from the listener device.
   *
   * Needed because a wallet SMS carries no transaction id: the identity we match
   * on is the sender's mobile number, which is NOT unique per transfer. Keying
   * idempotency on provider+reference+amount would then treat a student's second
   * transfer of the same amount (a monthly subscription, or a second course at
   * the same price) as a duplicate and silently never credit it. When this is
   * supplied it becomes the dedupe identity instead.
   */
  externalId?: string;
  /**
   * Every identifier the raw message could be matched on. Used only when there
   * is no raw message: when there is one, the server reads it itself.
   */
  identities?: string[];
}

/**
 * How far apart a transfer and the payment it pays for may have been created.
 * Buyers transfer first and fill the form later (a course student, next
 * morning), or — for a Live seat — declare first and transfer after.
 */
const WINDOW_MS = 72 * 3600_000;
/** How near another unclaimed transfer of the same amount must be to count as a competitor. */
const COMPETITOR_WINDOW_MS = 2 * 3600_000;

/**
 * Which payment methods one provider's message may settle.
 *
 * InstaPay is a rail between bank accounts, not a wallet: the money lands in a
 * bank account and it is the *bank* that sends the SMS («تم تنفيذ تحويل لحظي …
 * إلى حسابك المنتهي بـ **7717»). Meanwhile the student, reading a card labelled
 * «إنستاباي درسلي», picks INSTAPAY. Neither side is wrong, and an exact equality
 * on method meant the two never met — every InstaPay transfer went to an admin.
 *
 * Only the bank family is pooled. A wallet is a different rail with a different
 * SMS and must stay separate. Pooling widens the *candidate set* and nothing
 * else: the policy still needs its evidence, and a wider pool only makes a
 * match harder, never easier.
 */
export function methodsFor(provider: string): string[] {
  return provider === 'INSTAPAY' || provider === 'BANK_TRANSFER' ? ['INSTAPAY', 'BANK_TRANSFER'] : [provider];
}

/** Everything the policy needs about one candidate, plus how to act on it. */
type PoolEntry = MatchCandidate & { status?: string };

@Injectable()
export class PaymentMatchingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly manual: ManualPaymentsService,
    private readonly wallet: WalletService,
  ) {}

  /**
   * Every pending candidate this transfer could pay for: PENDING payments (and
   * teacher-self-verified PAID-but-unsettled ones) and PENDING wallet top-ups,
   * on the same rail, owing exactly this amount, created within the window.
   * A payment another transfer already claimed is not a candidate: one
   * payment, one transfer.
   */
  private async pool(provider: string, amountCents: number, occurredAt: Date): Promise<PoolEntry[]> {
    const createdAt = {
      gte: new Date(occurredAt.getTime() - WINDOW_MS),
      lte: new Date(occurredAt.getTime() + WINDOW_MS),
    };
    const payments = (
      await this.prisma.payment.findMany({
        where: {
          gateway: 'manual',
          method: { in: methodsFor(provider) as any[] },
          createdAt,
          OR: [{ status: 'PENDING' }, { status: 'PAID', settledAt: null }],
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          reference: true,
          status: true,
          amountCents: true,
          walletCents: true,
          proofReading: true,
          payerName: true,
          student: { select: { user: { select: { fullName: true } } } },
          // A guest's seat has no student: the name they gave is who owes it.
          livePurchase: { select: { guestBuyer: { select: { displayName: true } } } },
        },
      })
    )
      // A payment with a wallet part is waiting only on the remainder.
      .filter((p) => p.amountCents - (p.walletCents ?? 0) === amountCents);
    const claimed = payments.length
      ? new Set(
          (
            await this.prisma.paymentEvent.findMany({
              where: { matchedPaymentId: { in: payments.map((p) => p.id) } },
              select: { matchedPaymentId: true },
            })
          ).map((e) => e.matchedPaymentId),
        )
      : new Set<string | null>();
    const topups = await this.prisma.walletTopup.findMany({
      where: { status: 'PENDING', amountCents, method: { in: methodsFor(provider) as any[] }, createdAt },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        reference: true,
        proofReading: true,
        student: { select: { user: { select: { fullName: true } } } },
      },
    });
    return [
      ...payments
        .filter((p) => !claimed.has(p.id))
        .map((p) => ({
          kind: 'payment' as const,
          id: p.id,
          status: p.status,
          reference: p.reference,
          declaredPayerName: p.payerName ?? null,
          ownerName: p.student?.user?.fullName ?? p.livePurchase?.guestBuyer?.displayName ?? '',
          receipt: (p.proofReading as ProofReading | null) ?? null,
        })),
      ...topups.map((t) => ({
        kind: 'topup' as const,
        id: t.id,
        reference: t.reference,
        declaredPayerName: null,
        ownerName: t.student?.user?.fullName ?? '',
        receipt: (t.proofReading as ProofReading | null) ?? null,
      })),
    ];
  }

  /** Other unclaimed transfers of this amount and rail near this one. */
  private openEventsNear(provider: string, amountCents: number, occurredAt: Date, excludeId?: string) {
    return this.prisma.paymentEvent.count({
      where: {
        ...(excludeId ? { id: { not: excludeId } } : {}),
        status: { in: ['UNMATCHED', 'AMBIGUOUS'] },
        matchedPaymentId: null,
        matchedTopupId: null,
        provider: { in: methodsFor(provider) as any[] },
        amountCents,
        occurredAt: {
          gte: new Date(occurredAt.getTime() - COMPETITOR_WINDOW_MS),
          lte: new Date(occurredAt.getTime() + COMPETITOR_WINDOW_MS),
        },
      },
    });
  }

  /** The policy's verdict on one transfer, against its whole pool. */
  private async decide(
    event: { provider: string; amountCents: number; occurredAt: Date; rawMessage?: string | null; reference?: string | null; identities?: string[] | null; payerName?: string | null; id?: string },
    receiving: string[],
  ): Promise<{ decision: MatchDecision; payerName: string | null }> {
    const evidence = eventEvidence(event, receiving);
    const candidates = await this.pool(event.provider, event.amountCents, event.occurredAt);
    const otherOpenEvents = candidates.length
      ? await this.openEventsNear(event.provider, event.amountCents, event.occurredAt, event.id)
      : 0;
    const decision = decideMatch(evidence, candidates, {
      amountCents: event.amountCents,
      occurredAt: event.occurredAt,
      receiving,
      otherOpenEvents,
    });
    return { decision, payerName: evidence.payerName };
  }

  /** Verify / settle / approve what a transfer was matched to. */
  private async act(chosen: PoolEntry) {
    if (chosen.kind === 'topup') await this.wallet.approveTopup(null, chosen.id);
    else if (chosen.status === 'PAID') await this.manual.settle(chosen.id, 'system'); // PAID+unsettled → settle
    else await this.manual.systemVerify(chosen.id);
  }

  /**
   * Ingest a transfer notification from the Android listener: record it once,
   * decide it by the matching policy, and act only on a MATCHED verdict.
   */
  async ingest(dto: PaymentEventDto) {
    const occurredAt = dto.occurredAt ? new Date(dto.occurredAt) : new Date();
    const ref = normRef(dto.reference);

    // Idempotency identity, enforced by a DB unique index.
    //
    // Preferred: the caller's own unique event id (the listener's SMS hash) — one
    // real SMS, one event, no matter how often it is retried, and repeat
    // transfers of the same amount by the same sender stay distinct.
    //
    // Legacy fallback (the X-Listener-Key path, which has no event id): a real
    // transaction reference makes provider+ref+amount unique per transfer.
    const externalId = (dto.externalId ?? '').trim();
    const dedupeKey = externalId
      ? `${dto.provider}:evt:${externalId}`
      : ref
        ? `${dto.provider}:${ref}:${dto.amountCents}`
        : null;

    // Hard idempotency: a re-delivered notification collides on dedupeKey and is
    // reported as an already-processed duplicate — it can never match a second,
    // unrelated payment.
    if (dedupeKey) {
      const prior = await this.prisma.paymentEvent.findUnique({ where: { dedupeKey } });
      if (prior) {
        return { eventId: prior.id, status: 'DUPLICATE' as const, matchedPaymentId: prior.matchedPaymentId };
      }
    }

    /**
     * Money arriving, or money leaving?
     *
     * The listener sits on a phone that both receives and sends, so a bank's
     * "تم تنفيذ تحويل لحظي بمبلغ 120.00 جم **من حسابك**" is the platform's own
     * money going out. Enforced here, in the engine both routes reach. Silence
     * is not treated as outgoing: an event with no raw message cannot be judged
     * either way and is matched on its other evidence.
     */
    if (dto.rawMessage?.trim() && !isIncomingTransfer(dto.rawMessage)) {
      const r = await this.record(
        dto,
        occurredAt,
        dedupeKey,
        'UNMATCHED',
        null,
        'the message describes money leaving the account, not arriving — never auto-verified',
      );
      return { eventId: r.eventId, status: r.status, matchedPaymentId: r.matchedPaymentId };
    }

    const receiving = await receivingHandles(this.prisma);
    const evidence = eventEvidence(dto, receiving);
    // Nothing on this transfer identifies it — no sender number, no provider
    // reference. It is recorded for a person; nothing could verify it.
    if (!evidence.senderNumbers.length && !evidence.providerRefs.length) {
      const r = await this.record(
        dto,
        occurredAt,
        dedupeKey,
        'UNMATCHED',
        null,
        'no sender reference — auto-verify disabled without a transfer identity; needs manual review',
        null,
        evidence.payerName,
      );
      return { eventId: r.eventId, status: r.status, matchedPaymentId: r.matchedPaymentId };
    }

    const { decision } = await this.decide({ ...dto, occurredAt }, receiving);
    const chosen = decision.status === 'MATCHED' ? (decision.candidate as PoolEntry) : null;
    const r = await this.record(
      dto,
      occurredAt,
      dedupeKey,
      decision.status,
      chosen?.kind === 'payment' ? chosen.id : null,
      decision.note,
      chosen?.kind === 'topup' ? chosen.id : null,
      evidence.payerName,
    );
    // Only act if we actually recorded a fresh MATCHED event (a concurrent replay
    // that lost the unique-index race returns created=false and does nothing).
    if (r.created && chosen && r.status === 'MATCHED') await this.act(chosen);
    return { eventId: r.eventId, status: r.status, matchedPaymentId: r.matchedPaymentId };
  }

  /**
   * The other direction: a payment (or top-up) was just created or claimed —
   * is a transfer already sitting here waiting for it?
   *
   * Buyers often transfer first and fill the form afterwards, so the SMS lands
   * before the payment exists and is filed UNMATCHED. Each unclaimed transfer
   * of this amount is decided again by the SAME policy against its whole pool
   * (this candidate now included); only a transfer that the policy would give
   * to exactly this candidate is claimed, with a compare-and-swap.
   */
  private async reconcile(kind: 'payment' | 'topup', id: string, provider: string, dueCents: number, createdAt: Date) {
    const events = await this.prisma.paymentEvent.findMany({
      where: {
        status: { in: ['UNMATCHED', 'AMBIGUOUS'] },
        matchedPaymentId: null,
        matchedTopupId: null,
        provider: { in: methodsFor(provider) as any[] },
        amountCents: dueCents,
        occurredAt: { gte: new Date(createdAt.getTime() - WINDOW_MS), lte: new Date(createdAt.getTime() + WINDOW_MS) },
      },
      orderBy: { occurredAt: 'desc' },
      take: 50,
    });
    // An outgoing debit, or a message with nothing in it, never pays for anything.
    const usable = events.filter((e) => !e.rawMessage?.trim() || isIncomingTransfer(e.rawMessage));
    if (!usable.length) return { status: 'UNMATCHED' as const };
    const receiving = await receivingHandles(this.prisma);
    const hits: PaymentEvent[] = [];
    let ambiguous = false;
    for (const e of usable) {
      const { decision } = await this.decide(e, receiving);
      if (decision.status === 'MATCHED' && decision.candidate.kind === kind && decision.candidate.id === id) hits.push(e);
      else if (decision.status === 'AMBIGUOUS') ambiguous = true;
    }
    if (hits.length > 1) return { status: 'AMBIGUOUS' as const };
    if (hits.length === 0) return { status: ambiguous ? ('AMBIGUOUS' as const) : ('UNMATCHED' as const) };

    const event = hits[0];
    // Claim the transfer with a compare-and-swap: two candidates reconciling at
    // the same instant both read this event as unclaimed, and an unconditional
    // update let both claim it — one real SMS verifying two payments. Only the
    // claim that flips it wins.
    const claim = await this.prisma.paymentEvent.updateMany({
      where: { id: event.id, status: { in: ['UNMATCHED', 'AMBIGUOUS'] }, matchedPaymentId: null, matchedTopupId: null },
      data:
        kind === 'payment'
          ? { status: 'MATCHED', matchedPaymentId: id, note: 'reconciled when the payment was submitted (transfer arrived first)' }
          : { status: 'MATCHED', matchedTopupId: id, note: 'reconciled when the top-up was submitted (transfer arrived first)' },
    });
    if (claim.count === 0) return { status: 'UNMATCHED' as const };
    return { status: 'MATCHED' as const, eventId: event.id };
  }

  async reconcilePayment(paymentId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: { id: true, status: true, method: true, amountCents: true, walletCents: true, createdAt: true, gateway: true },
    });
    if (!payment || payment.status !== 'PENDING' || payment.gateway !== 'manual' || !payment.method) {
      return { status: 'SKIPPED' as const };
    }
    const r = await this.reconcile(
      'payment',
      payment.id,
      payment.method,
      payment.amountCents - payment.walletCents,
      payment.createdAt,
    );
    if (r.status === 'MATCHED') await this.manual.systemVerify(payment.id);
    return r;
  }

  async reconcileTopup(topupId: string) {
    const topup = await this.prisma.walletTopup.findUnique({
      where: { id: topupId },
      select: { id: true, status: true, method: true, amountCents: true, createdAt: true },
    });
    if (!topup || topup.status !== 'PENDING') return { status: 'SKIPPED' as const };
    const r = await this.reconcile('topup', topup.id, topup.method, topup.amountCents, topup.createdAt);
    if (r.status === 'MATCHED') await this.wallet.approveTopup(null, topup.id);
    return r;
  }

  private async record(
    dto: PaymentEventDto,
    occurredAt: Date,
    dedupeKey: string | null,
    status: 'MATCHED' | 'UNMATCHED' | 'AMBIGUOUS' | 'DUPLICATE',
    matchedPaymentId: string | null,
    note?: string,
    matchedTopupId?: string | null,
    payerName?: string | null,
  ) {
    try {
      const event = await this.prisma.paymentEvent.create({
        data: {
          provider: dto.provider as any,
          amountCents: dto.amountCents,
          reference: dto.reference?.trim() || null,
          occurredAt,
          rawMessage: dto.rawMessage ?? '',
          // Re-derived from the raw message when the caller did not pass it, so
          // an event recorded on any path carries who sent the money.
          payerName: payerName ?? parsePayerName(dto.rawMessage ?? ''),
          deviceId: dto.deviceId ?? null,
          status,
          matchedPaymentId,
          matchedTopupId: matchedTopupId ?? null,
          dedupeKey,
          note,
        },
      });
      return { eventId: event.id, status, matchedPaymentId, created: true };
    } catch (e) {
      // Lost the unique-index race with a concurrent identical event → duplicate.
      if (dedupeKey && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const prior = await this.prisma.paymentEvent.findUnique({ where: { dedupeKey } });
        return {
          eventId: prior?.id ?? null,
          status: 'DUPLICATE' as const,
          matchedPaymentId: prior?.matchedPaymentId ?? null,
          created: false,
        };
      }
      throw e;
    }
  }

  // ── Admin ────────────────────────────────────────────────────────────────

  /** The ordinary admin verification, for a payment finance tied to a transfer. */
  verifyByAdmin(adminId: string, paymentId: string) {
    return this.manual.verifyByAdmin(adminId, paymentId);
  }

  /**
   * An admin says this transfer is this payment.
   *
   * The server re-checks everything the screen showed: the transfer is still
   * unclaimed (not matched, not being returned), it is on the payment's rail,
   * it carries exactly what the payment is waiting on, the payment is still
   * open, and no other transfer already paid for it. The transfer is claimed
   * with a compare-and-swap before anything is verified, so a double click, a
   * second admin or the automatic matcher cannot spend it twice; verification
   * then runs through the ordinary admin path (the Live handler for a seat).
   */
  async manualMatch(eventId: string, paymentId: string, actorId: string, reason?: string) {
    const event = await this.prisma.paymentEvent.findUnique({ where: { id: eventId } });
    if (!event) throw new NotFoundException('Event not found');
    if (event.status === 'MATCHED' || event.matchedPaymentId || event.matchedTopupId) {
      throw new BadRequestException({ message: 'Event already matched', code: 'EVENT_ALREADY_CLAIMED' });
    }
    if (event.status === 'RETURNED') {
      throw new BadRequestException({ message: 'This transfer is being returned', code: 'EVENT_RETURNED' });
    }
    if (event.status === 'DUPLICATE') {
      throw new BadRequestException({ message: 'A duplicate notification is not a transfer', code: 'EVENT_DUPLICATE' });
    }
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found');
    if (!payment.method || !methodsFor(event.provider).includes(payment.method)) {
      throw new BadRequestException({
        message: `The transfer arrived by ${event.provider}, the payment is ${payment.method ?? 'unknown'}`,
        code: 'METHOD_MISMATCH',
      });
    }
    // A transfer is proof of exactly the amount it carried, not of any payment
    // an admin points it at. "The amount" is what the transfer had to cover:
    // a payment with a wallet contribution is waiting on the remainder.
    const dueCents = payment.amountCents - (payment.walletCents ?? 0);
    if (event.amountCents !== dueCents) {
      throw new BadRequestException({
        message: `Transfer is ${event.amountCents} but the payment is waiting on ${dueCents}`,
        code: 'AMOUNT_MISMATCH',
      });
    }
    if (!(payment.status === 'PENDING' || (payment.status === 'PAID' && !payment.settledAt)))
      throw new BadRequestException({
        message: 'Payment is neither pending nor awaiting settlement',
        code: 'NOT_MATCHABLE',
      });
    const already = await this.prisma.paymentEvent.findFirst({ where: { matchedPaymentId: paymentId }, select: { id: true } });
    if (already) {
      throw new BadRequestException({ message: 'Another transfer already paid for this payment', code: 'PAYMENT_ALREADY_HAS_TRANSFER' });
    }
    const why = (reason ?? '').trim().slice(0, 300);
    const claim = await this.prisma.paymentEvent.updateMany({
      where: { id: eventId, status: { in: ['UNMATCHED', 'AMBIGUOUS'] }, matchedPaymentId: null, matchedTopupId: null },
      data: { status: 'MATCHED', matchedPaymentId: paymentId, note: `manual match by ${actorId}${why ? `: ${why}` : ''}` },
    });
    if (claim.count === 0) throw new BadRequestException({ message: 'Event already matched', code: 'EVENT_ALREADY_CLAIMED' });
    try {
      // A pending payment is verified — by this admin, through the ordinary
      // path; one a teacher already self-verified is settled.
      if (payment.status === 'PENDING') await this.manual.verifyByAdmin(actorId, paymentId);
      else await this.manual.settle(paymentId, actorId);
    } catch (e) {
      // The payment was not verified: the transfer is not spent.
      await this.prisma.paymentEvent.updateMany({
        where: { id: eventId, matchedPaymentId: paymentId },
        data: { status: event.status, matchedPaymentId: null, note: event.note },
      });
      throw e;
    }
    await this.prisma.auditLog
      .create({
        data: {
          actorUserId: actorId,
          action: 'payment.event.match',
          entity: 'PaymentEvent',
          entityId: eventId,
          meta: { paymentId, reason: why || null } as never,
        },
      })
      .catch(() => undefined);
    return { ok: true };
  }
}
