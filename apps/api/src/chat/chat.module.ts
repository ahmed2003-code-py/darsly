import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ChatAttachmentsService } from './chat-attachments.service';
import { ChatReactionsService } from './chat-reactions.service';
import { ChatFilesController } from './chat-files.controller';

@Module({
  controllers: [ChatController, ChatFilesController],
  providers: [ChatService, ChatAttachmentsService, ChatReactionsService],
  exports: [ChatService],
})
export class ChatModule {}
