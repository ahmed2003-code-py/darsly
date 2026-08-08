import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PaymentMethod } from '@darsly/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentMatchingService } from '../payments/payment-matching.service';
import { SenderRulesService } from './sender-rules.service';
import { classifySender, parseAmountCents, parseReference } from './sms-parser';
import { DeviceSmsEventDto } from './dto';

export interface SmsEventResult {
  eventId: string;
  duplicate: boolean;
  brand: string | null;
  provider: PaymentMethod | null;
  amountCents: number | null;
  reference: string | null;
  forwarded: boolean;
  /** MATCHED | UNMATCHED | AMBIGUOUS | DUPLICATE | LOCAL_ONLY */
  status: string;
}

/**
 * Server side of the device outbox. Every posted SMS is recorded with a hard
 * UNIQUE(deviceId, messageHash) idempotency guard, re-classified from the raw
 * body (server is authoritative for money-affecting fields), and — only when a
 * rule says so and an amount is present — forwarded into the shared
 * PaymentMatchingService. Retries of a not-yet-forwarded event self-heal.
 */
@Injectable()
export class SmsEventsService {
  private readonly logger = new Logger(SmsEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: SenderRulesService,
    private readonly matching: PaymentMatchingService,
  ) {}

  async ingest(device: { id: string }, dto: DeviceSmsEventDto): Promise<SmsEventResult> {
    const receivedAt = new Date(dto.receivedAt);

    // Re-derive everything the money path depends on from the raw body.
    const rules = await this.rules.listEnabled();
    const classification = classifySender(dto.sender, rules);
    const amountCents = parseAmountCents(dto.message);
    const reference = parseReference(dto.message);
    const willForward = !!classification?.forwardToBackend && amountCents != null;

    // Idempotency layer 1: the device outbox mirror.
    let record;
    try {
      record = await this.prisma.deviceSmsEvent.create({
        data: {
          deviceId: device.id,
          sender: dto.sender,
          messageHash: dto.messageHash,
          receivedAt,
          simSlot: dto.simSlot ?? null,
          subscriptionId: dto.subscriptionId ?? null,
          brand: classification?.brand ?? null,
          provider: (classification?.provider as any) ?? null,
          amountCents: amountCents ?? undefined,
          reference: reference ?? undefined,
          matchStatus: willForward ? null : 'LOCAL_ONLY',
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return this.handleDuplicate(device.id, dto, classification, amountCents, reference, willForward, receivedAt);
      }
      throw e;
    }

    if (!willForward) {
      return this.result(record.id, false, classification, amountCents, reference, false, 'LOCAL_ONLY');
    }
    return this.forward(record.id, device.id, classification!, amountCents!, reference, receivedAt, dto.message);
  }

  /**
   * A re-POST of an already-seen SMS. If the prior event was recorded but never
   * successfully forwarded (e.g. the matching call failed last time), forward it
   * now — the matching engine is itself idempotent, so this can never
   * double-credit. Otherwise report the stored outcome as a duplicate.
   */
  private async handleDuplicate(
    deviceId: string,
    dto: DeviceSmsEventDto,
    classification: ReturnType<typeof classifySender>,
    amountCents: number | null,
    reference: string | null,
    willForward: boolean,
    receivedAt: Date,
  ): Promise<SmsEventResult> {
    const prior = await this.prisma.deviceSmsEvent.findUnique({
      where: { deviceId_messageHash: { deviceId, messageHash: dto.messageHash } },
    });
    if (prior && !prior.forwarded && willForward) {
      return this.forward(prior.id, deviceId, classification!, amountCents!, reference, receivedAt, dto.message, true);
    }
    return {
      eventId: prior?.id ?? '',
      duplicate: true,
      brand: prior?.brand ?? classification?.brand ?? null,
      provider: (prior?.provider as PaymentMethod | null) ?? classification?.provider ?? null,
      amountCents: prior?.amountCents ?? amountCents,
      reference: prior?.reference ?? reference,
      forwarded: prior?.forwarded ?? false,
      status: prior?.matchStatus ?? 'DUPLICATE',
    };
  }

  private async forward(
    recordId: string,
    deviceId: string,
    classification: NonNullable<ReturnType<typeof classifySender>>,
    amountCents: number,
    reference: string | null,
    receivedAt: Date,
    rawMessage: string,
    duplicate = false,
  ): Promise<SmsEventResult> {
    const record = await this.prisma.deviceSmsEvent.findUnique({
      where: { id: recordId },
      select: { messageHash: true },
    });
    const matched = await this.matching.ingest({
      provider: classification.provider as any,
      amountCents,
      reference: reference ?? undefined,
      occurredAt: receivedAt.toISOString(),
      rawMessage,
      deviceId,
      // One SMS = one transfer event. Without this the dedupe identity would be
      // provider+sender+amount, and a student's second transfer of the same
      // amount would be swallowed as a duplicate and never credited.
      externalId: record?.messageHash,
    });
    await this.prisma.deviceSmsEvent.update({
      where: { id: recordId },
      data: { forwarded: true, paymentEventId: matched.eventId, matchStatus: matched.status },
    });
    this.logger.log(`SMS event ${recordId} forwarded → ${matched.status}`);
    return this.result(recordId, duplicate, classification, amountCents, reference, true, matched.status);
  }

  private result(
    eventId: string,
    duplicate: boolean,
    classification: ReturnType<typeof classifySender>,
    amountCents: number | null,
    reference: string | null,
    forwarded: boolean,
    status: string,
  ): SmsEventResult {
    return {
      eventId,
      duplicate,
      brand: classification?.brand ?? null,
      provider: classification?.provider ?? null,
      amountCents,
      reference,
      forwarded,
      status,
    };
  }
}
