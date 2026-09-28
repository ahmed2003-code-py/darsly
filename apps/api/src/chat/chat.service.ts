import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ChatMessageDto,
  ChatSeenEvent,
  ChatSenderKind,
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
import { avatarUrl } from '../common/signed-link';
import { resolveCanonicalThread, ThreadIdentity, threadKey } from './chat-thread.identity';
import {
  aggregateReactions,
  MESSAGE_INCLUDE,
  previewOf,
  ReactionRow,
  toMessageDto,
} from './chat-presenter';

/** Max stored chat message length — shared by the REST DTO and the socket path. */
export const CHAT_MESSAGE_MAX_LEN = 4000;

/** Messages per page when a conversation is opened or scrolled back. */
export const MESSAGE_PAGE = 40;
export const MESSAGE_PAGE_MAX = 100;
/** Conversations per page of the list. */
export const THREAD_PAGE = 50;
export const THREAD_PAGE_MAX = 100;
/** Files one message may carry. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

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
  /** a window centred on this message (jumping to a quoted original) */
  around?: string;
  limit?: number;
}

/** A voice note is a thought, not a lecture. */
export const VOICE_MAX_SECONDS = 300;
export const VOICE_MAX_BYTES = 10 * 1024 * 1024;
/** What a browser's MediaRecorder actually produces, across the ones we serve. */
const VOICE_MIME = /^audio\/(webm|ogg|mp4|mpeg|aac|wav)(;.*)?$/;

/** Both sides of a conversation, as the list draws them. */
const THREAD_INCLUDE = {
  teacher: {
    select: {
      userId: true,
      user: { select: { id: true, fullName: true, avatarUrl: true, updatedAt: true } },
    },
  },
  student: {
    select: {
      userId: true,
      user: { select: { id: true, fullName: true, avatarUrl: true, updatedAt: true } },
    },
  },
} as const;

type ThreadWithSides = Prisma.ChatThreadGetPayload<{ include: typeof THREAD_INCLUDE }>;

/**
 * Who is in a conversation. Everything that fans out (messages, reactions,
 * read positions) and everything that asks "who is the other side" goes
 * through this one shape — so when Phase 1/2 add assistants and guardians it
 * grows here, not in every caller.
 */
