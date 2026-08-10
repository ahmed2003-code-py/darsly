import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { JwtPayload } from '@darsly/shared-types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { StartCheckoutDto } from './dto/start-checkout.dto';
import { XPayConfig } from './xpay.config';
import { XPayService } from './xpay.service';

@ApiTags('payments/xpay')
@Controller('payments/xpay')
export class XPayController {
  constructor(
    private readonly xpay: XPayService,
    private readonly config: XPayConfig,
  ) {}

  @Post('checkout')
  @Throttle({ default: { limit: 20, ttl: 3_600_000 } })
  @ApiOperation({ summary: 'Start a card payment for a course; returns the checkout link' })
  checkout(@CurrentUser() user: JwtPayload, @Body() dto: StartCheckoutDto) {
    return this.xpay.startCheckout(user.sub, dto.courseId, dto.couponCode);
  }

  /**
   * The webhook.
   *
   * Public by necessity — XPay has no session with us — so the signature is the
   * only thing standing between this endpoint and a stranger granting
   * themselves a course. It is verified against the *raw* body: re-serialising
   * the parsed JSON changes key order and whitespace, and the signature is over
   * bytes, not over meaning.
   */
  @Public()
  @Post('webhook')
  @ApiOperation({ summary: 'XPay webhook receiver (signature-verified)' })
  async webhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers() headers: Record<string, string>,
  ) {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const signature = headers[this.config.signatureHeader.toLowerCase()];

    if (!this.xpay.verifySignature(raw, signature)) {
      // Deliberately says nothing about why. A caller probing for the right
      // header name or secret length learns nothing from the response.
      throw new UnauthorizedException('Invalid signature');
    }

    let event: { type?: string; data?: Record<string, unknown> };
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new BadRequestException('Malformed event');
    }

    // Always 200 on a verified event, even when we choose not to act on it —
    // a provider that reads a 4xx as "retry forever" would hammer us over an
    // event type we simply do not care about.
    return this.xpay.handleEvent(event);
  }
}
