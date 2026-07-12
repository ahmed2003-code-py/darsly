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

function normRef(r?: string | null): string {
  return (r ?? '').replace(/[^0-9a-z]/gi, '').toLowerCase();
}
function refSimilar(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a));
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

    // De-dupe: the same reference already produced a matched event.
    if (ref) {
      const recentMatched = await this.prisma.paymentEvent.findMany({
        where: { status: 'MATCHED', reference: { not: null } },
        select: { reference: true }, orderBy: { createdAt: 'desc' }, take: 200,
      });
      if (recentMatched.some((e) => refSimilar(normRef(e.reference), ref))) {
        return this.record(dto, occurredAt, 'DUPLICATE', null, 'reference already processed');
      }
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
      const refMatches = candidates.filter((c) => refSimilar(normRef(c.reference), ref));
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
