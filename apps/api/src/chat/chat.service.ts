import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
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
import { resolveCanonicalThread, ThreadIdentity, threadKey } from './chat-thread.identity';

/** Max stored chat message length — shared by the REST DTO and the socket path. */
export const CHAT_MESSAGE_MAX_LEN = 4000;

/** Messages per page when a conversation is opened or scrolled back. */
export const MESSAGE_PAGE = 40;
export const MESSAGE_PAGE_MAX = 100;
/** Conversations per page of the list. */
export const THREAD_PAGE = 50;
export const THREAD_PAGE_MAX = 100;

/**
 * A client's id for one send, so a retry is recognised as the same send.
 * Shape-checked on both transports (the socket path skips the HTTP pipe); a
 * UUID fits, and so does anything else URL-safe of a sensible length.
 */
export const CLIENT_MESSAGE_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Which way a page of messages reads from its cursor. */
export interface MessagePageQuery {
  /** older than this message (scrolling back) */
  before?: string;
  /** newer than this message (catching up after a gap) */
  after?: string;
  limit?: number;
}

/** A voice note is a thought, not a lecture. */
export const VOICE_MAX_SECONDS = 300;
export const VOICE_MAX_BYTES = 10 * 1024 * 1024;
/** What a browser's MediaRecorder actually produces, across the ones we serve. */
const VOICE_MIME = /^audio\/(webm|ogg|mp4|mpeg|aac|wav)(;.*)?$/;
/** What a voice note looks like in a list that can only show one line of text. */
const VOICE_PREVIEW = '🎤 رسالة صوتية';

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
  lesson: { select: { id: true, title: true } },
} as const;

/** Both sides of a conversation, as the list draws them. */
const THREAD_INCLUDE = {
  teacher: { include: { user: { select: { fullName: true, avatarUrl: true } } } },
  student: { include: { user: { select: { fullName: true, avatarUrl: true } } } },
} as const;

