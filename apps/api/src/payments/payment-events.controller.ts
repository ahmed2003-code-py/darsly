import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsEnum, IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { JwtPayload, PaymentMethod, Role } from '@darsly/shared-types';
import * as crypto from 'crypto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { IsOptionalId, LIMITS } from '../common/validation';
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
}

@ApiTags('payments')
@Controller()
export class PaymentEventsController {
  constructor(private readonly matching: PaymentMatchingService) {}

  // ── Android notification listener → backend ────────────────────────────────

  @Post('payment-events')
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: '[device] Ingest a transfer notification (X-Listener-Key auth)' })
  ingest(@Headers('x-listener-key') key: string | undefined, @Body() dto: PaymentEventDto) {
    const expected = process.env.PAYMENT_LISTENER_KEY;
    if (!expected) {
      throw new ServiceUnavailableException({ message: 'Listener not configured', code: 'LISTENER_UNSET' });
    }
    const ok = !!key && key.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expected));
    if (!ok) throw new UnauthorizedException('Invalid listener key');
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
  manualMatch(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Param('paymentId') paymentId: string) {
    return this.matching.manualMatch(id, paymentId, u.sub);
  }
}
