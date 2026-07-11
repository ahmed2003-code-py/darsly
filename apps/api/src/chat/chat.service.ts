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

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
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
      include: { sender: { select: { id: true, fullName: true, role: true } } },
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

    throw new BadRequestException('Teachers reply within an existing thread');
  }

  async sendMessage(user: JwtPayload, payload: SendMessagePayload) {
    const body = payload.body.trim();
    if (!body) throw new BadRequestException('Empty message');
    const thread = await this.resolveThread(user, payload);

    const message = await this.prisma.chatMessage.create({
      data: { threadId: thread.id, senderId: user.sub, body },
      include: { sender: { select: { id: true, fullName: true, role: true } } },
    });
    await this.prisma.chatThread.update({
      where: { id: thread.id },
      data: { updatedAt: new Date() },
    });

    // Realtime: deliver to BOTH participants' personal rooms so it arrives live
    // whether or not they're actively viewing the thread (and to all their
    // tabs). `mine` is per-viewer, so send a viewer-correct copy to each.
    const recipientUserId = await this.recipientUserId(thread, user.sub);
    this.realtime.emitToUser(user.sub, RealtimeEvents.MESSAGE, this.toMessageDto(message, user.sub));
    if (recipientUserId) {
      this.realtime.emitToUser(recipientUserId, RealtimeEvents.MESSAGE, this.toMessageDto(message, recipientUserId));
      this.realtime.emitToUser(recipientUserId, RealtimeEvents.THREAD_UPDATED, { threadId: thread.id });
      await this.notifications.create({
        userId: recipientUserId,
        type: 'CHAT_MESSAGE',
        title: `رسالة جديدة من ${message.sender.fullName}`,
        body: body.length > 80 ? body.slice(0, 80) + '…' : body,
        meta: { threadId: thread.id },
      });
    }

    return { message: this.toMessageDto(message, user.sub), threadId: thread.id };
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
