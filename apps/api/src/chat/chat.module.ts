import { Module } from '@nestjs/common';
import { AcademyModule } from '../academy/academy.module';
import { AcademyOpsModule } from '../academy-ops/academy-ops.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ChatAttachmentsService } from './chat-attachments.service';
import { ChatReactionsService } from './chat-reactions.service';
import { ChatFilesController } from './chat-files.controller';
import { ConversationPolicy } from './conversation-policy';
import { GroupChatController, GroupChatManageController } from './group-chat.controller';
import { GroupChatService } from './group-chat.service';

@Module({
  // StaffScopeService: staff reach is scoped. AcademyOpsAccessService: a
  // group's chat is managed under the group's own scope.
  imports: [AcademyModule, AcademyOpsModule, FeatureFlagsModule],
  controllers: [
    ChatController,
    ChatFilesController,
    GroupChatManageController,
    GroupChatController,
  ],
  providers: [
    ChatService,
    ChatAttachmentsService,
    ChatReactionsService,
    ConversationPolicy,
    GroupChatService,
  ],
  exports: [ChatService, ConversationPolicy],
})
export class ChatModule {}
