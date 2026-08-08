import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { CurrentDevice, CurrentDeviceCtx, DeviceAuthGuard } from './device-auth.guard';
import { DeviceAuthService } from './device-auth.service';
import { DeviceTokenService } from './device-token.service';
import { SenderRulesService } from './sender-rules.service';
import { SmsEventsService } from './sms-events.service';
import { DeviceRefreshDto, DeviceRequestOtpDto, DeviceSmsEventDto, DeviceVerifyOtpDto } from './dto';

/**
 * SMS-listener device API. All routes are @Public() to the global user-session
 * guard; the authenticated routes carry DeviceAuthGuard for device-scoped JWTs.
 */
@ApiTags('device')
@Controller('device')
export class DeviceController {
  constructor(
    private readonly auth: DeviceAuthService,
    private readonly tokens: DeviceTokenService,
    private readonly rules: SenderRulesService,
    private readonly smsEvents: SmsEventsService,
  ) {}

  // ── Auth / registration ────────────────────────────────────────────────────

  @Public()
  @Post('auth/request-otp')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: '[device] Send an OTP to the phone number' })
  requestOtp(@Body() dto: DeviceRequestOtpDto) {
    return this.auth.requestOtp(dto.phone);
  }

  @Public()
  @Post('auth/verify-otp')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: '[device] Verify OTP, register the device, issue tokens' })
  verifyOtp(@Body() dto: DeviceVerifyOtpDto) {
    return this.auth.verifyOtp(dto.phone, dto.code, { model: dto.model, appVersion: dto.appVersion });
  }

  @Public()
  @Post('auth/refresh')
  @HttpCode(200)
  @ApiOperation({ summary: '[device] Rotate the device refresh token' })
  refresh(@Body() dto: DeviceRefreshDto) {
    return this.tokens.rotate(dto.refreshToken);
  }

  // ── Authenticated device routes ────────────────────────────────────────────

  @Get('me')
  @Public()
  @UseGuards(DeviceAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[device] Current device + verified phone status' })
  me(@CurrentDevice() device: CurrentDeviceCtx) {
    return this.auth.me(device.id);
  }

  @Post('heartbeat')
  @Public()
  @HttpCode(200)
  @UseGuards(DeviceAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[device] Liveness ping — updates lastSeen, returns server time' })
  heartbeat(@CurrentDevice() device: CurrentDeviceCtx) {
    return this.auth.heartbeat(device.id);
  }

  @Post('unregister')
  @Public()
  @HttpCode(200)
  @UseGuards(DeviceAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[device] Secure logout — revoke this device' })
  async unregister(@CurrentDevice() device: CurrentDeviceCtx) {
    await this.tokens.revoke(device.id, 'DEVICE_UNREGISTERED');
    return { ok: true };
  }

  @Get('sms-rules')
  @Public()
  @UseGuards(DeviceAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[device] Backend-driven sender classification rules' })
  smsRules() {
    return this.rules.listEnabled();
  }

  @Post('sms-events')
  @Public()
  @HttpCode(200)
  @UseGuards(DeviceAuthGuard)
  @ApiBearerAuth()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: '[device] Ingest a received SMS (idempotent on messageHash)' })
  smsEvent(@CurrentDevice() device: CurrentDeviceCtx, @Body() dto: DeviceSmsEventDto) {
    return this.smsEvents.ingest(device, dto);
  }
}
