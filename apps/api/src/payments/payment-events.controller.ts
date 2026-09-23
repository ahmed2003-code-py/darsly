import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { JwtPayload, PaymentMethod, Role } from '@darsly/shared-types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { IsOptionalId, LIMITS } from '../common/validation';
import { ListenerKeyGuard } from './listener-key.guard';
import { PaymentMatchingService } from './payment-matching.service';

class PaymentEventDto {
  @IsEnum(PaymentMethod) provider: PaymentMethod;
  /** integer piasters (EGP × 100) */
  @IsInt() @Min(1) @Max(100_000_000) amountCents: number;
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
  @IsOptional() @IsISO8601() occurredAt?: string;
  // The raw bank SMS, kept for the matcher's audit trail.
  @IsOptional() @IsString() @MaxLength(LIMITS.NOTE) rawMessage?: string;
  @IsOptionalId() deviceId?: string;
  /**
   * A globally unique id for the transfer event itself — the listener's SMS
   * hash. It is what the matcher prefers for idempotency, and it could not be
   * sent: this DTO never declared it, and the global pipe rejects unknown
   * fields, so any caller supplying one got a 400 and any caller omitting it
   * fell back to the weaker `provider:reference:amount` key.
   *
   * That fallback is not equivalent. A wallet SMS carries no transaction id, so
   * the reference is the sender's mobile number, which is the same on every
   * transfer they make — and keying on provider+reference+amount then reads a
   * student's *second* transfer of the same amount (a monthly renewal, or a
   * second course at the same price) as a duplicate of the first, and silently
   * never credits it. The in-process device route has always passed this;
   * only this key-authenticated route could not.
   */
  @IsOptional() @IsString() @MaxLength(200) externalId?: string;
  /**
   * Every identifier the raw message could be matched on. Same story: the
   * matcher reads it, the wire could not carry it, so this route matched on
   * `reference` alone while the device route matched on all of them.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  identities?: string[];
}

@ApiTags('payments')
@Controller()
export class PaymentEventsController {
  constructor(private readonly matching: PaymentMatchingService) {}

  // ── Android notification listener → backend ────────────────────────────────

  /**
   * Legacy ingest. The current path is `POST /device/sms-events`, which
   * authenticates a per-device JWT and can be revoked one device at a time.
   *
   * Authentication is a guard rather than the first lines of this method, so
   * it runs before the global ValidationPipe: an unauthenticated caller used
   * to be answered with this endpoint's full DTO schema instead of a 401.
   */
  @Post('payment-events')
  @Public()
  @UseGuards(ListenerKeyGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary:
      '[device, legacy] Ingest a transfer notification (X-Listener-Key auth); prefer POST /device/sms-events',
  })
  ingest(@Body() dto: PaymentEventDto) {
    return this.matching.ingest(dto);
  }

  // ── Admin ──────────────────────────────────────────────────────────────────

  @Get('admin/payment-events')
  @ApiBearerAuth()
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: '[admin] Incoming transfer events (matched/unmatched)' })
  list(@Query('status') status?: string) {
    return this.matching.listEvents(status);
  }

  @Post('admin/payment-events/:id/match/:paymentId')
  @ApiBearerAuth()
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: '[admin] Resolve an unmatched event → verify a payment' })
  manualMatch(
    @CurrentUser() u: JwtPayload,
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
  ) {
    return this.matching.manualMatch(id, paymentId, u.sub);
  }
}
