import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage, memoryStorage } from 'multer';
import * as os from 'os';
import { Request, Response } from 'express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload } from '@darsly/shared-types';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { IsOptionalId } from '../common/validation';
import { StorageProvider } from '../storage/storage.provider';
import {
  ChatService,
  CHAT_MESSAGE_MAX_LEN,
  CLIENT_MESSAGE_ID,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MESSAGE_PAGE_MAX,
  THREAD_PAGE_MAX,
  VOICE_MAX_BYTES,
} from './chat.service';
import { CHAT_FILE_MAX_BYTES, ChatAttachmentsService } from './chat-attachments.service';
import { ChatReactionsService } from './chat-reactions.service';

class SendMessageDto {
  @IsOptionalId() threadId?: string;
  @IsOptionalId() replyToId?: string;
  @IsOptionalId() tenantId?: string;
  @IsOptionalId() studentId?: string;
  // May be empty when the message carries attachments; the service decides.
  @IsOptional() @IsString() @MaxLength(CHAT_MESSAGE_MAX_LEN) body = '';
  @IsOptionalId() lessonId?: string;
  // A day of video: past that the timestamp is a typo, not a seek position.
  @IsOptional() @IsInt() @Min(0) @Max(86_400) videoTimestampSec?: number;
  /** The client's id for this send; a retry with the same id is stored once. */
  @IsOptional() @IsString() @Matches(CLIENT_MESSAGE_ID) clientMessageId?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ATTACHMENTS_PER_MESSAGE)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  attachmentIds?: string[];
}

class ReactDto {
  @IsString() @MaxLength(16) emoji: string;
}

class ReadDto {
  /** Read up to and including this message; omitted = the newest one. */
  @IsOptionalId() upTo?: string;
}

/** A page of conversations: `before` is the id of the last one already shown. */
class ThreadsQuery {
  @IsOptionalId() before?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(THREAD_PAGE_MAX) limit?: number;
}

/** A page of one conversation, keyed on a message of it. */
class MessagesQuery {
  @IsOptionalId() before?: string;
  @IsOptionalId() after?: string;
  @IsOptionalId() around?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(MESSAGE_PAGE_MAX) limit?: number;
}

/** Who a not-yet-existing conversation would be with. */
class ResolveQuery {
  @IsOptionalId() studentId?: string;
  @IsOptionalId() tenantId?: string;
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
    private readonly attachments: ChatAttachmentsService,
    private readonly reactions: ChatReactionsService,
  ) {}

  @Post('attachments')
  @HttpCode(200)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload a file for a message (multipart: file + threadId | studentId | tenantId)',
  })
  @UseInterceptors(
    FileInterceptor('file', {
      // Staged on disk, never held whole in memory; the service reads the
      // bytes to decide what the file is and deletes the staged copy.
      storage: diskStorage({ destination: os.tmpdir() }),
      limits: { fileSize: CHAT_FILE_MAX_BYTES + 1, files: 1 },
    }),
  )
  upload(
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: Express.Multer.File | undefined,
    // Multipart text fields skip the global transforming pipe, so they are read
    // one by one and only ever used as ids the service authorizes.
    @Body('threadId') threadId?: string,
    @Body('studentId') studentId?: string,
    @Body('tenantId') tenantId?: string,
  ) {
    if (!file) throw new BadRequestException('file is required');
    const id = (v?: string) => (typeof v === 'string' && v && v.length <= 40 ? v : undefined);
    return this.attachments.upload(user, file, {
      threadId: id(threadId),
      studentId: id(studentId),
      tenantId: id(tenantId),
    });
  }

  @Delete('attachments/:id')
  @ApiOperation({ summary: 'Remove my upload that has not been sent yet' })
  removeUpload(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.attachments.remove(user, id);
  }

  @Put('messages/:id/reaction')
  @ApiOperation({ summary: 'React to a message (one reaction per person; replaces mine)' })
  react(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: ReactDto) {
    return this.reactions.react(user, id, dto.emoji);
  }

  @Delete('messages/:id/reaction')
  @ApiOperation({ summary: 'Remove my reaction from a message' })
  unreact(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.reactions.unreact(user, id);
  }

  @Post('threads/:id/read')
  @HttpCode(200)
  @ApiOperation({ summary: 'I have read this conversation up to a message (or its newest)' })
  read(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: ReadDto) {
    return this.chat.markReadUpTo(user, id, dto.upTo);
  }

  @Get('threads')
  @ApiOperation({ summary: 'A page of my conversations, newest activity first' })
  threads(@CurrentUser() user: JwtPayload, @Query() q: ThreadsQuery) {
    return this.chat.listThreads(user, q);
  }

  @Get('resolve')
  @ApiOperation({
    summary: 'The conversation with someone, if one exists — never creates one',
  })
  resolve(@CurrentUser() user: JwtPayload, @Query() q: ResolveQuery) {
    return this.chat.resolveTarget(user, q);
  }

  @Post('threads')
  @HttpCode(200)
  @ApiOperation({
    summary: 'DEPRECATED (tabs from before /chat/resolve): open the conversation with someone',
  })
  open(@CurrentUser() user: JwtPayload, @Body() dto: OpenThreadDto) {
    return this.chat.openThread(user, dto);
  }

  @Get('threads/:id')
  @ApiOperation({ summary: 'One conversation of mine (header for a deep link)' })
  thread(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.chat.getThread(user, id);
  }

  @Delete('threads/:id')
  @ApiOperation({ summary: 'Take a conversation off my own list' })
  clear(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.chat.clearThread(user, id);
  }

  @Get('threads/:id/messages')
  @ApiOperation({
    summary: 'A page of a thread, oldest-first: newest page, or before/after a message',
  })
  messages(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Query() q: MessagesQuery) {
    return this.chat.getMessages(user, id, q);
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
