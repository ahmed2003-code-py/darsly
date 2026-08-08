import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { parseIdentities } from '../device/sms-parser';
import { ManualPaymentsService } from './manual-payments.service';

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
   * Every identifier the raw message could be matched on — the sending wallet's
   * mobile number, a labelled transaction reference, and so on. The student typed
   * exactly one of them at checkout, and which one is not ours to guess, so a hit
   * on any counts. Falls back to [reference] when not supplied.
   */
  identities?: string[];
}

// How far back a pending payment may have been created relative to the transfer.
const WINDOW_BEFORE_MS = 72 * 3600_000;
const WINDOW_AFTER_MS = 30 * 60_000;

function normRef(r?: string | null): string {
  return (r ?? '').replace(/[^0-9a-z]/gi, '').toLowerCase();
}
/**
 * Exact normalized-reference equality. Auto-verification must never rely on
 * fuzzy/substring matching — "1234" and "12345" are DIFFERENT transfers, and
 * treating them as the same either drops a real payment or credits the wrong one.
 */
function refExact(a: string, b: string): boolean {
  return !!a && !!b && a === b;
}

@Injectable()
export class PaymentMatchingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly manual: ManualPaymentsService,
  ) {}

  /**
   * Ingest a transfer notification from the Android listener, match it against a
   * pending payment (amount + method + time window, disambiguated by reference),
   * and auto-verify on a confident single match.
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

    // No sender identity ⇒ NEVER auto-verify, even when the event itself is
    // uniquely identified. Amount + time window alone cannot tell two students'
    // identical transfers apart, and crediting the wrong enrollment is worse than
    // asking a human. Recorded (with whatever dedupe identity we have) for review.
    if (!ref) {
      const r = await this.record(dto, occurredAt, dedupeKey, 'UNMATCHED', null,
        'no sender reference — auto-verify disabled without a transfer identity; needs manual review');
      return { eventId: r.eventId, status: r.status, matchedPaymentId: r.matchedPaymentId };
    }

    // Candidates: PENDING payments to verify, OR self-verified (PAID + not yet
    // settled) payments to reconcile — both within the amount/method/time window.
    const candidates = await this.prisma.payment.findMany({
      where: {
        gateway: 'manual',
        amountCents: dto.amountCents,
        method: dto.provider as any,
        createdAt: { gte: new Date(occurredAt.getTime() - WINDOW_BEFORE_MS), lte: new Date(occurredAt.getTime() + WINDOW_AFTER_MS) },
        OR: [{ status: 'PENDING' }, { status: 'PAID', settledAt: null }],
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, reference: true, status: true },
    });

    let chosen: { id: string; status: string } | null = null;
    let status: 'MATCHED' | 'UNMATCHED' | 'AMBIGUOUS' = 'UNMATCHED';
    let note: string | undefined;

    const identities = (dto.identities?.length ? dto.identities : [dto.reference ?? ''])
      .map(normRef)
      .filter(Boolean);

    if (candidates.length === 0) {
      status = 'UNMATCHED';
      note = 'no pending/unsettled payment with this amount/method in the time window';
    } else {
      const refMatches = candidates.filter((c) =>
        identities.some((identity) => refExact(normRef(c.reference), identity)),
      );
      if (refMatches.length === 1) { chosen = refMatches[0]; status = 'MATCHED'; }
      else if (refMatches.length > 1) { status = 'AMBIGUOUS'; note = 'multiple payments share this reference'; }
      else if (candidates.length === 1) { chosen = candidates[0]; status = 'MATCHED'; note = 'matched by amount+time (reference differed)'; }
      else { status = 'AMBIGUOUS'; note = 'several amount matches, none by reference'; }
    }

    const r = await this.record(dto, occurredAt, dedupeKey, status, chosen?.id ?? null, note);
    // Only act if we actually recorded a fresh MATCHED event (a concurrent replay
    // that lost the unique-index race returns created=false and does nothing).
    if (r.created && chosen && r.status === 'MATCHED') {
      if (chosen.status === 'PENDING') await this.manual.systemVerify(chosen.id);
      else await this.manual.settle(chosen.id, 'system'); // PAID+unsettled → settle
    }
    return { eventId: r.eventId, status: r.status, matchedPaymentId: r.matchedPaymentId };
  }

  /**
   * The other direction: a payment was just submitted — is a transfer already
   * sitting here waiting for it?
   *
   * Matching used to look only backwards, from a transfer to an existing payment.
   * But students transfer *first* and fill the form afterwards, so the SMS almost
   * always lands before the payment row exists — a few seconds is enough. Every
   * one of those events was filed UNMATCHED and nothing ever revisited it, which
   * is why auto-verification looked broken while each half worked perfectly.
   *
   * Same evidence, same confidence rules as [ingest]: same provider, same amount,
   * inside the same window, and exactly one identity match. Ambiguity still goes
   * to a human.
   */
  async reconcilePayment(paymentId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: { id: true, status: true, method: true, amountCents: true, reference: true, createdAt: true },
    });
    if (!payment || payment.status !== 'PENDING') return { status: 'SKIPPED' as const };

    const ref = normRef(payment.reference);
    // Without an identity the student gave us, amount+time alone cannot tell two
    // students' identical transfers apart. Same rule as the forward path.
    if (!ref) return { status: 'NO_REFERENCE' as const };

    const events = await this.prisma.paymentEvent.findMany({
      where: {
        status: 'UNMATCHED',
        matchedPaymentId: null,
        provider: payment.method as any,
        amountCents: payment.amountCents,
        occurredAt: {
          gte: new Date(payment.createdAt.getTime() - WINDOW_BEFORE_MS),
          lte: new Date(payment.createdAt.getTime() + WINDOW_AFTER_MS),
        },
      },
      orderBy: { occurredAt: 'desc' },
      take: 50,
    });

    const hits = events.filter((event) => {
      const derived = parseIdentities(event.rawMessage ?? '').map(normRef).filter(Boolean);
      const identities = derived.length ? derived : [normRef(event.reference)];
      return identities.some((identity) => refExact(identity, ref));
    });

    if (hits.length === 0) return { status: 'UNMATCHED' as const };
    if (hits.length > 1) return { status: 'AMBIGUOUS' as const };

    const event = hits[0];
    await this.prisma.paymentEvent.update({
      where: { id: event.id },
      data: {
        status: 'MATCHED',
        matchedPaymentId: payment.id,
        note: 'reconciled when the payment was submitted (transfer arrived first)',
      },
    });
    await this.manual.systemVerify(payment.id);
    return { status: 'MATCHED' as const, eventId: event.id };
  }

  private async record(
    dto: PaymentEventDto, occurredAt: Date, dedupeKey: string | null,
    status: 'MATCHED' | 'UNMATCHED' | 'AMBIGUOUS' | 'DUPLICATE',
    matchedPaymentId: string | null, note?: string,
  ) {
    try {
      const event = await this.prisma.paymentEvent.create({
        data: {
          provider: dto.provider as any,
          amountCents: dto.amountCents,
          reference: dto.reference?.trim() || null,
          occurredAt,
          rawMessage: dto.rawMessage ?? '',
          deviceId: dto.deviceId ?? null,
          status,
          matchedPaymentId,
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

  listEvents(status?: string) {
    return this.prisma.paymentEvent.findMany({
      where: status ? { status: status as any } : {},
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  /** Admin resolves an unmatched/ambiguous event by pointing it at a payment. */
  async manualMatch(eventId: string, paymentId: string, actorId: string) {
    const event = await this.prisma.paymentEvent.findUnique({ where: { id: eventId } });
    if (!event) throw new NotFoundException('Event not found');
    if (event.status === 'MATCHED') throw new BadRequestException('Event already matched');
    await this.manual.systemVerify(paymentId);
    await this.prisma.paymentEvent.update({
      where: { id: eventId },
      data: { status: 'MATCHED', matchedPaymentId: paymentId, note: `manual match by ${actorId}` },
    });
    return { ok: true };
  }
}
