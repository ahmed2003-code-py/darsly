import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { Public } from '../../common/decorators/public.decorator';
import { LiveCommerceService } from './live-commerce.service';
import { DeclareTransferDto, TransferClaimBodyDto } from './transfer.dto';

const REFUND_METHODS = ['INSTAPAY', 'VODAFONE_CASH', 'BANK_TRANSFER'] as const;

class GuestHoldDto {
  @IsString() @MaxLength(80) displayName: string;
  @IsOptional() @IsString() @MaxLength(24) couponCode?: string;
}

class RefundDestinationDto {
  @IsOptional() @IsIn(REFUND_METHODS) method?: (typeof REFUND_METHODS)[number];
  @IsOptional() @IsString() @MaxLength(80) holderName?: string;
  @IsOptional() @IsString() @MaxLength(64) handle?: string;
}

/**
 * Buying a live seat without an account.
 *
 * The session page is public; everything after the purchase is addressed by
 * its access secret (256 random bits, stored only hashed). Unknown and
 * malformed secrets get the same 404, and every route here is rate-limited
 * per client, so guessing is both blind and slow. None of these routes ever
 * returns a provider room URL or credential: entering the class goes through
 * a short-lived GUEST token that the classroom's own checks accept only for
 * this one session.
 */
@ApiTags('public/live')
@Public()
@Controller('public/live')
export class PublicLiveController {
  constructor(private readonly commerce: LiveCommerceService) {}

  @Get(':id')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: '[public] A paid session’s page: what it is, what a seat costs, seats left',
  })
  offer(@Param('id') id: string) {
    return this.commerce.publicOffer(id);
  }

  @Post(':id/guest-purchase')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 600_000 } })
  @ApiOperation({ summary: '[public] Hold a seat as a guest; returns the access secret ONCE' })
  hold(@Param('id') id: string, @Body() dto: GuestHoldDto) {
    return this.commerce.guestHold(id, dto.displayName, dto.couponCode);
  }

  @Get('access/:token')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: '[public] A guest’s purchase, by its access secret' })
  status(@Param('token') token: string) {
    return this.commerce.guestStatus(token);
  }

  @Post('access/:token/declare')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 600_000 } })
  @ApiOperation({
    summary: '[public] Before transferring: a guest says where the money comes from',
  })
  declare(@Param('token') token: string, @Body() dto: DeclareTransferDto) {
    return this.commerce.guestDeclareTransfer(token, dto);
  }

  @Post('access/:token/transfer')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 600_000 } })
  @ApiOperation({ summary: '[public] A guest sends the transfer proof' })
  transfer(@Param('token') token: string, @Body() dto: TransferClaimBodyDto) {
    return this.commerce.guestSubmitTransfer(token, dto);
  }

  @Post('access/:token/classroom')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: '[public] A short-lived token for this one classroom (confirmed seats only)',
  })
  classroom(@Param('token') token: string) {
    return this.commerce.guestClassroomToken(token);
  }

  @Post('access/:token/cancel')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 600_000 } })
  @ApiOperation({
    summary: '[public] A guest gives the seat back (refund to the account named, if one is due)',
  })
  cancel(@Param('token') token: string, @Body() dto: RefundDestinationDto) {
    return this.commerce.guestCancel(token, dto);
  }

  @Post('access/:token/refunds/:refundId/destination')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 600_000 } })
  @ApiOperation({ summary: '[public] Where to send a refund owed to a guest' })
  destination(
    @Param('token') token: string,
    @Param('refundId') refundId: string,
    @Body() dto: RefundDestinationDto,
  ) {
    return this.commerce.guestRefundDestination(token, refundId, dto);
  }
}