export interface ThreadParties {
  id: string;
  tenantId: string;
  studentId: string;
  dedupeKey: string;
  studentUserId: string;
  staffUserId: string;
  clearedForTeacherAt: Date | null;
  clearedForStudentAt: Date | null;
}

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

  /** The conversation's participants, or null when it does not exist. */
  async parties(threadId: string, db: Prisma.TransactionClient = this.prisma) {
    const t = await db.chatThread.findUnique({
      where: { id: threadId },
      select: {
        id: true,
        tenantId: true,
        studentId: true,
        dedupeKey: true,
        staffUserId: true,
        clearedForTeacherAt: true,
        clearedForStudentAt: true,
        student: { select: { userId: true } },
        teacher: { select: { userId: true } },
      },
    });
    if (!t) return null;
    return {
      id: t.id,
      tenantId: t.tenantId,
      studentId: t.studentId,
      dedupeKey: t.dedupeKey,
      studentUserId: t.student.userId,
      staffUserId: t.staffUserId ?? t.teacher.userId,
      clearedForTeacherAt: t.clearedForTeacherAt,
      clearedForStudentAt: t.clearedForStudentAt,
    } satisfies ThreadParties;
  }

  /** Everyone who receives this conversation's live events. */
  participantIds(p: ThreadParties): string[] {
    return [...new Set([p.studentUserId, p.staffUserId].filter(Boolean))];
  }

  /**
   * The sender's role in THIS conversation, frozen onto the message. Derived
   * from the conversation's parties, never from the request.
   */
  private senderKindFor(user: JwtPayload, p: ThreadParties): ChatSenderKind {
    if (user.sub === p.studentUserId) return 'STUDENT';
    if (user.sub === p.staffUserId) return 'OWNER';
    if (user.role === Role.SUPER_ADMIN) return 'ADMIN';
    if (user.role === Role.TEACHER) return 'TEACHER';
    return 'STUDENT';
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
   * queries however many there are — the conversations with their sides, their
   * last messages, every unread count in one grouped query, and the read
   * positions of the page in one more.
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
   * DTOs for a page of conversations in three more queries, whatever its size:
   * the last messages by id, the unread counts, and the read positions.
   */
  private async toThreadDtos(
    threads: ThreadWithSides[],
    user: JwtPayload,
  ): Promise<ChatThreadDto[]> {
    if (!threads.length) return [];
    const ids = threads.map((th) => th.id);
    const lastIds = threads.map((th) => th.lastMessageId).filter((x): x is string => !!x);
    const [lastMessages, unread, cursors] = await Promise.all([
      lastIds.length
        ? this.prisma.chatMessage.findMany({
            where: { id: { in: lastIds } },
            select: {
              id: true,
              body: true,
              audioKey: true,
              createdAt: true,
              senderId: true,
              attachments: { select: { kind: true, fileName: true } },
            },
          })
        : Promise.resolve([]),
      this.unreadCounts(ids, user),
      this.prisma.chatReadState.findMany({
        where: { threadId: { in: ids } },
        select: { threadId: true, userId: true, lastReadAt: true },
      }),
    ]);
    const lastById = new Map(lastMessages.map((m) => [m.id, m]));
    const cursorOf = (threadId: string, userId: string) =>
      cursors.find((c) => c.threadId === threadId && c.userId === userId)?.lastReadAt ?? null;

    const isTeacher = user.role === Role.TEACHER;
    return threads.map((thread) => {
      const counterpart = isTeacher ? thread.student.user : thread.teacher.user;
      const staffUserId = thread.staffUserId ?? thread.teacher.userId;
      const counterpartUserId = isTeacher ? thread.student.userId : staffUserId;
      const last = thread.lastMessageId ? lastById.get(thread.lastMessageId) : undefined;
      return {
        id: thread.id,
        type: thread.type as ChatThreadDto['type'],
        tenantId: thread.tenantId,
        studentId: thread.studentId,
        counterpartName: counterpart.fullName,
        counterpartAvatarUrl: avatarUrl(counterpart),
        counterpartKind: isTeacher ? 'STUDENT' : 'OWNER',
        lessonId: thread.lessonId,
        lessonTitle: null,
        videoTimestampSec: thread.videoTimestampSec,
        // A voice note or a photo has no text, and an empty preview made a
        // conversation full of them look like one nobody had written in yet.
        lastMessage: last ? previewOf(last) || null : null,
        lastMessageAt: (last?.createdAt ?? thread.lastMessageAt)?.toISOString() ?? null,
        lastMessageMine: last ? last.senderId === user.sub : false,
        unread: unread.get(thread.id) ?? 0,
        myLastReadAt: cursorOf(thread.id, user.sub)?.toISOString() ?? null,
        counterpartLastReadAt: cursorOf(thread.id, counterpartUserId)?.toISOString() ?? null,
        updatedAt: thread.updatedAt.toISOString(),
      };
    });
  }

  /**
   * Unread messages per conversation, for many conversations, in one query:
   * messages from anyone else, after this viewer's read position and after
   * their cleared line. The position and the line differ per viewer and per
   * conversation, which is why this is SQL rather than a Prisma groupBy.
   */
  private async unreadCounts(threadIds: string[], user: JwtPayload): Promise<Map<string, number>> {
    const clearedColumn = Prisma.raw(
      user.role === Role.STUDENT ? '"clearedForStudentAt"' : '"clearedForTeacherAt"',
    );
    const rows = await this.prisma.$queryRaw<{ threadId: string; unread: number }[]>`
      SELECT m."threadId", count(*)::int AS "unread"
      FROM "ChatMessage" m
      JOIN "ChatThread" t ON t.id = m."threadId"
      LEFT JOIN "ChatReadState" r ON r."threadId" = m."threadId" AND r."userId" = ${user.sub}
      WHERE m."threadId" IN (${Prisma.join(threadIds)})
        AND m."deletedAt" IS NULL
        AND m."senderId" <> ${user.sub}
        AND (r."lastReadAt" IS NULL OR m."createdAt" > r."lastReadAt")
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

  // ── Messages ──────────────────────────────────────────────────────────────

  /**
   * One page of a conversation, always returned oldest-first for drawing.
   *
   *  - no cursor: the NEWEST `limit` messages — what opening a conversation shows.
   *  - `before`: the `limit` messages just older than that one (scrolling back).
   *  - `after`: the messages newer than that one (catching up; a poll).
   *  - `around`: a window with that message in the middle (jumping to a quote).
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
    if ([page.before, page.after, page.around].filter(Boolean).length > 1) {
      throw new BadRequestException({
        message: 'Ask for one of older, newer or around a message',
        code: 'CURSOR_CONFLICT',
      });
    }
    const limit = clamp(page.limit ?? MESSAGE_PAGE, 1, MESSAGE_PAGE_MAX);
    const parties = (await this.parties(threadId))!;
    const from = this.clearedAt(parties, user);
    const base: Prisma.ChatMessageWhereInput = {
      threadId,
      ...(from ? { createdAt: { gt: from } } : {}),
    };

    const cursorId = page.before ?? page.after ?? page.around;
    let cursor: { id: string; createdAt: Date } | null = null;
    if (cursorId) {
      // The cursor must be a message of THIS conversation; anything else would
      // let a page boundary be steered by a message from somewhere else.
      cursor = await this.prisma.chatMessage.findFirst({
        where: { id: cursorId, threadId },
        select: { id: true, createdAt: true },
      });
      if (!cursor) {
        throw new BadRequestException({ message: 'Unknown cursor', code: 'CURSOR_UNKNOWN' });
      }
    }
    const olderThan = (c: { id: string; createdAt: Date }, inclusive = false) => ({
      OR: [
        { createdAt: { lt: c.createdAt } },
        { createdAt: c.createdAt, id: inclusive ? { lte: c.id } : { lt: c.id } },
      ],
    });
    const newerThan = (c: { id: string; createdAt: Date }) => ({
      OR: [{ createdAt: { gt: c.createdAt } }, { createdAt: c.createdAt, id: { gt: c.id } }],
    });
    const asc = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];
    const desc = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

    let rows: any[];
    if (page.around && cursor) {
      const half = Math.max(1, Math.floor(limit / 2));
      const [older, newer] = await Promise.all([
        this.prisma.chatMessage.findMany({
          where: { ...base, AND: [olderThan(cursor, true)] },
          orderBy: desc,
          take: half + 1,
          include: MESSAGE_INCLUDE,
        }),
        this.prisma.chatMessage.findMany({
          where: { ...base, AND: [newerThan(cursor)] },
          orderBy: asc,
          take: half,
          include: MESSAGE_INCLUDE,
        }),
      ]);
      rows = [...older.reverse(), ...newer];
    } else if (page.after && cursor) {
      rows = await this.prisma.chatMessage.findMany({
        where: { ...base, AND: [newerThan(cursor)] },
        orderBy: asc,
        take: limit,
        include: MESSAGE_INCLUDE,
      });
    } else {
      rows = await this.prisma.chatMessage.findMany({
        where: cursor ? { ...base, AND: [olderThan(cursor)] } : base,
        orderBy: desc,
        take: limit,
        include: MESSAGE_INCLUDE,
      });
      rows.reverse();
    }
    // Scrolling back or jumping into history is not reading what just arrived.
    if (!page.before && !page.around) await this.markRead(user.sub, parties);
    return this.present(rows, user.sub, parties);
  }

  /**
   * Stored messages → DTOs for one viewer, with two queries for the whole page
   * whatever its size: the reactions (with names, for the tooltip) and the
   * other participants' read positions (for ✓✓).
   */
  async present(
    rows: any[],
    viewerUserId: string,
    parties: ThreadParties,
  ): Promise<ChatMessageDto[]> {
    if (!rows.length) return [];
    const others = this.participantIds(parties).filter((id) => id !== viewerUserId);
    const [reactionRows, seen] = await Promise.all([
      this.prisma.chatReaction.findMany({
        where: { messageId: { in: rows.map((r) => r.id) } },
        orderBy: { createdAt: 'asc' },
        select: {
          messageId: true,
          emoji: true,
          userId: true,
          user: { select: { fullName: true } },
        },
      }),
      others.length
        ? this.prisma.chatReadState.aggregate({
            where: { threadId: parties.id, userId: { in: others } },
            _max: { lastReadAt: true },
          })
        : Promise.resolve({ _max: { lastReadAt: null } }),
    ]);
    const reactions = aggregateReactions(
      reactionRows.map((r): ReactionRow => ({
        messageId: r.messageId,
        emoji: r.emoji,
        userId: r.userId,
        name: r.user.fullName,
      })),
      viewerUserId,
    );
    return rows.map((m) =>
      toMessageDto(m, viewerUserId, { reactions, seenBy: seen._max.lastReadAt ?? null }),
    );
  }

  /** Mark the conversation read up to its newest message (the socket path). */
  async markThreadRead(user: JwtPayload, threadId: string) {
    if (!(await this.canAccessThread(user, threadId))) return;
    const parties = await this.parties(threadId);
    if (parties) await this.markRead(user.sub, parties);
  }

  /**
   * Move one person's read position forward — never back — and tell the
   * other participants, so their ✓ turns into ✓✓ without a reload.
   *
   * Cheap when nothing moved (one indexed read), which matters because the
   * open conversation polls. The legacy per-message `readAt` is still written
   * for one release so a tab loaded before read cursors keeps its ✓✓.
   */
  async markRead(userId: string, parties: ThreadParties, upTo?: Date) {
    const newest = await this.prisma.chatMessage.findFirst({
      where: { threadId: parties.id, senderId: { not: userId } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { createdAt: true },
    });
    if (!newest) return;
    const at = upTo && upTo < newest.createdAt ? upTo : newest.createdAt;
    const prev = await this.prisma.chatReadState.findUnique({
      where: { threadId_userId: { threadId: parties.id, userId } },
      select: { lastReadAt: true },
    });
    if (prev && prev.lastReadAt >= at) return;

    await this.prisma.$executeRaw`
      INSERT INTO "ChatReadState" ("threadId", "userId", "lastReadAt", "updatedAt")
      VALUES (${parties.id}, ${userId}, ${at}, now())
      ON CONFLICT ("threadId", "userId")
      DO UPDATE SET "lastReadAt" = GREATEST("ChatReadState"."lastReadAt", EXCLUDED."lastReadAt"),
                    "updatedAt" = now()`;
    await this.prisma.chatMessage.updateMany({
      where: {
        threadId: parties.id,
        readAt: null,
        senderId: { not: userId },
        createdAt: { lte: at },
      },
      data: { readAt: new Date() },
    });
    const event: ChatSeenEvent = {
      threadId: parties.id,
      userId,
      lastReadAt: at.toISOString(),
    };
    for (const id of this.participantIds(parties)) {
      this.realtime.emitToUser(id, RealtimeEvents.SEEN, event);
    }
  }

  /** Explicit "I have read up to here" from an open conversation. */
  async markReadUpTo(user: JwtPayload, threadId: string, messageId?: string) {
    if (!(await this.canAccessThread(user, threadId)))
      throw new ForbiddenException('Not your thread');
    const parties = (await this.parties(threadId))!;
    let upTo: Date | undefined;
    if (messageId) {
      const m = await this.prisma.chatMessage.findFirst({
        where: { id: messageId, threadId },
        select: { createdAt: true },
      });
      if (!m) throw new BadRequestException({ message: 'Unknown message', code: 'CURSOR_UNKNOWN' });
      upTo = m.createdAt;
    }
    await this.markRead(user.sub, parties, upTo);
    return { ok: true };
  }

  // ── Starting conversations ────────────────────────────────────────────────

  /**
   * Who a message may go to, decided before anything is written.
   *
   * Either an existing conversation the caller is already in, or the identity
   * of the conversation they are allowed to start — a student with a teacher
   * they are actively enrolled with, a teacher with a student who shares an
   * enrolment. Nothing here creates a row: the conversation is only made, in
   * `sendMessage`, in the same transaction as the first message.
   */
  async authorizeTarget(
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
    counterpartKind: ChatSenderKind;
  }> {
    const target = await this.authorizeTarget(user, payload);
    if ('threadId' in target) throw new BadRequestException('Resolve a person, not a thread');
    const { identity } = target;
    const select = { id: true, fullName: true, avatarUrl: true, updatedAt: true } as const;
    const [existing, counterpart] = await Promise.all([
      this.prisma.chatThread.findUnique({
        where: { dedupeKey: threadKey(identity) },
        select: { id: true, deletedAt: true },
      }),
      user.role === Role.STUDENT
        ? this.prisma.user.findUnique({ where: { id: identity.staffUserId }, select })
        : this.prisma.studentProfile
            .findUnique({ where: { id: identity.studentId }, select: { user: { select } } })
            .then((s) => s?.user ?? null),
    ]);
    if (!counterpart) throw new NotFoundException('No one to message here');
    return {
      threadId: existing && !existing.deletedAt ? existing.id : null,
      counterpartName: counterpart.fullName,
      counterpartAvatarUrl: avatarUrl(counterpart),
      counterpartKind: user.role === Role.STUDENT ? 'OWNER' : 'STUDENT',
    };
  }

  /**
   * DEPRECATED — kept only for browser tabs loaded before `resolve` existed.
   * Goes through the same atomic path as a send, so it cannot duplicate.
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

  /**
   * A reply is only valid inside its own thread; anything else is dropped.
   * A removed original is still a valid thing to have answered — it is shown
   * as "unavailable" — but a new reply to it is not accepted.
   */
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

  // ── Voice notes ───────────────────────────────────────────────────────────

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

    const parties = (await this.parties(threadId))!;
    const replyTo = await this.replyTarget(threadId, replyToId);
    const message = await this.prisma.chatMessage.create({
      data: {
        threadId,
        senderId: user.sub,
        senderKind: this.senderKindFor(user, parties),
        body: '',
        replyToId: replyTo,
        audioDurationSec: seconds,
        audioBytes: file.buffer.length,
        audioMimeType: file.mimetype,
        audioKey: '',
      },
    });
    const audioKey = `chat-voice/${threadId}/${message.id}`;
    await this.storage.put(audioKey, file.buffer, { contentType: file.mimetype });
    const saved = await this.prisma.chatMessage.update({
      where: { id: message.id },
      data: { audioKey },
      include: MESSAGE_INCLUDE,
    });
    await this.touchLastMessage(this.prisma, threadId, saved);
    await this.markRead(user.sub, parties, saved.createdAt);
    await this.fanOut(saved, parties, user.sub);
    const [dto] = await this.present([saved], user.sub, parties);
    return { message: dto, threadId };
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

  // ── Sending ───────────────────────────────────────────────────────────────

  /**
   * Send a message — to an existing conversation, or to a person, in which case
   * the conversation is created in the same transaction as this first message.
   *
   * Three guarantees, all held by the database rather than by timing:
   *
   *  - Two first messages sent at the same moment (teacher and student, or two
   *    tabs) land in ONE conversation: `resolveCanonicalThread` is an
   *    INSERT … ON CONFLICT on the conversation's unique key.
   *  - The same send retried — a timeout, a dropped connection, a double tap —
   *    is stored ONCE: `clientMessageId` is unique per sender, and a retry gets
   *    the message that is already there back, without a second notification.
   *  - Attachments bind only if every one of them is the sender's own PENDING
   *    upload for THIS conversation (by thread, or — before the first message —
   *    by the conversation's identity key). One that does not match fails the
   *    whole send, so nothing half-sent exists and no empty conversation is left.
   */
  async sendMessage(user: JwtPayload, payload: SendMessagePayload) {
    const body = payload.body?.trim() ?? '';
    const attachmentIds = [...new Set(payload.attachmentIds ?? [])];
    if (attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new BadRequestException({
        message: `At most ${MAX_ATTACHMENTS_PER_MESSAGE} files per message`,
        code: 'TOO_MANY_ATTACHMENTS',
      });
    }
    if (!body && !attachmentIds.length) throw new BadRequestException('Empty message');
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
      const replay = await this.replay(user, clientMessageId);
      if (replay) return replay;
    }

    let stored: { message: any; parties: ThreadParties };
    try {
      stored = await this.prisma.$transaction(async (tx) => {
        let threadId: string;
        if ('threadId' in target) {
          threadId = target.threadId;
        } else {
          const resolved = await resolveCanonicalThread(tx, target.identity);
          // The canonical row exists but was removed (its student or teacher was
          // taken off the platform). Not a conversation anyone can add to.
          if (resolved.deletedAt) {
            throw new NotFoundException('This conversation is no longer available');
          }
          threadId = resolved.id;
        }
        const parties = (await this.parties(threadId, tx))!;
        // A reply only means anything inside its own conversation; quoting across
        // threads would leak one student's message into another's.
        const replyToId = await this.replyTarget(threadId, payload.replyToId, tx);
        // Only a lesson that exists, so a bad id becomes a plain message rather
        // than a chip pointing at nothing.
        const lesson = payload.lessonId
          ? await tx.lesson.findUnique({ where: { id: payload.lessonId }, select: { id: true } })
          : null;

        const created = await tx.chatMessage.create({
          data: {
            threadId,
            senderId: user.sub,
            senderKind: this.senderKindFor(user, parties),
            body,
            replyToId,
            lessonId: lesson?.id,
            videoTimestampSec: lesson ? payload.videoTimestampSec : null,
            clientMessageId,
          },
        });
        if (attachmentIds.length) {
          const bound = await tx.chatAttachment.updateMany({
            where: {
              id: { in: attachmentIds },
              uploaderId: user.sub,
              status: 'PENDING',
              OR: [{ threadId }, { threadId: null, targetKey: parties.dedupeKey }],
            },
            data: { status: 'ATTACHED', messageId: created.id, threadId },
          });
          if (bound.count !== attachmentIds.length) {
            throw new BadRequestException({
              message: 'One of the files is not available to send here — upload it again',
              code: 'ATTACHMENT_INVALID',
            });
          }
        }
        const message = await tx.chatMessage.findUniqueOrThrow({
          where: { id: created.id },
          include: MESSAGE_INCLUDE,
        });
        await this.touchLastMessage(tx, threadId, message);
        return { message, parties };
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
        const replay = await this.replay(user, clientMessageId);
        if (replay) return replay;
      }
      throw e;
    }

    const { message, parties } = stored;
    // Writing in a conversation means having read everything before it.
    await this.markRead(user.sub, parties, message.createdAt);
    await this.fanOut(message, parties, user.sub);
    const [dto] = await this.present([message], user.sub, parties);
    return { message: dto, threadId: parties.id };
  }

  /** A send already stored under this client id, returned as a send would be. */
  private async replay(user: JwtPayload, clientMessageId: string) {
    const existing = await this.prisma.chatMessage.findUnique({
      where: { senderId_clientMessageId: { senderId: user.sub, clientMessageId } },
      include: MESSAGE_INCLUDE,
    });
    if (!existing) return null;
    const parties = (await this.parties(existing.threadId))!;
    const [dto] = await this.present([existing], user.sub, parties);
    return { message: dto, threadId: existing.threadId };
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
   * Deliver a new message to everyone in the conversation, each with their own
   * copy (`mine` and ✓ are per viewer), on every tab they have open — and
   * notify everyone but the sender.
   */
  private async fanOut(message: any, parties: ThreadParties, senderUserId: string) {
    const preview = previewOf(message);
    for (const userId of this.participantIds(parties)) {
      this.realtime.emitToUser(userId, RealtimeEvents.MESSAGE, toMessageDto(message, userId));
      if (userId === senderUserId) continue;
      this.realtime.emitToUser(userId, RealtimeEvents.THREAD_UPDATED, { threadId: parties.id });
      await this.notifications.create({
        userId,
        type: 'CHAT_MESSAGE',
        title: `رسالة جديدة من ${message.sender.fullName}`,
        body: preview,
        meta: { threadId: parties.id },
      });
    }
  }
}
