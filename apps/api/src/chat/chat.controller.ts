import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload } from '@darsly/shared-types';
import { IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ChatService, CHAT_MESSAGE_MAX_LEN } from './chat.service';

class SendMessageDto {
  @IsOptional() @IsString() threadId?: string;
  @IsOptional() @IsString() tenantId?: string;
  @IsString() @MinLength(1) @MaxLength(CHAT_MESSAGE_MAX_LEN) body: string;
  @IsOptional() @IsString() lessonId?: string;
  @IsOptional() @IsInt() @Min(0) videoTimestampSec?: number;
}

/**
 * REST surface for chat (initial load + a no-socket fallback for sending).
 * Live delivery goes through the Socket.io gateway; both paths share
 * ChatService so persistence + authorization are identical.
 */
@ApiTags('chat')
@ApiBearerAuth()
@Controller('chat')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get('threads')
  @ApiOperation({ summary: 'My chat threads (student: my teachers; teacher: my tenant)' })
  threads(@CurrentUser() user: JwtPayload) {
    return this.chat.listThreads(user);
  }

  @Get('threads/:id/messages')
  @ApiOperation({ summary: 'Messages in a thread (marks them read)' })
  messages(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.chat.getMessages(user, id);
  }

  @Post('messages')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a message (creates the thread if needed) — REST fallback' })
  send(@CurrentUser() user: JwtPayload, @Body() dto: SendMessageDto) {
    return this.chat.sendMessage(user, dto);
  }
}
