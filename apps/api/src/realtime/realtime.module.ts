import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ChatModule } from '../chat/chat.module';
import { ChatGateway } from './chat.gateway';
import { RealtimeService } from './realtime.service';

/**
 * Global so any module can inject RealtimeService to push events. Imports
 * ChatModule for the gateway's message handling (ChatService also injects
 * RealtimeService — no cycle since RealtimeService has no deps).
 */
@Global()
@Module({
  imports: [JwtModule.register({}), ChatModule],
  providers: [RealtimeService, ChatGateway],
  exports: [RealtimeService],
})
export class RealtimeModule {}
