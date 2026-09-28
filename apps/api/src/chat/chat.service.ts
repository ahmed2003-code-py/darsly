import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ChatDeletedEvent,
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
import { StaffScopeService } from '../academy/staff-scope.service';
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
/** Files one message may carry — plus, on top, one voice note. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
export const MAX_VOICE_PER_MESSAGE = 1;

/**
 * A client's id for one send, so a retry is recognised as the same send.
 * Shape-checked on both transports (the socket path skips the HTTP pipe); a
 * UUID fits, and so does anything else URL-safe of a sensible length.
 */
export const CLIENT_MESSAGE_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Who a message is for. An existing conversation (threadId), or a person:
 * a student names a teacher (tenantId) or an assistant (staffUserId +
 * academyId); staff name a student (studentId), plus the academy when it is
 * not their own workspace.
 */
export interface ChatTarget {
  threadId?: string;
  tenantId?: string;
  studentId?: string;
  academyId?: string;
  staffUserId?: string;
}

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
  academyId: string | null;
  studentId: string;
  dedupeKey: string;
  studentUserId: string;
  staffUserId: string;
  /** OWNER: the teacher's own conversation. ASSISTANT: one of their assistants'. */
  staffKind: 'OWNER' | 'ASSISTANT';
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
    private readonly scopes: StaffScopeService,
  ) {}

  // ── Identity helpers ──────────────────────────────────────────────────────

  private async studentId(userId: string): Promise<string | null> {
    const s = await this.prisma.studentProfile.findUnique({ where: { userId } });
    return s?.id ?? null;
  }

  /**
   * True if the user is a participant in the thread: its student, the teacher
   * whose own conversation it is, the assistant whose conversation it is —
   * for as long as that assistant may still serve this student — or an admin.
   *
   * An assistant's access is re-derived on every call from their membership
   * as it is now (StaffScopeService): taking the student's course off them,
   * or their message.reply, or the membership itself, closes the conversation
   * to them on the next request. A teacher does not see their assistants'
   * conversations through this (that is the Phase 2 shared inbox).
   */
  async canAccessThread(user: JwtPayload, threadId: string): Promise<boolean> {
    const thread = await this.prisma.chatThread.findUnique({
      where: { id: threadId },
      select: {
        tenantId: true,
        studentId: true,
        academyId: true,
        staffUserId: true,
        teacher: { select: { userId: true } },
      },
    });
    if (!thread) return false;
    if (user.role === Role.SUPER_ADMIN) return true;
    const assistantThread = !!thread.staffUserId && thread.staffUserId !== thread.teacher.userId;
    if (assistantThread && thread.staffUserId === user.sub) {
      return this.assistantMayServe(user, thread.academyId, thread.studentId);
    }
    if (assistantThread && user.role !== Role.STUDENT) return false;
    // `!!user.tenantId` is defence in depth rather than a fix for a live bug:
    // the column is non-nullable and a teacher's token always carries a
    // tenant. But `undefined === undefined` is true, so the comparison on its
    // own would grant a tenant-less token access to a tenant-less thread the
    // day either of those assumptions stops holding.
    if (user.role === Role.TEACHER) return !!user.tenantId && thread.tenantId === user.tenantId;
    if (user.role !== Role.STUDENT) return false;
    const sid = await this.studentId(user.sub);
    return !!sid && thread.studentId === sid;
  }

  /**
   * May this staff member talk with this student in this academy right now:
   * a live membership holding message.reply, and the student enrolled in one
   * of their courses.
   */
  private async assistantMayServe(
    user: Pick<JwtPayload, 'sub' | 'role'>,
    academyId: string | null,
    studentId: string,
  ): Promise<boolean> {
    if (!academyId) return false;
    const scope = await this.scopes.resolve(user.sub, academyId, user.role);
    if (!scope || !scope.ctx.can('message.reply')) return false;
    return this.scopes.hasStudent(scope, studentId);
  }

  /** The title an assistant carries in this academy ("Student Support"). */
  private async assistantTitle(
    db: Prisma.TransactionClient,
    academyId: string | null,
    userId: string,
  ): Promise<string | null> {
    if (!academyId) return null;
    const m = await db.academyMembership.findFirst({
      where: { academyId, userId, status: 'ACTIVE' },
      select: { title: true },
    });
    return m?.title ?? null;
  }

  /** The conversation's participants, or null when it does not exist. */
  async parties(threadId: string, db: Prisma.TransactionClient = this.prisma) {
    const t = await db.chatThread.findUnique({
      where: { id: threadId },
      select: {
        id: true,
        tenantId: true,
        academyId: true,
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
    const staffUserId = t.staffUserId ?? t.teacher.userId;
    return {
      id: t.id,
      tenantId: t.tenantId,
      academyId: t.academyId,
      studentId: t.studentId,
      dedupeKey: t.dedupeKey,
      studentUserId: t.student.userId,
      staffUserId,
      staffKind: staffUserId === t.teacher.userId ? 'OWNER' : 'ASSISTANT',
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
    if (user.sub === p.staffUserId) return p.staffKind;
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
    const limit = clamp(page.limit ?? THREAD_PAGE, 1, THREAD_PAGE_MAX);
    const side = await this.listSide(user);
    if (!side) return [];

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
   * Which conversations are this viewer's to list.
   *
   *  - a student: their own, where messaging is open;
   *  - a teacher: their own conversations in their workspace — not their
   *    assistants' (that is the Phase 2 shared inbox);
   *  - an assistant: their own conversations, in each academy where they may
   *    still message, with students still in their courses. The same rule as
   *    canAccessThread, as a filter, so the list never shows a conversation
   *    that would refuse to open.
   *
   * A teacher who also assists in someone else's academy sees both.
   */
  private async listSide(user: JwtPayload): Promise<Prisma.ChatThreadWhereInput | null> {
    if (user.role === Role.STUDENT) {
      return {
        studentId: (await this.studentId(user.sub)) ?? '__none__',
        teacher: { acceptsStudentMessages: true },
      };
    }
    const sides: Prisma.ChatThreadWhereInput[] = [];
    // A teacher who has closed messaging is not shown a list of conversations
    // nobody can add to.
    if (user.role === Role.TEACHER && user.tenantId && (await this.messagingOpen(user.tenantId))) {
      sides.push({
        tenantId: user.tenantId,
        OR: [{ staffUserId: null }, { staffUserId: user.sub }],
      });
    }
    const memberships = await this.prisma.academyMembership.findMany({
      where: { userId: user.sub, status: 'ACTIVE', role: { in: ['ASSISTANT', 'TEACHER'] } },
      select: { academyId: true },
    });
    for (const { academyId } of memberships) {
      if (academyId === user.tenantId) continue;
      const scope = await this.scopes.resolve(user.sub, academyId, user.role);
      if (!scope || !scope.ctx.can('message.reply')) continue;
      sides.push({
        academyId,
        staffUserId: user.sub,
        student: this.scopes.studentWhere(scope),
        teacher: { acceptsStudentMessages: true },
      });
    }
    return sides.length ? { OR: sides } : null;
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
    // The assistants on the staff side of any of these conversations: who they
    // are, and the title the academy gave them. One query each, for the page.
    const assistantThreads = threads.filter(
      (th) => th.staffUserId && th.staffUserId !== th.teacher.userId,
    );
    const assistantIds = [...new Set(assistantThreads.map((th) => th.staffUserId!))];
    const [assistants, titles] = assistantIds.length
      ? await Promise.all([
          this.prisma.user.findMany({
            where: { id: { in: assistantIds } },
            select: { id: true, fullName: true, avatarUrl: true, updatedAt: true },
          }),
          this.prisma.academyMembership.findMany({
            where: {
              userId: { in: assistantIds },
              academyId: {
                in: [...new Set(assistantThreads.map((th) => th.academyId!).filter(Boolean))],
              },
            },
            select: { userId: true, academyId: true, title: true },
          }),
        ])
      : [[], []];
    const assistantById = new Map(assistants.map((u) => [u.id, u]));
    const titleOf = (academyId: string | null, userId: string) =>
      titles.find((m) => m.academyId === academyId && m.userId === userId)?.title ?? null;

    const [lastMessages, unread, cursors] = await Promise.all([
      lastIds.length
        ? this.prisma.chatMessage.findMany({
            where: { id: { in: lastIds } },
            select: {
              id: true,
              body: true,
              audioKey: true,
              revokedAt: true,
              createdAt: true,
              senderId: true,
              attachments: { select: { kind: true, fileName: true } },
              hiddenFor: { where: { userId: user.sub }, select: { userId: true } },
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

    return threads.map((thread) => {
      // Which side the viewer is on is decided by the conversation, not by the
      // account's role: a teacher can be the assistant in someone else's.
      const staffSide = thread.student.userId !== user.sub;
      const staffUserId = thread.staffUserId ?? thread.teacher.userId;
      const isAssistant = staffUserId !== thread.teacher.userId;
      const staffUser = isAssistant
        ? (assistantById.get(staffUserId) ?? thread.teacher.user)
        : thread.teacher.user;
      const counterpart = staffSide ? thread.student.user : staffUser;
      const counterpartUserId = staffSide ? thread.student.userId : staffUserId;
      const last = thread.lastMessageId ? lastById.get(thread.lastMessageId) : undefined;
      return {
        id: thread.id,
        type: thread.type as ChatThreadDto['type'],
        tenantId: thread.tenantId,
        studentId: thread.studentId,
        counterpartName: counterpart.fullName,
        counterpartAvatarUrl: avatarUrl(counterpart),
        counterpartKind: staffSide ? 'STUDENT' : isAssistant ? 'ASSISTANT' : 'OWNER',
        counterpartTitle: !staffSide && isAssistant ? titleOf(thread.academyId, staffUserId) : null,
        lessonId: thread.lessonId,
        lessonTitle: null,
        videoTimestampSec: thread.videoTimestampSec,
        // A voice note or a photo has no text, and an empty preview made a
        // conversation full of them look like one nobody had written in yet.
        // A last message this viewer deleted for themselves reads as deleted,
        // not as its text: they asked not to see it.
        lastMessage: last
          ? previewOf(last.hiddenFor?.length ? { body: '', revokedAt: last.createdAt } : last) ||
            null
          : null,
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
        AND m."revokedAt" IS NULL
        AND m."senderId" <> ${user.sub}
        AND NOT EXISTS (SELECT 1 FROM "ChatMessageHide" h
                        WHERE h."messageId" = m.id AND h."userId" = ${user.sub})
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
      // "Delete for me" — gone from this viewer's copy only.
      hiddenFor: { none: { userId: user.sub } },
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
    payload: ChatTarget,
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
      if (payload.staffUserId) return this.studentToAssistant(sid, payload);
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

    // An assistant (or a teacher helping in someone else's academy) writing
    // first: as themselves, in that academy, to a student of their courses.
    if (payload.academyId && payload.academyId !== user.tenantId) {
      return this.assistantToStudent(user, payload.academyId, payload.studentId);
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

  /**
   * A student starting a conversation with an assistant: only one the academy
   * made reachable (directContact), who may still message, and whose courses
   * the student is actively enrolled in. Everything is checked against the
   * assistant's membership as it is now.
   */
  private async studentToAssistant(
    studentId: string,
    payload: ChatTarget,
  ): Promise<{ identity: ThreadIdentity }> {
    const refuse = () =>
      new ForbiddenException({
        message: 'This person cannot be messaged directly',
        code: 'ASSISTANT_NOT_REACHABLE',
      });
    if (!payload.academyId)
      throw new BadRequestException('academyId required to message an assistant');
    const member = await this.prisma.academyMembership.findFirst({
      where: {
        userId: payload.staffUserId!,
        academyId: payload.academyId,
        role: 'ASSISTANT',
        status: 'ACTIVE',
        directContact: true,
      },
      select: { user: { select: { role: true } } },
    });
    if (!member) throw refuse();
    const scope = await this.scopes.resolve(
      payload.staffUserId!,
      payload.academyId,
      member.user.role,
    );
    if (!scope || !scope.ctx.can('message.reply')) throw refuse();
    const enrollment = await this.prisma.enrollment.findFirst({
      where: { studentId, status: 'ACTIVE', course: scope.courses },
      orderBy: { createdAt: 'desc' },
      select: { course: { select: { tenantId: true } } },
    });
    if (!enrollment) throw refuse();
    const tenantId = enrollment.course.tenantId;
    await this.openTeacher(tenantId, 'Messaging is switched off for this academy');
    return {
      identity: {
        academyId: payload.academyId,
        tenantId,
        studentId,
        staffUserId: payload.staffUserId!,
      },
    };
  }

  /**
   * A staff member writing first in an academy that is not their own
   * workspace. They must hold message.reply there, and the student must be
   * enrolled — in any status — in one of their courses. The conversation is
   * theirs (staffUserId), never the teacher's: they do not speak as the
   * teacher and the teacher's inbox is not where it lands.
   */
  private async assistantToStudent(
    user: JwtPayload,
    academyId: string,
    studentId?: string,
  ): Promise<{ identity: ThreadIdentity }> {
    if (!studentId) throw new BadRequestException('studentId required to start a chat');
    const scope = await this.scopes.resolve(user.sub, academyId, user.role);
    if (!scope || !scope.ctx.can('message.reply')) {
      throw new ForbiddenException({
        message: 'You cannot message students in this academy',
        code: 'NO_MESSAGE_PERMISSION',
      });
    }
    const enrollment = await this.prisma.enrollment.findFirst({
      where: { studentId, course: scope.courses },
      orderBy: { createdAt: 'desc' },
      select: { course: { select: { tenantId: true } } },
    });
    if (!enrollment) throw new ForbiddenException('You can only message students of your courses');
    const tenantId = enrollment.course.tenantId;
    await this.openTeacher(tenantId, 'Messaging is switched off for this academy');
    return { identity: { academyId, tenantId, studentId, staffUserId: user.sub } };
  }

  /**
   * Who a student can start a conversation with: each teacher they are
   * actively enrolled with (whose messaging is open), and each assistant of
   * those academies the academy made reachable (directContact) who may
   * message and works on one of the student's courses. An assistant with
   * directContact off is simply not here — and studentToAssistant refuses
   * them too, so leaving them out is not the only thing stopping it.
   */
  async contacts(user: JwtPayload) {
    if (user.role !== Role.STUDENT) return [];
    const sid = await this.studentId(user.sub);
    if (!sid) return [];
    const enrollments = await this.prisma.enrollment.findMany({
      where: { studentId: sid, status: 'ACTIVE' },
      select: { course: { select: { tenantId: true, academyId: true } } },
    });
    const tenantIds = [...new Set(enrollments.map((e) => e.course.tenantId))];
    const academyIds = [
      ...new Set(enrollments.map((e) => e.course.academyId).filter((x): x is string => !!x)),
    ];
    const person = { id: true, fullName: true, avatarUrl: true, updatedAt: true } as const;
    const [teachers, candidates, academies] = await Promise.all([
      this.prisma.teacherProfile.findMany({
        where: { id: { in: tenantIds }, acceptsStudentMessages: true },
        select: { id: true, user: { select: person } },
      }),
      this.prisma.academyMembership.findMany({
        where: {
          academyId: { in: academyIds },
          role: 'ASSISTANT',
          status: 'ACTIVE',
          directContact: true,
        },
        orderBy: { createdAt: 'asc' },
        select: {
          userId: true,
          academyId: true,
          title: true,
          user: { select: { ...person, role: true } },
        },
      }),
      this.prisma.academy.findMany({
        where: { id: { in: academyIds } },
        select: { id: true, name: true },
      }),
    ]);
    const academyName = (id: string) => academies.find((a) => a.id === id)?.name ?? null;
    const assistants = [];
    for (const m of candidates) {
      const scope = await this.scopes.resolve(m.userId, m.academyId, m.user.role);
      if (!scope || !scope.ctx.can('message.reply')) continue;
      const shares = await this.prisma.enrollment.count({
        where: { studentId: sid, status: 'ACTIVE', course: scope.courses },
      });
      if (!shares) continue;
      assistants.push({
        kind: 'ASSISTANT' as const,
        staffUserId: m.userId,
        academyId: m.academyId,
        academyName: academyName(m.academyId),
        name: m.user.fullName,
        avatarUrl: avatarUrl(m.user),
        title: m.title,
      });
    }
    return [
      ...teachers.map((t) => ({
        kind: 'OWNER' as const,
        tenantId: t.id,
        academyId: t.id,
        academyName: academyName(t.id),
        name: t.user.fullName,
        avatarUrl: avatarUrl(t.user),
        title: null,
      })),
      ...assistants,
    ];
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
    payload: ChatTarget,
  ): Promise<{
    threadId: string | null;
    counterpartName: string;
    counterpartAvatarUrl: string | null;
    counterpartKind: ChatSenderKind;
    counterpartTitle: string | null;
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
    const toAssistant = user.role === Role.STUDENT && !!payload.staffUserId;
    return {
      threadId: existing && !existing.deletedAt ? existing.id : null,
      counterpartName: counterpart.fullName,
      counterpartAvatarUrl: avatarUrl(counterpart),
      counterpartKind: user.role !== Role.STUDENT ? 'STUDENT' : toAssistant ? 'ASSISTANT' : 'OWNER',
      counterpartTitle: toAssistant
        ? await this.assistantTitle(this.prisma, identity.academyId, identity.staffUserId)
        : null,
    };
  }

  /**
   * DEPRECATED — kept only for browser tabs loaded before `resolve` existed.
   * Goes through the same atomic path as a send, so it cannot duplicate.
   */
  async openThread(user: JwtPayload, payload: ChatTarget) {
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
      where: { id: replyToId, threadId, revokedAt: null },
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
    const senderKind = this.senderKindFor(user, parties);
    const message = await this.prisma.chatMessage.create({
      data: {
        threadId,
        senderId: user.sub,
        senderKind,
        senderTitle:
          senderKind === 'ASSISTANT'
            ? await this.assistantTitle(this.prisma, parties.academyId, user.sub)
            : null,
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
      select: {
        id: true,
        threadId: true,
        audioKey: true,
        audioMimeType: true,
        audioBytes: true,
        revokedAt: true,
      },
    });
    if (!message?.audioKey || message.revokedAt) throw new NotFoundException('No voice note here');
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
    if (attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE + MAX_VOICE_PER_MESSAGE) {
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

        const senderKind = this.senderKindFor(user, parties);
        const created = await tx.chatMessage.create({
          data: {
            threadId,
            senderId: user.sub,
            senderKind,
            // An assistant's title is frozen onto what they said, so a later
            // change of title does not rewrite who said it as what.
            senderTitle:
              senderKind === 'ASSISTANT'
                ? await this.assistantTitle(tx, parties.academyId, user.sub)
                : null,
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
          // One message: up to five files and one voice note, checked on what
          // was actually bound — the transaction rolls back if it is more.
          const kinds = await tx.chatAttachment.groupBy({
            by: ['kind'],
            where: { messageId: created.id },
            _count: { _all: true },
          });
          const count = (k: string) => kinds.find((x) => x.kind === k)?._count._all ?? 0;
          if (count('VOICE') > MAX_VOICE_PER_MESSAGE) {
            throw new BadRequestException({
              message: 'One voice note per message',
              code: 'TOO_MANY_VOICE',
            });
          }
          if (count('IMAGE') + count('FILE') > MAX_ATTACHMENTS_PER_MESSAGE) {
            throw new BadRequestException({
              message: `At most ${MAX_ATTACHMENTS_PER_MESSAGE} files per message`,
              code: 'TOO_MANY_ATTACHMENTS',
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

  // ── Deleting ──────────────────────────────────────────────────────────────

  /**
   * Delete for everyone. Only the person who sent it — a teacher cannot take
   * back a student's words, nor an assistant anyone else's; the rule is the
   * sender, whatever their role, so a guardian or a team member later fits
   * without a new rule. The row stays as a tombstone (the conversation keeps
   * its shape, replies to it read "unavailable"); what it said, its files and
   * its voice are never served again, and its reactions go.
   */
  async revokeMessage(user: JwtPayload, messageId: string) {
    const m = await this.prisma.chatMessage.findFirst({
      where: { id: messageId },
      select: { id: true, threadId: true, senderId: true, revokedAt: true },
    });
    if (!m || !(await this.canAccessThread(user, m.threadId))) {
      throw new ForbiddenException('Not your thread');
    }
    if (m.senderId !== user.sub) {
      throw new ForbiddenException({
        message: 'Only the sender can delete a message for everyone',
        code: 'NOT_SENDER',
      });
    }
    if (!m.revokedAt) {
      await this.prisma.$transaction([
        this.prisma.chatMessage.updateMany({
          where: { id: m.id, revokedAt: null },
          data: { revokedAt: new Date(), revokedById: user.sub },
        }),
        this.prisma.chatReaction.deleteMany({ where: { messageId: m.id } }),
      ]);
    }
    const parties = (await this.parties(m.threadId))!;
    const event: ChatDeletedEvent = { threadId: m.threadId, messageId: m.id, scope: 'everyone' };
    for (const id of this.participantIds(parties)) {
      this.realtime.emitToUser(id, RealtimeEvents.DELETED, event);
      this.realtime.emitToUser(id, RealtimeEvents.THREAD_UPDATED, { threadId: m.threadId });
    }
    return event;
  }

  /**
   * Delete for me: this viewer stops seeing the message, everywhere they are
   * signed in, and nobody else is affected. Allowed on any message they can
   * read — theirs, the other side's, or a tombstone.
   */
  async hideMessage(user: JwtPayload, messageId: string) {
    const m = await this.prisma.chatMessage.findFirst({
      where: { id: messageId },
      select: { id: true, threadId: true },
    });
    if (!m || !(await this.canAccessThread(user, m.threadId))) {
      throw new ForbiddenException('Not your thread');
    }
    await this.prisma.chatMessageHide.upsert({
      where: { messageId_userId: { messageId: m.id, userId: user.sub } },
      create: { messageId: m.id, userId: user.sub },
      update: {},
    });
    const event: ChatDeletedEvent = { threadId: m.threadId, messageId: m.id, scope: 'me' };
    this.realtime.emitToUser(user.sub, RealtimeEvents.DELETED, event);
    this.realtime.emitToUser(user.sub, RealtimeEvents.THREAD_UPDATED, { threadId: m.threadId });
    return event;
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
