import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DeviceController } from './device.controller';
import { DeviceAuthService } from './device-auth.service';
import { DeviceTokenService } from './device-token.service';
import { DeviceAuthGuard } from './device-auth.guard';
import { SenderRulesService } from './sender-rules.service';
import { SmsEventsService } from './sms-events.service';

/**
 * SMS-listener device module. Reuses OtpService (via AuthModule) and the global
 * PaymentsModule's PaymentMatchingService; adds device-scoped auth + SMS event
 * ingestion. JwtModule and PrismaModule are already global.
 */
@Module({
  imports: [AuthModule],
  controllers: [DeviceController],
  providers: [
    DeviceAuthService,
    DeviceTokenService,
    DeviceAuthGuard,
    SenderRulesService,
    SmsEventsService,
  ],
})
export class DeviceModule {}
