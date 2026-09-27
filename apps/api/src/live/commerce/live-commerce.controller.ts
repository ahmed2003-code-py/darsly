import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtPayload, Role } from '@darsly/shared-types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { LiveCommerceService } from './live-commerce.service';
import { DeclareTransferDto, TransferClaimBodyDto } from './transfer.dto';

class CouponDto {
  @IsOptional() @IsString() @MaxLength(24) couponCode?: string;
}

/** Buying a seat on a PAID live session (registered students). */
@ApiTags('live')
@ApiBearerAuth()
@Controller()
export class LiveCommerceController {
  constructor(private readonly commerce: LiveCommerceService) {}

  @Get('live/:id/offer')
  @Roles(Role.STUDENT)
  @ApiOperation({ summary: '[student] What a seat costs, seats left, the rules — and my purchase if any' })
  offer(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Query('coupon') coupon?: string) {
    return this.commerce.quote(id, u.sub, coupon?.slice(0, 24));
  }

  @Post('live/:id/purchase')
  @Roles(Role.STUDENT)
  @HttpCode(200)
  @ApiOperation({ summary: '[student] Hold a seat to pay for by transfer (idempotent)' })
  hold(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() dto: CouponDto) {
    return this.commerce.hold(u.sub, id, dto?.couponCode);
  }

  @Post('live/:id/purchase/wallet')
  @Roles(Role.STUDENT)
  @HttpCode(200)
  @ApiOperation({ summary: '[student] Buy a seat from the Darsly Wallet — reserved, paid and confirmed at once' })
  payWithWallet(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() dto: CouponDto) {
    return this.commerce.payWithWallet(u.sub, id, dto?.couponCode);
  }

  @Post('live/purchases/:purchaseId/declare')
  @Roles(Role.STUDENT)
  @HttpCode(200)
  @ApiOperation({ summary: '[student] Before transferring: say where the money comes from (creates the PENDING payment)' })
  declare(@CurrentUser() u: JwtPayload, @Param('purchaseId') purchaseId: string, @Body() dto: DeclareTransferDto) {
    return this.commerce.declareTransfer(u.sub, purchaseId, dto);
  }

  @Post('live/purchases/:purchaseId/transfer')
  @Roles(Role.STUDENT)
  @HttpCode(200)
  @ApiOperation({ summary: '[student] Send the transfer proof for a held seat' })
  transfer(@CurrentUser() u: JwtPayload, @Param('purchaseId') purchaseId: string, @Body() dto: TransferClaimBodyDto) {
    return this.commerce.submitTransfer(u.sub, purchaseId, dto);
  }

  @Post('live/purchases/:purchaseId/cancel')
  @Roles(Role.STUDENT)
  @HttpCode(200)
  @ApiOperation({ summary: '[student] Give a seat back; the refund follows the policy stored with the purchase' })
  cancel(@CurrentUser() u: JwtPayload, @Param('purchaseId') purchaseId: string) {
    return this.commerce.cancelByStudent(u.sub, purchaseId);
  }

  @Get('live/purchases/mine')
  @Roles(Role.STUDENT)
  @ApiOperation({ summary: '[student] My live-session purchases' })
  mine(@CurrentUser() u: JwtPayload) {
    return this.commerce.mine(u.sub);
  }
}
