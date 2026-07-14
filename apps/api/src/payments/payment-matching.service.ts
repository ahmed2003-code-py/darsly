import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ManualPaymentsService } from './manual-payments.service';

export interface PaymentEventDto {
  provider: 'INSTAPAY' | 'VODAFONE_CASH' | 'BANK_TRANSFER' | 'OTHER';
  amountCents: number;
  reference?: string;
  occurredAt?: string;
  rawMessage?: string;
  deviceId?: string;
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

    // A stable transfer identity requires a reference. provider+ref+amount is
    // globally unique per real transfer, and is enforced by the DB unique index.
    const dedupeKey = ref ? `${dto.provider}:${ref}:${dto.amountCents}` : null;

    // Hard idempotency: a re-delivered notification collides on dedupeKey and is
    // reported as an already-processed duplicate — it can never match a second,
    // unrelated payment.
    if (dedupeKey) {
      const prior = await this.prisma.paymentEvent.findUnique({ where: { dedupeKey } });
      if (prior) {
        return { eventId: prior.id, status: 'DUPLICATE' as const, matchedPaymentId: prior.matchedPaymentId };
      }
    }

    // No reference ⇒ no stable identity ⇒ NEVER auto-verify. A reference-less
    // replay must not activate another student's same-amount enrollment. Record
    // it for manual review only.
    if (!dedupeKey) {
      const r = await this.record(dto, occurredAt, null, 'UNMATCHED', null,
        'no reference — auto-verify disabled without a stable transfer id; needs manual review');
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

    if (candidates.length === 0) {
      status = 'UNMATCHED';
      note = 'no pending/unsettled payment with this amount/method in the time window';
    } else {
      const refMatches = candidates.filter((c) => refExact(normRef(c.reference), ref));
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