type ThreadWithSides = Prisma.ChatThreadGetPayload<{ include: typeof THREAD_INCLUDE }>;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(Number.isFinite(n) ? n : min)));
}

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
    // `!!user.tenantId` is defence in depth rather than a fix for a live bug:
    // the column is non-nullable and a teacher's token always carries a
    // tenant. But `undefined === undefined` is true, so the comparison on its
    // own would grant a tenant-less token access to a tenant-less thread the
    // day either of those assumptions stops holding.
    if (user.role === Role.TEACHER) return !!user.tenantId && thread.tenantId === user.tenantId;
    const sid = await this.studentId(user.sub);
    return !!sid && thread.studentId === sid;
  }

  // ── Threads ───────────────────────────────────────────────────────────────

  /** Is this academy reachable by message at all? */
  private async messagingOpen(tenantId: string): Promise<boolean> {
    const teacher = await this.prisma.teacherProfile.findUnique({
      where: { id: tenantId },
      select: { acceptsStudentMessages: true },
    });
    return teacher?.acceptsStudentMessages ?? false;
  }

  /**
   * One page of the viewer's conversations, newest activity first.
   *
   * Bounded twice over: at most `limit` conversations, and a fixed number of
   * queries however many there are — the conversations, their two sides, their
   * last messages, and every unread count in one grouped query. It used to load
   * every conversation the viewer ever had and then count unread messages one
   * conversation at a time.
   *
   * Still an array, because stale tabs from before this change read it as one.
   * The next page is asked for with `before=<id of the last conversation>`.
   */
  async listThreads(
    user: JwtPayload,
    page: { limit?: number; before?: string } = {},
  ): Promise<ChatThreadDto[]> {
    // A teacher who has closed messaging is not shown a list of conversations
    // nobody can add to.
    if (user.role === Role.TEACHER && user.tenantId && !(await this.messagingOpen(user.tenantId))) {
      return [];
    }
    const limit = clamp(page.limit ?? THREAD_PAGE, 1, THREAD_PAGE_MAX);
    const side: Prisma.ChatThreadWhereInput =
      user.role === Role.TEACHER
        ? { tenantId: user.tenantId ?? '__none__' }
        : {
            studentId: (await this.studentId(user.sub)) ?? '__none__',
            teacher: { acceptsStudentMessages: true },
          };

    // A conversation someone cleared has nothing in it for them until the next
    // message lands, and an empty conversation is not a row worth drawing —
    // which is also why a conversation with no message at all never shows.
    const cleared =
      user.role === Role.STUDENT
        ? this.prisma.chatThread.fields.clearedForStudentAt
        : this.prisma.chatThread.fields.clearedForTeacherAt;
    const clearedField = user.role === Role.STUDENT ? 'clearedForStudentAt' : 'clearedForTeacherAt';
    const and: Prisma.ChatThreadWhereInput[] = [
      side,
      { lastMessageAt: { not: null } },
      { OR: [{ [clearedField]: null }, { lastMessageAt: { gt: cleared } }] },
    ];
    if (page.before) {
      const cursor = await this.prisma.chatThread.findFirst({
        where: { AND: [side, { id: page.before }] },
        select: { id: true, lastMessageAt: true },
      });
      if (!cursor?.lastMessageAt) return [];
      and.push({
        OR: [
          { lastMessageAt: { lt: cursor.lastMessageAt } },
          { lastMessageAt: cursor.lastMessageAt, id: { lt: cursor.id } },
        ],
      });
    }

    const threads = await this.prisma.chatThread.findMany({
      where: { AND: and },
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      take: limit,
      include: THREAD_INCLUDE,
    });
    return this.toThreadDtos(threads, user);
  }

  /**
   * One conversation's header, for a link that lands on a conversation that
   * is not on the first page of the list (an old notification, a deep link).
   */
  async getThread(user: JwtPayload, threadId: string): Promise<ChatThreadDto> {
    if (!(await this.canAccessThread(user, threadId)))
      throw new ForbiddenException('Not your thread');
    const thread = await this.prisma.chatThread.findFirst({
      where: { id: threadId },
      include: THREAD_INCLUDE,
    });
    if (!thread) throw new NotFoundException('No conversation here');
    const [dto] = await this.toThreadDtos([thread], user);
    return dto;
  }

  /** Where this viewer's copy of the conversation starts, if they cleared it. */
  private clearedAt(
    thread: { clearedForTeacherAt: Date | null; clearedForStudentAt: Date | null },
    user: JwtPayload,
  ): Date | null {
    return user.role === Role.STUDENT ? thread.clearedForStudentAt : thread.clearedForTeacherAt;
  }

  /**
   * DTOs for a page of conversations in two more queries, whatever its size:
   * the last messages by id, and the unread counts grouped by conversation.
   */
  private async toThreadDtos(
    threads: ThreadWithSides[],
    user: JwtPayload,
  ): Promise<ChatThreadDto[]> {
    if (!threads.length) return [];
    const ids = threads.map((th) => th.id);
    const lastIds = threads.map((th) => th.lastMessageId).filter((x): x is string => !!x);
    const [lastMessages, unread] = await Promise.all([
      lastIds.length
        ? this.prisma.chatMessage.findMany({
            where: { id: { in: lastIds } },
            select: { id: true, body: true, audioKey: true, createdAt: true },
          })
        : Promise.resolve([]),
      this.unreadCounts(ids, user),
    ]);
    const lastById = new Map(lastMessages.map((m) => [m.id, m]));

    const isTeacher = user.role === Role.TEACHER;
    return threads.map((thread) => {
      const counterpart = isTeacher ? thread.student.user : thread.teacher.user;
      const last = thread.lastMessageId ? lastById.get(thread.lastMessageId) : undefined;
      return {
        id: thread.id,
        type: thread.type as ChatThreadDto['type'],
        tenantId: thread.tenantId,
        studentId: thread.studentId,
        counterpartName: counterpart.fullName,
        counterpartAvatarUrl: counterpart.avatarUrl ?? null,
        lessonId: thread.lessonId,
        lessonTitle: null,
        videoTimestampSec: thread.videoTimestampSec,
        // A voice note has no text, and an empty preview made a conversation full
        // of them look like one nobody had written in yet.
        lastMessage: last ? last.body || (last.audioKey ? VOICE_PREVIEW : null) : null,
        lastMessageAt: (last?.createdAt ?? thread.lastMessageAt)?.toISOString() ?? null,
        unread: unread.get(thread.id) ?? 0,
        updatedAt: thread.updatedAt.toISOString(),
      };
    });
  }

  /**
   * Unread messages per conversation, for many conversations, in one query.
   *
   * "Unread" is what it has always been here: a message from the other side
   * with no readAt, after this viewer's cleared line. The cleared line lives on
   * each conversation and differs per side, which is why this is SQL rather
   * than a Prisma groupBy — the filter compares against a column of the row.
   */
  private async unreadCounts(threadIds: string[], user: JwtPayload): Promise<Map<string, number>> {
    const clearedColumn = Prisma.raw(
      user.role === Role.STUDENT ? '"clearedForStudentAt"' : '"clearedForTeacherAt"',
    );
    const rows = await this.prisma.$queryRaw<{ threadId: string; unread: number }[]>`
      SELECT m."threadId", count(*)::int AS "unread"
      FROM "ChatMessage" m
      JOIN "ChatThread" t ON t.id = m."threadId"
      WHERE m."threadId" IN (${Prisma.join(threadIds)})
        AND m."readAt" IS NULL
        AND m."deletedAt" IS NULL
        AND m."senderId" <> ${user.sub}
        AND (t.${clearedColumn} IS NULL OR m."createdAt" > t.${clearedColumn})
      GROUP BY m."threadId"`;
    return new Map(rows.map((r) => [r.threadId, Number(r.unread)]));
  }

  /**
   * Empty this conversation, for you.
   *
   * Not a delete: the other person's copy is untouched, and the messages stay
   * as the record of what was agreed about money and access. It draws a line —
   * from here you see only what is said next, so the conversation comes back
   * when someone writes, carrying nothing that was cleared.
   */
  async clearThread(user: JwtPayload, threadId: string) {
    if (!(await this.canAccessThread(user, threadId)))
      throw new ForbiddenException('Not your thread');
    const side =
      user.role === Role.STUDENT
        ? { clearedForStudentAt: new Date() }
        : { clearedForTeacherAt: new Date() };
    await this.prisma.chatThread.update({ where: { id: threadId }, data: side });
    return { id: threadId, cleared: true };
  }

  /**
   * One page of a conversation, always returned oldest-first for drawing.
   *
   *  - no cursor: the NEWEST `limit` messages — what opening a conversation shows.
   *    This used to be the oldest 200, so anything past the 200th message of a
   *    long conversation never appeared at all.
   *  - `before`: the `limit` messages just older than that one (scrolling back).
   *  - `after`: the messages newer than that one (catching up; a poll).
   *
   * Keyset on (createdAt, id), never an offset: a message arriving while
   * someone scrolls back does not shift the pages under them, so they see no
   * message twice and skip none. `id` breaks ties between messages stored in
   * the same millisecond.
   */
  async getMessages(
    user: JwtPayload,
    threadId: string,
    page: MessagePageQuery = {},
  ): Promise<ChatMessageDto[]> {
    if (!(await this.canAccessThread(user, threadId)))
      throw new ForbiddenException('Not your thread');
    if (page.before && page.after) {
      throw new BadRequestException({
        message: 'Ask for older or newer messages, not both',
        code: 'CURSOR_CONFLICT',
      });
    }
    const limit = clamp(page.limit ?? MESSAGE_PAGE, 1, MESSAGE_PAGE_MAX);
    const thread = await this.prisma.chatThread.findUniqueOrThrow({
      where: { id: threadId },
      select: { clearedForTeacherAt: true, clearedForStudentAt: true },
    });
    const from = this.clearedAt(thread, user);
    const where: Prisma.ChatMessageWhereInput = {
      threadId,
      ...(from ? { createdAt: { gt: from } } : {}),
    };

    const cursorId = page.before ?? page.after;
    if (cursorId) {
      // The cursor must be a message of THIS conversation; anything else would
      // let a page boundary be steered by a message from somewhere else.
      const cursor = await this.prisma.chatMessage.findFirst({
        where: { id: cursorId, threadId },
        select: { id: true, createdAt: true },
      });
      if (!cursor) {
        throw new BadRequestException({ message: 'Unknown cursor', code: 'CURSOR_UNKNOWN' });
      }
      const older = !!page.before;
      where.AND = [
        {
          OR: [
            { createdAt: older ? { lt: cursor.createdAt } : { gt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: older ? { lt: cursor.id } : { gt: cursor.id } },
          ],
        },
      ];
    }

    // Newer-than reads forward; everything else reads backward from the end
    // and is flipped, so the page is always the one nearest the cursor.
    const forward = !!page.after;
    const rows = await this.prisma.chatMessage.findMany({
      where,
      orderBy: forward
        ? [{ createdAt: 'asc' }, { id: 'asc' }]
        : [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      include: MESSAGE_INCLUDE,
    });
    if (!forward) rows.reverse();
    // Scrolling back through history is not reading what just arrived.
    if (!page.before) await this.markThreadRead(user, threadId);
    return rows.map((m) => this.toMessageDto(m, user.sub));
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
      // Only the sender's own copy carries it: it is how their open tab matches
      // the stored message to the bubble it drew while the send was in flight.
      clientMessageId: m.senderId === viewerUserId ? (m.clientMessageId ?? null) : null,
      replyTo: m.replyTo
        ? {
            id: m.replyTo.id,
            senderName: m.replyTo.sender?.fullName ?? '',
            body: m.replyTo.body,
            isVoice: !!m.replyTo.audioKey,
          }
        : null,
      audio: m.audioKey ? { durationSec: m.audioDurationSec ?? 0, bytes: m.audioBytes ?? 0 } : null,
      lesson: m.lesson
        ? {
            id: m.lesson.id,
            title: m.lesson.title,
            atSec: m.videoTimestampSec ?? null,
          }
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
   * Who a message may go to, decided before anything is written.
   *
   * Either an existing conversation the caller is already in, or the identity
   * of the conversation they are allowed to start — a student with a teacher
   * they are actively enrolled with, a teacher with a student who shares an
   * enrolment. Nothing here creates a row: the conversation is only made, in
   * `sendMessage`, in the same transaction as the first message.
   */
  private async authorizeTarget(
    user: JwtPayload,
    payload: { threadId?: string; tenantId?: string; studentId?: string },
  ): Promise<{ threadId: string } | { identity: ThreadIdentity }> {
    if (payload.threadId) {
      if (!(await this.canAccessThread(user, payload.threadId))) {
        throw new ForbiddenException('Not your thread');
      }
      return { threadId: payload.threadId };
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
      if (!enrolled)
        throw new ForbiddenException('You can only message teachers you are enrolled with');
      const teacher = await this.openTeacher(
        payload.tenantId,
        'This teacher is not accepting messages',
      );
      // One conversation per teacher, whatever prompted it. Asking from inside
      // a lesson used to open a second thread with the same person, which read
      // as two chats with one teacher; the lesson rides on the message instead.
      return { identity: this.identity(payload.tenantId, sid, teacher.userId) };
    }

    // A teacher writing first. This used to be refused outright, which meant a
    // teacher looking at a student in their console had no way to reach them
    // except WhatsApp — the student had to open the conversation before the
    // teacher could say anything in it.
    const tenantId = user.tenantId;
    if (!tenantId) throw new BadRequestException('No academy on this account');
    const teacher = await this.openTeacher(tenantId, 'Messaging is switched off for this academy');
    if (!payload.studentId) throw new BadRequestException('studentId required to start a chat');
    // The same gate as the student's, read from the other side: they must share
    // an enrolment. Any status, including a revoked one — telling a student why
    // their access ended is exactly the message this exists for.
    const shares = await this.prisma.enrollment.findFirst({
      where: { studentId: payload.studentId, tenantId },
    });
    if (!shares) throw new ForbiddenException('You can only message your own students');
    return { identity: this.identity(tenantId, payload.studentId, teacher.userId) };
  }

  /** The teacher behind a tenant, provided their messaging is switched on. */
  private async openTeacher(tenantId: string, closedMessage: string) {
    const teacher = await this.prisma.teacherProfile.findUnique({
      where: { id: tenantId },
      select: { userId: true, acceptsStudentMessages: true },
    });
    if (!teacher?.acceptsStudentMessages) {
      throw new ForbiddenException({ message: closedMessage, code: 'MESSAGING_CLOSED' });
    }
    return teacher;
  }

  /**
   * Every conversation so far is with a teacher in their own workspace, whose
   * academy id IS their tenant id (the identity-preserving academy migration).
   * Messaging V2 is where a conversation first lives in some other academy.
   */
  private identity(tenantId: string, studentId: string, staffUserId: string): ThreadIdentity {
    return { academyId: tenantId, tenantId, studentId, staffUserId };
  }

  /**
   * The conversation with someone, if there is one — without making one.
   *
   * What the message button in the console and a student's "message the
   * teacher" land on: the same authorization as sending, and then either the
   * existing conversation or `threadId: null`, which the page draws as an empty
   * conversation ready to type in. The row only appears when the first message
   * is actually sent.
   */
  async resolveTarget(
    user: JwtPayload,
    payload: { studentId?: string; tenantId?: string },
  ): Promise<{
    threadId: string | null;
    counterpartName: string;
    counterpartAvatarUrl: string | null;
  }> {
    const target = await this.authorizeTarget(user, payload);
    if ('threadId' in target) throw new BadRequestException('Resolve a person, not a thread');
    const { identity } = target;
    const [existing, counterpart] = await Promise.all([
      this.prisma.chatThread.findUnique({
        where: { dedupeKey: threadKey(identity) },
        select: { id: true, deletedAt: true },
      }),
      user.role === Role.STUDENT
        ? this.prisma.user.findUnique({
            where: { id: identity.staffUserId },
            select: { fullName: true, avatarUrl: true },
          })
        : this.prisma.studentProfile
            .findUnique({
              where: { id: identity.studentId },
              select: { user: { select: { fullName: true, avatarUrl: true } } },
            })
            .then((s) => s?.user ?? null),
    ]);
    if (!counterpart) throw new NotFoundException('No one to message here');
    return {
      threadId: existing && !existing.deletedAt ? existing.id : null,
      counterpartName: counterpart.fullName,
      counterpartAvatarUrl: counterpart.avatarUrl ?? null,
    };
  }

  /**
   * DEPRECATED — kept only for browser tabs loaded before `resolve` existed.
   *
   * Those tabs call this and navigate to `?t=<threadId>`, so it still has to
   * return a real conversation, which means it still creates one when there is
   * none. It goes through the same atomic path as a send, so it can no longer
   * create a duplicate. The current client never calls it; remove it once the
   * old bundle is out of circulation.
   */
  async openThread(user: JwtPayload, payload: { studentId?: string; tenantId?: string }) {
    const target = await this.authorizeTarget(user, payload);
    if ('threadId' in target) return { threadId: target.threadId };
    const thread = await this.prisma.$transaction((tx) =>
      resolveCanonicalThread(tx, target.identity),
    );
    if (thread.deletedAt) throw new NotFoundException('This conversation is no longer available');
    return { threadId: thread.id };
  }

  /** A reply is only valid inside its own thread; anything else is dropped. */
  private async replyTarget(
    threadId: string,
    replyToId?: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<string | null> {
    if (!replyToId) return null;
    const target = await db.chatMessage.findFirst({
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
    if (!(await this.canAccessThread(user, threadId)))
      throw new ForbiddenException('Not your thread');
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
    await this.touchLastMessage(this.prisma, threadId, saved);

    await this.fanOut(saved, thread, user.sub, VOICE_PREVIEW);
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

  /**
   * Send a message — to an existing conversation, or to a person, in which case
   * the conversation is created in the same transaction as this first message.
   *
   * Two guarantees, both held by the database rather than by timing:
   *
   *  - Two first messages sent at the same moment (teacher and student, or two
   *    tabs) land in ONE conversation: `resolveCanonicalThread` is an
   *    INSERT … ON CONFLICT on the conversation's unique key.
   *  - The same send retried — a timeout, a dropped connection, a double tap —
   *    is stored ONCE: `clientMessageId` is unique per sender, and a retry gets
   *    the message that is already there back, without a second notification.
   */
  async sendMessage(user: JwtPayload, payload: SendMessagePayload) {
    const body = payload.body?.trim() ?? '';
    if (!body) throw new BadRequestException('Empty message');
    // Authoritative length cap for BOTH transports (REST DTO + the socket gateway,
    // which the global HTTP ValidationPipe doesn't cover). Prevents multi-MB
    // messages being persisted verbatim (storage amplification / oversized pushes).
    if (body.length > CHAT_MESSAGE_MAX_LEN) {
      throw new BadRequestException({ message: 'Message too long', code: 'MESSAGE_TOO_LONG' });
    }
    const clientMessageId = payload.clientMessageId ?? null;
    if (clientMessageId !== null && !CLIENT_MESSAGE_ID.test(clientMessageId)) {
      throw new BadRequestException({ message: 'Bad clientMessageId', code: 'CLIENT_ID_INVALID' });
    }
    // Authorize first, every time — a replayed id must not be a way to read a
    // message out of a conversation the caller has since been removed from.
    const target = await this.authorizeTarget(user, payload);

    if (clientMessageId) {
      const replay = await this.replay(user.sub, clientMessageId);
      if (replay) return replay;
    }

    let stored: { message: any; thread: { id: string; tenantId: string; studentId: string } };
    try {
      stored = await this.prisma.$transaction(async (tx) => {
        let thread: { id: string; tenantId: string; studentId: string };
        if ('threadId' in target) {
          thread = await tx.chatThread.findUniqueOrThrow({
            where: { id: target.threadId },
            select: { id: true, tenantId: true, studentId: true },
          });
        } else {
          const resolved = await resolveCanonicalThread(tx, target.identity);
          // The canonical row exists but was removed (its student or teacher was
          // taken off the platform). Not a conversation anyone can add to.
          if (resolved.deletedAt) {
            throw new NotFoundException('This conversation is no longer available');
          }
          thread = resolved;
        }
        // A reply only means anything inside its own conversation; quoting across
        // threads would leak one student's message into another's.
        const replyToId = await this.replyTarget(thread.id, payload.replyToId, tx);
        // Only a lesson that exists, so a bad id becomes a plain message rather
        // than a chip pointing at nothing.
        const lesson = payload.lessonId
          ? await tx.lesson.findUnique({ where: { id: payload.lessonId }, select: { id: true } })
          : null;

        const message = await tx.chatMessage.create({
          data: {
            threadId: thread.id,
            senderId: user.sub,
            body,
            replyToId,
            lessonId: lesson?.id,
            videoTimestampSec: lesson ? payload.videoTimestampSec : null,
            clientMessageId,
          },
          include: MESSAGE_INCLUDE,
        });
        await this.touchLastMessage(tx, thread.id, message);
        return { message, thread };
      });
    } catch (e) {
      // The same send racing itself: the other attempt committed first and the
      // unique (senderId, clientMessageId) refused this one. Its message is the
      // answer. Anything else is a real failure.
      if (
        clientMessageId &&
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const replay = await this.replay(user.sub, clientMessageId);
        if (replay) return replay;
      }
      throw e;
    }

    const { message, thread } = stored;
    await this.fanOut(message, thread, user.sub, body.length > 80 ? body.slice(0, 80) + '…' : body);
    return { message: this.toMessageDto(message, user.sub), threadId: thread.id };
  }

  /** A send already stored under this client id, returned as a send would be. */
  private async replay(senderId: string, clientMessageId: string) {
    const existing = await this.prisma.chatMessage.findUnique({
      where: { senderId_clientMessageId: { senderId, clientMessageId } },
      include: MESSAGE_INCLUDE,
    });
    if (!existing) return null;
    return { message: this.toMessageDto(existing, senderId), threadId: existing.threadId };
  }

  /**
   * Point the conversation at its newest message, which is what the list sorts
   * and pages on. Conditional, so two sends finishing out of order cannot leave
   * the older one as "last".
   */
  private async touchLastMessage(
    db: Prisma.TransactionClient,
    threadId: string,
    message: { id: string; createdAt: Date },
  ) {
    await db.chatThread.updateMany({
      where: {
        id: threadId,
        OR: [
          { lastMessageAt: null },
          { lastMessageAt: { lt: message.createdAt } },
          { lastMessageAt: message.createdAt, lastMessageId: { lt: message.id } },
        ],
      },
      data: { lastMessageAt: message.createdAt, lastMessageId: message.id },
    });
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
    const recipientUserId = await this.recipientUserId(thread, senderUserId);
    this.realtime.emitToUser(
      senderUserId,
      RealtimeEvents.MESSAGE,
      this.toMessageDto(message, senderUserId),
    );
    if (!recipientUserId) return;
    this.realtime.emitToUser(
      recipientUserId,
      RealtimeEvents.MESSAGE,
      this.toMessageDto(message, recipientUserId),
    );
    this.realtime.emitToUser(recipientUserId, RealtimeEvents.THREAD_UPDATED, {
      threadId: thread.id,
    });
    await this.notifications.create({
      userId: recipientUserId,
      type: 'CHAT_MESSAGE',
      title: `رسالة جديدة من ${message.sender.fullName}`,
      body: preview,
      meta: { threadId: thread.id },
    });
  }

  private async recipientUserId(
    thread: { tenantId: string; studentId: string },
    senderUserId: string,
  ) {
    const [teacher, student] = await Promise.all([
      this.prisma.teacherProfile.findUnique({
        where: { id: thread.tenantId },
        select: { userId: true },
      }),
      this.prisma.studentProfile.findUnique({
        where: { id: thread.studentId },
        select: { userId: true },
      }),
    ]);
    const participants = [teacher?.userId, student?.userId].filter(Boolean) as string[];
    return participants.find((id) => id !== senderUserId) ?? null;
  }
}
