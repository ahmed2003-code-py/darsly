import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Request, Response } from 'express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload } from '@darsly/shared-types';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { IsOptionalId } from '../common/validation';
import { StorageProvider } from '../storage/storage.provider';
import { ChatService, CHAT_MESSAGE_MAX_LEN, VOICE_MAX_BYTES } from './chat.service';

class SendMessageDto {
  @IsOptionalId() threadId?: string;
  @IsOptionalId() replyToId?: string;
  @IsOptionalId() tenantId?: string;
  @IsOptionalId() studentId?: string;
  @IsString() @MinLength(1) @MaxLength(CHAT_MESSAGE_MAX_LEN) body: string;
  @IsOptionalId() lessonId?: string;
  // A day of video: past that the timestamp is a typo, not a seek position.
  @IsOptional() @IsInt() @Min(0) @Max(86_400) videoTimestampSec?: number;
}

/** Open the conversation with someone — the student for a teacher, the academy
 *  for a student — without having to post a message to create it. */
class OpenThreadDto {
  @IsOptionalId() studentId?: string;
  @IsOptionalId() tenantId?: string;
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
  constructor(
    private readonly chat: ChatService,
    private readonly storage: StorageProvider,
  ) {}

  @Get('threads')
  @ApiOperation({ summary: 'My chat threads (student: my teachers; teacher: my tenant)' })
  threads(@CurrentUser() user: JwtPayload) {
    return this.chat.listThreads(user);
  }

  @Post('threads')
  @HttpCode(200)
  @ApiOperation({ summary: 'Open (or find) the conversation with someone' })
  open(@CurrentUser() user: JwtPayload, @Body() dto: OpenThreadDto) {
    return this.chat.openThread(user, dto);
  }

  @Delete('threads/:id')
  @ApiOperation({ summary: 'Take a conversation off my own list' })
  clear(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.chat.clearThread(user, id);
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

  @Post('threads/:id/voice')
  @HttpCode(200)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Send a voice note (multipart: file, durationSec)' })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: VOICE_MAX_BYTES },
    }),
  )
  voice(
    @CurrentUser() user: JwtPayload,
    @Param('id') threadId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    // Multipart text fields skip the global transforming pipe, so they are read
    // and coerced here rather than through a DTO.
    @Body('durationSec') durationSec: string,
    @Body('replyToId') replyToId?: string,
  ) {
    if (!file) throw new BadRequestException('file is required');
    return this.chat.sendVoiceNote(
      user,
      threadId,
      { buffer: file.buffer, mimetype: file.mimetype },
      Number(durationSec),
      replyToId || undefined,
    );
  }

  @Get('messages/:id/voice')
  @ApiOperation({ summary: 'Stream a voice note (participants only)' })
  async voiceAudio(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const message = await this.chat.voiceNote(user, id);
    // Range support: without it a browser can only play the clip from the start
    // and cannot scrub it.
    const range = parseRange(req.headers['range']);
    const obj = await this.storage.getStream(message.audioKey, range ?? undefined);
    res.setHeader('Content-Type', message.audioMimeType ?? 'audio/webm');
    // Private by definition — this is one person talking to one other person.
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('Accept-Ranges', 'bytes');
    if (obj.range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${obj.range.start}-${obj.range.end}/${obj.totalSize}`);
    }
    res.setHeader('Content-Length', String(obj.contentLength));
    obj.stream.pipe(res);
  }
}

function parseRange(header?: string): { start: number; end?: number } | null {
  if (!header?.startsWith('bytes=')) return null;
  const [s, e] = header.replace('bytes=', '').split('-');
  const start = Number(s);
  if (Number.isNaN(start)) return null;
  return { start, end: e ? Number(e) : undefined };
}
