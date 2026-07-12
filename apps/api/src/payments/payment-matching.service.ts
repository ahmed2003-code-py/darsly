import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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

// How close two events' timestamps must be to be treated as the same transfer
// re-delivered (for reference-less dedup).
const DEDUP_TIME_MS = 5 * 60_000;

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

    // De-dupe against transfers we already auto-credited. Works even without a
    // reference (a re-delivered notification): same provider+amount plus EITHER
    // an identical reference, an identical raw message, or the same device at
    // (nearly) the same instant is the same transfer replayed.
    const recentMatched = await this.prisma.paymentEvent.findMany({
      where: { status: 'MATCHED', provider: dto.provider as any, amountCents: dto.amountCents },
      select: { reference: true, rawMessage: true, deviceId: true, occurredAt: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const isDuplicate = recentMatched.some((e) => {
      if (ref && refExact(normRef(e.reference), ref)) return true;
      if (dto.rawMessage && e.rawMessage && e.rawMessage === dto.rawMessage) return true;
      if (
        dto.deviceId && e.deviceId && e.deviceId === dto.deviceId &&
        Math.abs(e.occurredAt.getTime() - occurredAt.getTime()) < DEDUP_TIME_MS
      ) {
        return true;
      }
      return false;
    });
    if (isDuplicate) {
      return this.record(dto, occurredAt, 'DUPLICATE', null, 'transfer already processed');
    }

    const candidates = await this.prisma.payment.findMany({
      where: {
        status: 'PENDING',
        gateway: 'manual',
        amountCents: dto.amountCents,
        method: dto.provider as any,
        createdAt: { gte: new Date(occurredAt.getTime() - WINDOW_BEFORE_MS), lte: new Date(occurredAt.getTime() + WINDOW_AFTER_MS) },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, reference: true },
    });

    let chosen: { id: string } | null = null;
    let status: 'MATCHED' | 'UNMATCHED' | 'AMBIGUOUS' = 'UNMATCHED';
    let note: string | undefined;

    if (candidates.length === 0) {
      status = 'UNMATCHED';
      note = 'no pending payment with this amount/method in the time window';
    } else if (ref) {
      const refMatches = candidates.filter((c) => refExact(normRef(c.reference), ref));
      if (refMatches.length === 1) { chosen = refMatches[0]; status = 'MATCHED'; }
      else if (refMatches.length > 1) { status = 'AMBIGUOUS'; note = 'multiple payments share this reference'; }
      else if (candidates.length === 1) { chosen = candidates[0]; status = 'MATCHED'; note = 'matched by amount+time (reference differed)'; }
      else { status = 'AMBIGUOUS'; note = 'several amount matches, none by reference'; }
    } else if (candidates.length === 1) {
      chosen = candidates[0]; status = 'MATCHED'; note = 'matched by amount+time (no reference)';
    } else {
      status = 'AMBIGUOUS'; note = 'several amount matches, no reference to disambiguate';
    }

    const event = await this.record(dto, occurredAt, status, chosen?.id ?? null, note);
    if (chosen) await this.manual.systemVerify(chosen.id);
    return event;
  }

  private async record(
    dto: PaymentEventDto, occurredAt: Date,
    status: 'MATCHED' | 'UNMATCHED' | 'AMBIGUOUS' | 'DUPLICATE',
    matchedPaymentId: string | null, note?: string,
  ) {
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
        note,
      },
    });
    return { eventId: event.id, status, matchedPaymentId };
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
