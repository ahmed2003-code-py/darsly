import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ChatMessageDto,
  ChatThreadDto,
  JwtPayload,
  RealtimeEvents,
  Role,
  SendMessagePayload,
} from '@darsly/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.service';
import { StorageProvider } from '../storage/storage.provider';

/** Max stored chat message length — shared by the REST DTO and the socket path. */
export const CHAT_MESSAGE_MAX_LEN = 4000;

/** A voice note is a thought, not a lecture. */
export const VOICE_MAX_SECONDS = 300;
export const VOICE_MAX_BYTES = 10 * 1024 * 1024;
/** What a browser's MediaRecorder actually produces, across the ones we serve. */
const VOICE_MIME = /^audio\/(webm|ogg|mp4|mpeg|aac|wav)(;.*)?$/;

/**
 * What every read of a message needs: who sent it, and enough of the message it
 * answers to draw the quote. One level deep on purpose — a quote of a quote is
 * noise, and following the chain would be an unbounded join.
 */
const MESSAGE_INCLUDE = {
  sender: { select: { id: true, fullName: true, role: true } },
  replyTo: {
    select: {
      id: true,
      body: true,
      audioKey: true,
      sender: { select: { fullName: true } },
    },
  },
} as const;

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
    private readonly storage: StorageProvider,
  ) {}

  // ── Identity helpers ──────────────────────────────────────────────────────

  private async studentId(userId: string): Promise<string | null> {
    const s = await this.prisma.studentProfile.findUnique({ where: { userId } });
    return s?.id ?? null;
  }

  /** True if the user is a participant in the thread (student, tenant teacher, or admin). */
  async canAccessThread(user: JwtPayload, threadId: string): Promise<boolean> {
    const thread = await this.prisma.chatThread.findUnique({ where: { id: threadId } });
    if (!thread) return false;
    if (user.role === Role.SUPER_ADMIN) return true;
    if (user.role === Role.TEACHER) return thread.tenantId === user.tenantId;
    const sid = await this.studentId(user.sub);
    return !!sid && thread.studentId === sid;
  }

  // ── Threads ───────────────────────────────────────────────────────────────

  async listThreads(user: JwtPayload): Promise<ChatThreadDto[]> {
    const where =
      user.role === Role.TEACHER
        ? { tenantId: user.tenantId }
        : { studentId: (await this.studentId(user.sub)) ?? '__none__' };

    const threads = await this.prisma.chatThread.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      include: {
        teacher: { include: { user: { select: { fullName: true, avatarUrl: true } } } },
        student: { include: { user: { select: { fullName: true, avatarUrl: true } } } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    return Promise.all(threads.map((th) => this.toThreadDto(th, user)));
  }

  private async toThreadDto(thread: any, user: JwtPayload): Promise<ChatThreadDto> {
    const isTeacher = user.role === Role.TEACHER;
    const counterpart = isTeacher ? thread.student.user : thread.teacher.user;
    const unread = await this.prisma.chatMessage.count({
      where: {
        threadId: thread.id,
        readAt: null,
        NOT: { sender: { id: user.sub } },
      },
    });
    let lessonTitle: string | null = null;
    if (thread.lessonId) {
      const l = await this.prisma.lesson.findUnique({
        where: { id: thread.lessonId },
        select: { title: true },
      });
      lessonTitle = l?.title ?? null;
    }
    const last = thread.messages?.[0];
    return {
      id: thread.id,
      type: thread.type,
      tenantId: thread.tenantId,
      studentId: thread.studentId,
      counterpartName: counterpart.fullName,
      counterpartAvatarUrl: counterpart.avatarUrl ?? null,
      lessonId: thread.lessonId,
      lessonTitle,
      videoTimestampSec: thread.videoTimestampSec,
      lastMessage: last?.body ?? null,
      lastMessageAt: last?.createdAt?.toISOString() ?? null,
      unread,
      updatedAt: thread.updatedAt.toISOString(),
    };
  }

  async getMessages(user: JwtPayload, threadId: string): Promise<ChatMessageDto[]> {
    if (!(await this.canAccessThread(user, threadId))) throw new ForbiddenException('Not your thread');
    const messages = await this.prisma.chatMessage.findMany({
      where: { threadId },
      orderBy: { createdAt: 'asc' },
      take: 200,
      include: MESSAGE_INCLUDE,
    });
    await this.markThreadRead(user, threadId);
    return messages.map((m) => this.toMessageDto(m, user.sub));
  }

  private toMessageDto(m: any, viewerUserId: string): ChatMessageDto {
    return {
      id: m.id,
      threadId: m.threadId,
      senderId: m.senderId,
      senderName: m.sender.fullName,
      senderRole: m.sender.role,
      body: m.body,
      readAt: m.readAt?.toISOString() ?? null,
      createdAt: m.createdAt.toISOString(),
      mine: m.senderId === viewerUserId,
      replyTo: m.replyTo
        ? {
            id: m.replyTo.id,
            senderName: m.replyTo.sender?.fullName ?? '',
            body: m.replyTo.body,
            isVoice: !!m.replyTo.audioKey,
          }
        : null,
      audio: m.audioKey
        ? { durationSec: m.audioDurationSec ?? 0, bytes: m.audioBytes ?? 0 }
        : null,
    };
  }

  /** Mark all messages from the OTHER party in this thread as read. */
  async markThreadRead(user: JwtPayload, threadId: string) {
    if (!(await this.canAccessThread(user, threadId))) return;
    await this.prisma.chatMessage.updateMany({
      where: { threadId, readAt: null, NOT: { senderId: user.sub } },
      data: { readAt: new Date() },
    });
  }

  /**
   * Resolve (or create) the thread for a message, enforcing that a student may
   * only message a teacher they're enrolled with. Returns thread + recipient.
   */
  private async resolveThread(user: JwtPayload, payload: SendMessagePayload) {
    if (payload.threadId) {
      const thread = await this.prisma.chatThread.findUnique({ where: { id: payload.threadId } });
      if (!thread || !(await this.canAccessThread(user, payload.threadId))) {
        throw new ForbiddenException('Not your thread');
      }
      return thread;
    }

    // New thread — the initiator picks the counterpart tenant.
    if (user.role === Role.STUDENT) {
      const sid = await this.studentId(user.sub);
      if (!sid) throw new BadRequestException('No student profile');
      if (!payload.tenantId) throw new BadRequestException('tenantId required to start a chat');
      // Enrollment gate: a student can only DM a teacher they study with.
      const enrolled = await this.prisma.enrollment.findFirst({
        where: { studentId: sid, tenantId: payload.tenantId, status: 'ACTIVE' },
      });
      if (!enrolled) throw new ForbiddenException('You can only message teachers you are enrolled with');
      const type = payload.lessonId ? 'QA' : 'DM';
      const existing = await this.prisma.chatThread.findFirst({
        where: { tenantId: payload.tenantId, studentId: sid, type, lessonId: payload.lessonId ?? null },
      });
      if (existing) return existing;
      return this.prisma.chatThread.create({
        data: {
          tenantId: payload.tenantId,
          studentId: sid,
          type,
          lessonId: payload.lessonId,
          videoTimestampSec: payload.videoTimestampSec,
        },
      });
    }

    // A teacher writing first. This used to be refused outright, which meant a
    // teacher looking at a student in their console had no way to reach them
    // except WhatsApp — the student had to open the conversation before the
    // teacher could say anything in it.
    const tenantId = user.tenantId;
    if (!tenantId) throw new BadRequestException('No academy on this account');
    if (!payload.studentId) throw new BadRequestException('studentId required to start a chat');
    // The same gate as the student's, read from the other side: they must share
    // an enrolment. Any status, including a revoked one — telling a student why
    // their access ended is exactly the message this exists for.
    const shares = await this.prisma.enrollment.findFirst({
      where: { studentId: payload.studentId, tenantId },
    });
    if (!shares) throw new ForbiddenException('You can only message your own students');
    const open = await this.prisma.chatThread.findFirst({
      where: { tenantId, studentId: payload.studentId, type: 'DM', lessonId: null },
    });
    if (open) return open;
    return this.prisma.chatThread.create({
      data: { tenantId, studentId: payload.studentId, type: 'DM' },
    });
  }

  /**
   * Find the conversation with someone, opening it if it does not exist yet.
   *
   * Separate from sending because a deep link — the message button next to a
   * student in the console — has to land in the conversation with the composer
   * ready, not post something to get there.
   */
  async openThread(user: JwtPayload, payload: { studentId?: string; tenantId?: string }) {
    const thread = await this.resolveThread(user, { ...payload, body: '' });
    return { threadId: thread.id };
  }

  /** A reply is only valid inside its own thread; anything else is dropped. */
  private async replyTarget(threadId: string, replyToId?: string): Promise<string | null> {
    if (!replyToId) return null;
    const target = await this.prisma.chatMessage.findFirst({
      where: { id: replyToId, threadId },
      select: { id: true },
    });
    return target?.id ?? null;
  }

  /**
   * A voice note.
   *
   * The audio never becomes a public URL: it is one person talking to one other
   * person, and a guessable link is not a permission. The bytes go to private
   * storage and come back out through a route that checks the listener is in
   * the thread — the same check every other read of this conversation makes.
   */
  async sendVoiceNote(
    user: JwtPayload,
    threadId: string,
    file: { buffer: Buffer; mimetype: string },
    durationSec: number,
    replyToId?: string,
  ) {
    if (!(await this.canAccessThread(user, threadId))) throw new ForbiddenException('Not your thread');
    if (!VOICE_MIME.test(file.mimetype)) {
      throw new BadRequestException({ message: 'Unsupported audio format', code: 'VOICE_FORMAT' });
    }
    if (file.buffer.length > VOICE_MAX_BYTES) {
      throw new BadRequestException({ message: 'Voice note is too long', code: 'VOICE_TOO_LONG' });
    }
    const seconds = Math.min(VOICE_MAX_SECONDS, Math.max(1, Math.round(durationSec || 0)));

    const thread = await this.prisma.chatThread.findUniqueOrThrow({ where: { id: threadId } });
    const replyTo = await this.replyTarget(threadId, replyToId);
    const message = await this.prisma.chatMessage.create({
      data: {
        threadId,
        senderId: user.sub,
        body: '',
        replyToId: replyTo,
        audioDurationSec: seconds,
        audioBytes: file.buffer.length,
        audioMimeType: file.mimetype,
        audioKey: '',
      },
      include: MESSAGE_INCLUDE,
    });
    const audioKey = `chat-voice/${threadId}/${message.id}`;
    await this.storage.put(audioKey, file.buffer, { contentType: file.mimetype });
    const saved = await this.prisma.chatMessage.update({
      where: { id: message.id },
      data: { audioKey },
      include: MESSAGE_INCLUDE,
    });

    await this.fanOut(saved, thread, user.sub, 'رسالة صوتية 🎤');
    return { message: this.toMessageDto(saved, user.sub), threadId };
  }

  /** The stored audio for a message, once the listener is shown to be in it. */
  async voiceNote(user: JwtPayload, messageId: string) {
    const message = await this.prisma.chatMessage.findUnique({
      where: { id: messageId },
      select: { id: true, threadId: true, audioKey: true, audioMimeType: true, audioBytes: true },
    });
    if (!message?.audioKey) throw new NotFoundException('No voice note here');
    if (!(await this.canAccessThread(user, message.threadId))) {
      throw new ForbiddenException('Not your thread');
    }
    return message as { audioKey: string; audioMimeType: string | null; audioBytes: number | null };
  }

  async sendMessage(user: JwtPayload, payload: SendMessagePayload) {
    const body = payload.body?.trim() ?? '';
    if (!body) throw new BadRequestException('Empty message');
    // Authoritative length cap for BOTH transports (REST DTO + the socket gateway,
    // which the global HTTP ValidationPipe doesn't cover). Prevents multi-MB
    // messages being persisted verbatim (storage amplification / oversized pushes).
    if (body.length > CHAT_MESSAGE_MAX_LEN) {
      throw new BadRequestException({ message: 'Message too long', code: 'MESSAGE_TOO_LONG' });
    }
    const thread = await this.resolveThread(user, payload);
    // A reply only means anything inside its own conversation; quoting across
    // threads would leak one student's message into another's.
    const replyToId = await this.replyTarget(thread.id, payload.replyToId);

    const message = await this.prisma.chatMessage.create({
      data: { threadId: thread.id, senderId: user.sub, body, replyToId },
      include: MESSAGE_INCLUDE,
    });
    await this.fanOut(message, thread, user.sub, body.length > 80 ? body.slice(0, 80) + '…' : body);
    return { message: this.toMessageDto(message, user.sub), threadId: thread.id };
  }

  /**
   * Deliver a new message and tell the other side about it.
   *
   * Sent to BOTH participants' personal rooms so it arrives live whether or not
   * either is looking at the thread, and to every tab they have open. `mine` is
   * per-viewer, so each side gets its own copy of the payload.
   */
  private async fanOut(
    message: any,
    thread: { id: string; tenantId: string; studentId: string },
    senderUserId: string,
    preview: string,
  ) {
    await this.prisma.chatThread.update({
      where: { id: thread.id },
      data: { updatedAt: new Date() },
    });
    const recipientUserId = await this.recipientUserId(thread, senderUserId);
    this.realtime.emitToUser(senderUserId, RealtimeEvents.MESSAGE, this.toMessageDto(message, senderUserId));
    if (!recipientUserId) return;
    this.realtime.emitToUser(recipientUserId, RealtimeEvents.MESSAGE, this.toMessageDto(message, recipientUserId));
    this.realtime.emitToUser(recipientUserId, RealtimeEvents.THREAD_UPDATED, { threadId: thread.id });
    await this.notifications.create({
      userId: recipientUserId,
      type: 'CHAT_MESSAGE',
      title: `رسالة جديدة من ${message.sender.fullName}`,
      body: preview,
      meta: { threadId: thread.id },
    });
  }

  private async recipientUserId(thread: { tenantId: string; studentId: string }, senderUserId: string) {
    const [teacher, student] = await Promise.all([
      this.prisma.teacherProfile.findUnique({ where: { id: thread.tenantId }, select: { userId: true } }),
      this.prisma.studentProfile.findUnique({ where: { id: thread.studentId }, select: { userId: true } }),
    ]);
    const participants = [teacher?.userId, student?.userId].filter(Boolean) as string[];
    return participants.find((id) => id !== senderUserId) ?? null;
  }
}
