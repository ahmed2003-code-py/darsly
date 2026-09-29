import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ChatContactDto,
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
import { ConversationPolicy, isLearnerRole, ThreadParties, Viewer } from './conversation-policy';
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
  /** The academy's support team (with academyId; a guardian also names studentId). */
  team?: boolean;
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

const PERSON = { id: true, fullName: true, avatarUrl: true, updatedAt: true } as const;

/** Both sides of a conversation, as the list draws them. */
const THREAD_INCLUDE = {
  teacher: { select: { userId: true, user: { select: PERSON } } },
  student: { select: { userId: true, user: { select: PERSON } } },
  // Nested reads are not filtered by the soft-delete middleware: count only
  // the group's active members explicitly.
  group: {
    select: {
      id: true,
      name: true,
      _count: { select: { members: { where: { deletedAt: null } } } },
    },
  },
} as const;

type ThreadWithSides = Prisma.ChatThreadGetPayload<{ include: typeof THREAD_INCLUDE }>;

export { isLearnerRole };
export type { ThreadParties };

/** The staff inbox's views. `mine` = TEAM conversations I hold, plus my own DIRECT ones. */
export type InboxFilter = 'all' | 'mine' | 'unassigned' | 'unread' | 'resolved';

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
    private readonly policy: ConversationPolicy,
  ) {}

  // ── Identity helpers ──────────────────────────────────────────────────────

  private async studentId(userId: string): Promise<string | null> {
    const s = await this.prisma.studentProfile.findUnique({ where: { userId } });
    return s?.id ?? null;
  }

  /** True if the user may read the thread at all (see ConversationPolicy). */
  async canAccessThread(user: JwtPayload, threadId: string): Promise<boolean> {
    return !!(await this.open(user, threadId));
  }

  /** The conversation and what this user may do in it — or null. */
  async open(user: JwtPayload, threadId: string): Promise<{ p: ThreadParties; v: Viewer } | null> {
    const p = await this.policy.parties(threadId);
    if (!p) return null;
    const v = await this.policy.viewer(user, p);
    return v ? { p, v } : null;
  }

  /** Which side the caller is on (kept for the callers that only need that). */
  async access(user: JwtPayload, p: ThreadParties): Promise<'learner' | 'staff' | null> {
    const v = await this.policy.viewer(user, p);
    return !v ? null : v.side === 'staff' ? 'staff' : 'learner';
  }

  guardianLinked(guardianUserId: string, studentId: string, academyId: string | null) {
    return this.policy.guardianLinked(guardianUserId, studentId, academyId);
  }

  teamMayServe(
    user: Pick<JwtPayload, 'sub' | 'role'>,
    academyId: string | null,
    studentId: string,
    cap: 'message.inbox' | 'message.oversee' = 'message.inbox',
  ) {
    return this.policy.teamMayServe(user, academyId, studentId, cap);
  }

  teamStaff(academyId: string | null, studentId: string) {
    return this.policy.teamStaff(academyId, studentId);
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
  parties(threadId: string, db: Prisma.TransactionClient = this.prisma) {
    return this.policy.parties(threadId, db);
  }

  /** Everyone who receives this conversation's live events now. */
  participantIds(p: ThreadParties): Promise<string[]> {
    return this.policy.recipients(p);
  }

  private senderOf(user: JwtPayload, p: ThreadParties, db: Prisma.TransactionClient = this.prisma) {
    return this.policy.senderOf(user, p, db);
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
   * One page of the viewer's conversations, newest activity first — through
   * one of the staff inbox's views when asked.
   *
   * Bounded: at most `limit` conversations, and a fixed number of queries
   * however many there are. "Unread" is decided per viewer (their own read
   * position), so it filters a bounded window of candidates by the same
   * single grouped query the badges use.
   */
  async listThreads(
    user: JwtPayload,
    page: { limit?: number; before?: string; filter?: InboxFilter } = {},
  ): Promise<ChatThreadDto[]> {
    const limit = clamp(page.limit ?? THREAD_PAGE, 1, THREAD_PAGE_MAX);
    const side = await this.listSide(user);
    if (!side) return [];

    // A conversation someone cleared has nothing in it for them until the next
    // message lands, and an empty conversation is not a row worth drawing —
    // which is also why a conversation with no message at all never shows.
    const learner = isLearnerRole(user.role);
    const cleared = learner
      ? this.prisma.chatThread.fields.clearedForStudentAt
      : this.prisma.chatThread.fields.clearedForTeacherAt;
    const clearedField = learner ? 'clearedForStudentAt' : 'clearedForTeacherAt';
    const and: Prisma.ChatThreadWhereInput[] = [
      side,
      { lastMessageAt: { not: null } },
      { OR: [{ [clearedField]: null }, { lastMessageAt: { gt: cleared } }] },
    ];
    const filter = learner ? 'all' : (page.filter ?? 'all');
    if (filter === 'mine') {
      and.push({ OR: [{ kind: 'TEAM', assigneeUserId: user.sub }, { kind: 'DIRECT' }] });
    } else if (filter === 'unassigned') {
      and.push({ kind: 'TEAM', assigneeUserId: null, resolvedAt: null });
    } else if (filter === 'resolved') {
      and.push({ kind: 'TEAM', resolvedAt: { not: null } });
    }
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

    let threads = await this.prisma.chatThread.findMany({
      where: { AND: and },
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      take: filter === 'unread' ? 300 : limit,
      include: THREAD_INCLUDE,
    });
    if (filter === 'unread' && threads.length) {
      const unread = await this.unreadCounts(threads, user);
      threads = threads.filter((t) => (unread.get(t.id) ?? 0) > 0).slice(0, limit);
    }
    return this.toThreadDtos(threads, user);
  }

  /**
   * Which conversations are this viewer's to list — the same rules as
   * `access`, written as a filter, so the list never shows a conversation
   * that would refuse to open.
   *
   *  - a student: their own (never their guardians'), where messaging is open;
   *  - a guardian: their own, for each ACTIVE link (child + academy);
   *  - staff: a teacher's own DIRECT conversations; an assistant's own DIRECT
   *    conversations with students of their courses; and, with message.inbox,
   *    the TEAM conversations of the students of their courses.
   */
  private async listSide(user: JwtPayload): Promise<Prisma.ChatThreadWhereInput | null> {
    if (user.role === Role.STUDENT) {
      return {
        OR: [
          {
            kind: { in: ['DIRECT', 'TEAM'] },
            studentId: (await this.studentId(user.sub)) ?? '__none__',
            guardianUserId: null,
            teacher: { acceptsStudentMessages: true },
          },
          // The chats of the groups they are an active member of — the
          // Group's own membership decides, nothing kept by the chat.
          {
            kind: 'GROUP',
            archivedAt: null,
            group: {
              deletedAt: null,
              status: 'ACTIVE',
              members: { some: { deletedAt: null, student: { userId: user.sub } } },
            },
          },
        ],
      };
    }
    if (user.role === Role.GUARDIAN) {
      const links = await this.prisma.guardianLink.findMany({
        where: { status: 'ACTIVE', guardian: { userId: user.sub } },
        select: { studentId: true, academyId: true },
      });
      if (!links.length) return null;
      return {
        guardianUserId: user.sub,
        teacher: { acceptsStudentMessages: true },
        OR: links.map((l) => ({ studentId: l.studentId, academyId: l.academyId })),
      };
    }
    const sides: Prisma.ChatThreadWhereInput[] = [];
    // A teacher who has closed messaging is not shown a list of conversations
    // nobody can add to.
    if (user.role === Role.TEACHER && user.tenantId && (await this.messagingOpen(user.tenantId))) {
      sides.push({
        kind: 'DIRECT',
        tenantId: user.tenantId,
        OR: [{ staffUserId: null }, { staffUserId: user.sub }],
      });
    }
    const memberships = await this.prisma.academyMembership.findMany({
      where: {
        userId: user.sub,
        status: 'ACTIVE',
        role: { in: ['OWNER', 'ASSISTANT', 'TEACHER'] },
      },
      select: { academyId: true },
    });
    for (const { academyId } of memberships) {
      const scope = await this.scopes.resolve(user.sub, academyId, user.role);
      if (!scope) continue;
      const students = this.scopes.studentWhere(scope);
      if (academyId !== user.tenantId && scope.ctx.can('message.reply')) {
        sides.push({
          kind: 'DIRECT',
          academyId,
          staffUserId: user.sub,
          student: students,
          teacher: { acceptsStudentMessages: true },
        });
      }
      if (scope.ctx.can('message.inbox')) {
        sides.push({
          kind: 'TEAM',
          academyId,
          student: students,
          teacher: { acceptsStudentMessages: true },
        });
      }
      // Group chats: every group's for the owner, assigned groups' for anyone
      // else — the same group scope attendance and scheduling use.
      if (scope.ctx.can('message.group')) {
        sides.push({
          kind: 'GROUP',
          academyId,
          archivedAt: null,
          group: {
            deletedAt: null,
            ...(scope.ctx.role === 'OWNER'
              ? {}
              : { assignments: { some: { userId: user.sub, deletedAt: null } } }),
          },
        });
      }
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
    return isLearnerRole(user.role) ? thread.clearedForStudentAt : thread.clearedForTeacherAt;
  }

  /**
   * DTOs for a page of conversations in a fixed number of queries, whatever
   * its size: the people on the other sides, the academies, the last
   * messages, the unread counts, and the read positions.
   */
  private async toThreadDtos(
    threads: ThreadWithSides[],
    user: JwtPayload,
  ): Promise<ChatThreadDto[]> {
    if (!threads.length) return [];
    const ids = threads.map((th) => th.id);
    const lastIds = threads.map((th) => th.lastMessageId).filter((x): x is string => !!x);
    // Everyone named on these rows who is not the student or the teacher:
    // assistants of DIRECT conversations, guardians, and TEAM assignees.
    const personIds = [
      ...new Set(
        threads
          .flatMap((th) => [
            th.kind === 'DIRECT' && th.staffUserId !== th.teacher?.userId ? th.staffUserId : null,
            th.guardianUserId,
            th.assigneeUserId,
          ])
          .filter((x): x is string => !!x),
      ),
    ];
    const academyIds = [
      ...new Set(threads.map((th) => th.academyId).filter((x): x is string => !!x)),
    ];
    const guardianThreads = threads.filter((th) => th.guardianUserId && th.studentId);
    const [people, titles, academies, relations] = await Promise.all([
      personIds.length
        ? this.prisma.user.findMany({ where: { id: { in: personIds } }, select: PERSON })
        : Promise.resolve([]),
      personIds.length
        ? this.prisma.academyMembership.findMany({
            where: { userId: { in: personIds }, academyId: { in: academyIds } },
            select: { userId: true, academyId: true, title: true },
          })
        : Promise.resolve([]),
      academyIds.length
        ? this.prisma.academy.findMany({
            where: { id: { in: academyIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
      guardianThreads.length
        ? this.prisma.guardianLink.findMany({
            where: {
              OR: guardianThreads.map((th) => ({
                studentId: th.studentId!,
                academyId: th.academyId ?? '',
                guardian: { userId: th.guardianUserId! },
              })),
            },
            select: {
              studentId: true,
              academyId: true,
              relationship: true,
              guardian: { select: { userId: true } },
            },
          })
        : Promise.resolve([]),
    ]);
    const personById = new Map(people.map((u) => [u.id, u]));
    const titleOf = (academyId: string | null, userId: string) =>
      titles.find((m) => m.academyId === academyId && m.userId === userId)?.title ?? null;
    const academyName = (id: string | null) => academies.find((a) => a.id === id)?.name ?? null;
    const relationOf = (th: ThreadWithSides) =>
      relations.find(
        (r) =>
          r.studentId === th.studentId &&
          r.academyId === th.academyId &&
          r.guardian.userId === th.guardianUserId,
      )?.relationship ?? null;

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
              sender: { select: { fullName: true } },
              attachments: { select: { kind: true, fileName: true } },
              hiddenFor: { where: { userId: user.sub }, select: { userId: true } },
            },
          })
        : Promise.resolve([]),
      this.unreadCounts(threads, user),
      this.prisma.chatReadState.findMany({
        where: { threadId: { in: ids } },
        select: { threadId: true, userId: true, lastReadAt: true },
      }),
    ]);
    const lastById = new Map(lastMessages.map((m) => [m.id, m]));
    const cursorOf = (threadId: string, userId: string | null) =>
      cursors.find((c) => c.threadId === threadId && c.userId === userId)?.lastReadAt ?? null;
    /** The newest read position of anyone but this person. */
    const othersCursor = (threadId: string, exceptUserId: string | null) =>
      cursors
        .filter((c) => c.threadId === threadId && c.userId !== exceptUserId)
        .reduce<Date | null>((a, c) => (!a || c.lastReadAt > a ? c.lastReadAt : a), null);

    return threads.map((thread): ChatThreadDto => {
      const last = thread.lastMessageId ? lastById.get(thread.lastMessageId) : undefined;
      // A last message this viewer deleted for themselves reads as deleted,
      // not as its text: they asked not to see it. In a group, who said it.
      const preview = last
        ? previewOf(last.hiddenFor?.length ? { body: '', revokedAt: last.createdAt } : last)
        : null;
      const common = {
        id: thread.id,
        type: thread.type as ChatThreadDto['type'],
        tenantId: thread.tenantId ?? '',
        studentId: thread.studentId ?? '',
        kind: thread.kind,
        academyId: thread.academyId,
        academyName: academyName(thread.academyId),
        lessonId: thread.lessonId,
        lessonTitle: null,
        videoTimestampSec: thread.videoTimestampSec,
        lastMessageAt: (last?.createdAt ?? thread.lastMessageAt)?.toISOString() ?? null,
        lastMessageMine: last ? last.senderId === user.sub : false,
        unread: unread.get(thread.id) ?? 0,
        myLastReadAt: cursorOf(thread.id, user.sub)?.toISOString() ?? null,
        updatedAt: thread.updatedAt.toISOString(),
      };

      if (thread.kind === 'GROUP') {
        return {
          ...common,
          counterpartName: thread.group?.name ?? '',
          counterpartAvatarUrl: null,
          lastMessage: preview
            ? last!.senderId === user.sub || last!.revokedAt
              ? preview
              : `${last!.sender.fullName}: ${preview}`
            : null,
          counterpartLastReadAt: othersCursor(thread.id, user.sub)?.toISOString() ?? null,
          groupId: thread.groupId,
          groupName: thread.group?.name ?? null,
          groupMode: thread.groupMode,
          memberCount: thread.group?._count.members ?? 0,
          archived: !!thread.archivedAt,
        };
      }

      const learnerUserId = thread.guardianUserId ?? thread.student!.userId;
      const guardian = thread.guardianUserId ? personById.get(thread.guardianUserId) : undefined;
      // Which side the viewer is on is decided by the conversation, not by the
      // account's role: a teacher can be the assistant in someone else's.
      const staffSide = learnerUserId !== user.sub;
      const team = thread.kind === 'TEAM';
      const teacherUserId = thread.teacher?.userId ?? null;
      const staffUserId = team ? null : (thread.staffUserId ?? teacherUserId);
      const isAssistant = !team && staffUserId !== teacherUserId;
      const staffUser = isAssistant
        ? (personById.get(staffUserId!) ?? thread.teacher?.user)
        : thread.teacher?.user;
      const learner = guardian ?? thread.student!.user;
      const assignee = thread.assigneeUserId ? personById.get(thread.assigneeUserId) : undefined;

      let counterpartName: string;
      let counterpartAvatar: string | null;
      let counterpartKind: ChatSenderKind | undefined;
      if (staffSide) {
        counterpartName = learner.fullName;
        counterpartAvatar = avatarUrl(learner);
        counterpartKind = guardian ? 'GUARDIAN' : 'STUDENT';
      } else if (team) {
        // The team is a destination, not a person: it is named by the academy.
        counterpartName = academyName(thread.academyId) ?? '';
        counterpartAvatar = null;
        counterpartKind = undefined;
      } else {
        counterpartName = staffUser?.fullName ?? '';
        counterpartAvatar = staffUser ? avatarUrl(staffUser) : null;
        counterpartKind = isAssistant ? 'ASSISTANT' : 'OWNER';
      }
      const counterpartRead = staffSide
        ? cursorOf(thread.id, learnerUserId)
        : team
          ? othersCursor(thread.id, learnerUserId)
          : cursorOf(thread.id, staffUserId);
      return {
        ...common,
        counterpartName,
        counterpartAvatarUrl: counterpartAvatar,
        counterpartKind,
        counterpartTitle:
          !staffSide && isAssistant ? titleOf(thread.academyId, staffUserId!) : null,
        learnerKind: guardian ? 'GUARDIAN' : 'STUDENT',
        studentName: thread.student?.user.fullName ?? null,
        guardianRelationship: guardian ? relationOf(thread) : null,
        assigneeUserId: thread.assigneeUserId,
        assigneeName: assignee?.fullName ?? null,
        resolvedAt: thread.resolvedAt?.toISOString() ?? null,
        lastMessage: preview || null,
        counterpartLastReadAt: counterpartRead?.toISOString() ?? null,
      };
    });
  }

  /**
   * Unread messages per conversation, for many conversations, in one query:
   * messages from anyone else, after this viewer's read position and after
   * their cleared line. The position and the line differ per viewer and per
   * conversation, which is why this is SQL rather than a Prisma groupBy.
   */
  private async unreadCounts(
    threads: { id: string }[],
    user: JwtPayload,
  ): Promise<Map<string, number>> {
    if (!threads.length) return new Map();
    const clearedColumn = Prisma.raw(
      isLearnerRole(user.role) ? '"clearedForStudentAt"' : '"clearedForTeacherAt"',
    );
    // In a GROUP chat a student's history starts when they joined the group;
    // what was said before is not theirs, so it is not "unread" either.
    const rows = await this.prisma.$queryRaw<{ threadId: string; unread: number }[]>`
      SELECT m."threadId", count(*)::int AS "unread"
      FROM "ChatMessage" m
      JOIN "ChatThread" t ON t.id = m."threadId"
      LEFT JOIN "ChatReadState" r ON r."threadId" = m."threadId" AND r."userId" = ${user.sub}
      LEFT JOIN "GroupMembership" gm
        ON t."kind" = 'GROUP' AND gm."groupId" = t."groupId" AND gm."deletedAt" IS NULL
       AND gm."studentId" = (SELECT sp.id FROM "StudentProfile" sp WHERE sp."userId" = ${user.sub})
      WHERE m."threadId" IN (${Prisma.join(threads.map((t) => t.id))})
        AND m."deletedAt" IS NULL
        AND m."revokedAt" IS NULL
        AND m."senderId" <> ${user.sub}
        AND NOT EXISTS (SELECT 1 FROM "ChatMessageHide" h
                        WHERE h."messageId" = m.id AND h."userId" = ${user.sub})
        AND (r."lastReadAt" IS NULL OR m."createdAt" > r."lastReadAt")
        AND (t.${clearedColumn} IS NULL OR m."createdAt" > t.${clearedColumn})
        AND (gm."addedAt" IS NULL OR m."createdAt" >= gm."addedAt")
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
    const p = await this.parties(threadId);
    const side = p ? await this.access(user, p) : null;
    if (!side) throw new ForbiddenException('Not your thread');
    // A group's copy is shared by all its students and all its staff, and a
    // TEAM's staff side by the whole team: one person clearing either would
    // clear it for everyone. Staff resolve a TEAM conversation instead.
    if (p!.kind === 'GROUP') {
      throw new BadRequestException({
        message: 'A group conversation cannot be cleared',
        code: 'GROUP_CLEAR',
      });
    }
    if (p!.kind === 'TEAM' && side === 'staff') {
      throw new BadRequestException({
        message: 'Resolve a team conversation instead of clearing it',
        code: 'TEAM_CLEAR',
      });
    }
    await this.prisma.chatThread.update({
      where: { id: threadId },
      data:
        side === 'learner'
          ? { clearedForStudentAt: new Date() }
          : { clearedForTeacherAt: new Date() },
    });
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
    const opened = await this.open(user, threadId);
    if (!opened) throw new ForbiddenException('Not your thread');
    const historyFrom = opened.v.historyFrom;
    if ([page.before, page.after, page.around].filter(Boolean).length > 1) {
      throw new BadRequestException({
        message: 'Ask for one of older, newer or around a message',
        code: 'CURSOR_CONFLICT',
      });
    }
    const limit = clamp(page.limit ?? MESSAGE_PAGE, 1, MESSAGE_PAGE_MAX);
    const parties = opened.p;
    const from = this.clearedAt(parties, user);
    // Where this viewer's copy starts: after their cleared line, and — for a
    // student added to a group — not before they joined. Nothing earlier is
    // theirs: not in a page, not around a cursor, not through a quote.
    const lower: Prisma.DateTimeFilter = {
      ...(from ? { gt: from } : {}),
      ...(historyFrom ? { gte: historyFrom } : {}),
    };
    const base: Prisma.ChatMessageWhereInput = {
      threadId,
      ...(from || historyFrom ? { createdAt: lower } : {}),
      // "Delete for me" — gone from this viewer's copy only.
      hiddenFor: { none: { userId: user.sub } },
    };

    const cursorId = page.before ?? page.after ?? page.around;
    let cursor: { id: string; createdAt: Date } | null = null;
    if (cursorId) {
      // The cursor must be a message of THIS conversation; anything else would
      // let a page boundary be steered by a message from somewhere else.
      cursor = await this.prisma.chatMessage.findFirst({
        where: {
          id: cursorId,
          threadId,
          ...(historyFrom ? { createdAt: { gte: historyFrom } } : {}),
        },
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
    return this.present(rows, user.sub, parties, historyFrom);
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
    historyFrom: Date | null = null,
  ): Promise<ChatMessageDto[]> {
    if (!rows.length) return [];
    const group = parties.kind === 'GROUP';
    // ✓✓ means the OTHER SIDE has read it: for the learner, anyone on the
    // staff side; for staff, the learner — never a teammate reading along. In
    // a group: how many other members have read it (a count, never a list of
    // faces under every message), from the same per-person cursors.
    const viewerIsLearner = viewerUserId === parties.learnerUserId;
    const [reactionRows, cursors] = await Promise.all([
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
      this.prisma.chatReadState.findMany({
        where: {
          threadId: parties.id,
          userId:
            group || viewerIsLearner
              ? { not: viewerUserId }
              : (parties.learnerUserId ?? '__none__'),
        },
        select: { lastReadAt: true },
      }),
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
    const newest = cursors.reduce<Date | null>(
      (a, c) => (!a || c.lastReadAt > a ? c.lastReadAt : a),
      null,
    );
    return rows.map((m) =>
      toMessageDto(m, viewerUserId, {
        reactions,
        seenBy: newest,
        historyFrom,
        seenCount:
          group && m.senderId === viewerUserId
            ? cursors.filter((c) => c.lastReadAt >= new Date(m.createdAt)).length
            : undefined,
      }),
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
    for (const id of await this.participantIds(parties)) {
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
  ): Promise<{ threadId: string; historyFrom?: Date | null } | { identity: ThreadIdentity }> {
    if (payload.threadId) {
      const opened = await this.open(user, payload.threadId);
      if (!opened) throw new ForbiddenException('Not your thread');
      // Writing — a message, a file, a voice note — needs more than reading:
      // an announcements-only group is read-only for its students, and a
      // switched-off group for everyone.
      if (!opened.v.canSend) {
        throw new ForbiddenException({
          message: 'Only staff can write in this conversation',
          code: 'READ_ONLY',
        });
      }
      return { threadId: payload.threadId, historyFrom: opened.v.historyFrom };
    }

    if (user.role === Role.GUARDIAN) return this.guardianTarget(user, payload);

    // New thread — the initiator picks the counterpart.
    if (user.role === Role.STUDENT) {
      const sid = await this.studentId(user.sub);
      if (!sid)
        throw new BadRequestException({
          message: 'No student profile',
          code: 'STUDENT_ACCOUNT_REQUIRED',
        });
      if (payload.team) return this.learnerToTeam(sid, payload.academyId, null, 'ACTIVE');
      if (payload.staffUserId) {
        return this.learnerToAssistant(sid, payload.academyId, payload.staffUserId, null);
      }
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
   * A guardian writing first — always about one child, in one academy, and
   * only through an ACTIVE link for exactly that pair. To the child's
   * teacher there, to an assistant the academy made reachable who covers the
   * child, or to the support team. The conversation is the guardian's own:
   * the child never sees it, and it never merges with the child's.
   */
  private async guardianTarget(
    user: JwtPayload,
    payload: ChatTarget,
  ): Promise<{ identity: ThreadIdentity }> {
    if (!payload.studentId || !payload.academyId) {
      throw new BadRequestException('studentId and academyId are required');
    }
    if (!(await this.guardianLinked(user.sub, payload.studentId, payload.academyId))) {
      throw new ForbiddenException({ message: 'Not your child here', code: 'NOT_LINKED' });
    }
    if (payload.team) {
      return this.learnerToTeam(payload.studentId, payload.academyId, user.sub, undefined);
    }
    if (payload.staffUserId) {
      return this.learnerToAssistant(
        payload.studentId,
        payload.academyId,
        payload.staffUserId,
        user.sub,
      );
    }
    if (!payload.tenantId) throw new BadRequestException('Who is this message for?');
    const enrolled = await this.prisma.enrollment.findFirst({
      where: {
        studentId: payload.studentId,
        tenantId: payload.tenantId,
        course: { academyId: payload.academyId },
      },
    });
    if (!enrolled) {
      throw new ForbiddenException({ message: 'Not this child’s teacher', code: 'NOT_TEACHER' });
    }
    const teacher = await this.openTeacher(
      payload.tenantId,
      'This teacher is not accepting messages',
    );
    return {
      identity: {
        academyId: payload.academyId,
        tenantId: payload.tenantId,
        studentId: payload.studentId,
        staffUserId: teacher.userId,
        guardianUserId: user.sub,
      },
    };
  }

  /**
   * "Ask Support Team": the academy's one TEAM conversation for this learner
   * side — the student's, or one guardian's. Opening it creates nothing; the
   * first send resolves the canonical row. The student needs an enrollment
   * in one of the academy's courses (ACTIVE for the student themselves).
   */
  private async learnerToTeam(
    studentId: string,
    academyId: string | undefined,
    guardianUserId: string | null,
    status: 'ACTIVE' | undefined,
  ): Promise<{ identity: ThreadIdentity }> {
    if (!academyId) throw new BadRequestException('academyId required to reach the support team');
    const enrollment = await this.prisma.enrollment.findFirst({
      where: {
        studentId,
        ...(status ? { status } : {}),
        course: { academyId, deletedAt: null },
      },
      orderBy: { createdAt: 'desc' },
      select: { course: { select: { tenantId: true } } },
    });
    if (!enrollment) {
      throw new ForbiddenException({
        message: 'You can only reach the support team of an academy you study with',
        code: 'NOT_ENROLLED',
      });
    }
    const tenantId = enrollment.course.tenantId;
    await this.openTeacher(tenantId, 'Messaging is switched off for this academy');
    return {
      identity: { academyId, tenantId, studentId, staffUserId: null, team: true, guardianUserId },
    };
  }

  /**
   * A learner (the student, or their guardian) starting a conversation with
   * an assistant: only one the academy made reachable (directContact), who
   * may still message, and whose courses the student is actively enrolled
   * in. Everything is checked against the assistant's membership as it is now.
   */
  private async learnerToAssistant(
    studentId: string,
    academyId: string | undefined,
    staffUserId: string,
    guardianUserId: string | null,
  ): Promise<{ identity: ThreadIdentity }> {
    const refuse = () =>
      new ForbiddenException({
        message: 'This person cannot be messaged directly',
        code: 'ASSISTANT_NOT_REACHABLE',
      });
    if (!academyId) throw new BadRequestException('academyId required to message an assistant');
    const member = await this.prisma.academyMembership.findFirst({
      where: {
        userId: staffUserId,
        academyId,
        role: 'ASSISTANT',
        status: 'ACTIVE',
        directContact: true,
      },
      select: { user: { select: { role: true } } },
    });
    if (!member) throw refuse();
    const scope = await this.scopes.resolve(staffUserId, academyId, member.user.role);
    if (!scope || !scope.ctx.can('message.reply')) throw refuse();
    const enrollment = await this.prisma.enrollment.findFirst({
      where: { studentId, status: 'ACTIVE', course: scope.courses },
      orderBy: { createdAt: 'desc' },
      select: { course: { select: { tenantId: true } } },
    });
    if (!enrollment) throw refuse();
    const tenantId = enrollment.course.tenantId;
    await this.openTeacher(tenantId, 'Messaging is switched off for this academy');
    return { identity: { academyId, tenantId, studentId, staffUserId, guardianUserId } };
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
   * Who a learner can start a conversation with. A student: each teacher they
   * are actively enrolled with (messaging open), each assistant the academy
   * made reachable who covers one of their courses, and each academy's
   * support team. A guardian: the same, per linked child and academy, each
   * contact carrying the child it is about. Leaving someone out is not the
   * gate — authorizeTarget refuses them too.
   */
  async contacts(user: JwtPayload): Promise<ChatContactDto[]> {
    if (user.role === Role.GUARDIAN) {
      const links = await this.prisma.guardianLink.findMany({
        where: { status: 'ACTIVE', guardian: { userId: user.sub } },
        select: {
          studentId: true,
          academyId: true,
          student: { select: { user: { select: { fullName: true } } } },
        },
      });
      const out: ChatContactDto[] = [];
      for (const l of links) {
        const forChild = await this.contactsFor(l.studentId, [l.academyId], undefined);
        out.push(
          ...forChild.map((c) => ({
            ...c,
            studentId: l.studentId,
            studentName: l.student.user.fullName,
          })),
        );
      }
      return out;
    }
    if (user.role !== Role.STUDENT) return [];
    const sid = await this.studentId(user.sub);
    if (!sid) return [];
    return this.contactsFor(sid, null, 'ACTIVE');
  }

  private async contactsFor(
    studentId: string,
    onlyAcademies: string[] | null,
    status: 'ACTIVE' | undefined,
  ): Promise<ChatContactDto[]> {
    const enrollments = await this.prisma.enrollment.findMany({
      where: {
        studentId,
        ...(status ? { status } : {}),
        ...(onlyAcademies ? { course: { academyId: { in: onlyAcademies } } } : {}),
      },
      select: { course: { select: { tenantId: true, academyId: true } } },
    });
    const tenantIds = [...new Set(enrollments.map((e) => e.course.tenantId))];
    const academyIds = [
      ...new Set(enrollments.map((e) => e.course.academyId).filter((x): x is string => !!x)),
    ];
    const [teachers, candidates, academies] = await Promise.all([
      this.prisma.teacherProfile.findMany({
        where: { id: { in: tenantIds }, acceptsStudentMessages: true },
        select: { id: true, user: { select: PERSON } },
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
          user: { select: { ...PERSON, role: true } },
        },
      }),
      this.prisma.academy.findMany({
        where: { id: { in: academyIds } },
        select: { id: true, name: true, logoUrl: true },
      }),
    ]);
    const academyName = (id: string) => academies.find((a) => a.id === id)?.name ?? null;
    const assistants = [];
    for (const m of candidates) {
      const scope = await this.scopes.resolve(m.userId, m.academyId, m.user.role);
      if (!scope || !scope.ctx.can('message.reply')) continue;
      const shares = await this.prisma.enrollment.count({
        where: { studentId, status: 'ACTIVE', course: scope.courses },
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
    // A teacher's own workspace is the academy whose id is their tenant id;
    // a Center teacher is reached in the Center their course belongs to.
    const teacherAcademy = (tenantId: string) =>
      enrollments.find((e) => e.course.tenantId === tenantId)?.course.academyId ?? tenantId;
    return [
      ...teachers.map((t) => ({
        kind: 'OWNER' as const,
        tenantId: t.id,
        academyId: teacherAcademy(t.id),
        academyName: academyName(teacherAcademy(t.id)),
        name: t.user.fullName,
        avatarUrl: avatarUrl(t.user),
        title: null,
      })),
      ...assistants,
      ...academies.map((a) => ({
        kind: 'TEAM' as const,
        academyId: a.id,
        academyName: a.name,
        name: a.name,
        avatarUrl: null,
        title: null,
      })),
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
    counterpartKind: ChatSenderKind | null;
    counterpartTitle: string | null;
    kind: 'DIRECT' | 'TEAM';
  }> {
    const target = await this.authorizeTarget(user, payload);
    if ('threadId' in target) throw new BadRequestException('Resolve a person, not a thread');
    const { identity } = target;
    const existing = await this.prisma.chatThread.findUnique({
      where: { dedupeKey: threadKey(identity) },
      select: { id: true, deletedAt: true },
    });
    const threadId = existing && !existing.deletedAt ? existing.id : null;
    if (identity.team) {
      const academy = await this.prisma.academy.findUnique({
        where: { id: identity.academyId },
        select: { name: true },
      });
      return {
        threadId,
        counterpartName: academy?.name ?? '',
        counterpartAvatarUrl: null,
        counterpartKind: null,
        counterpartTitle: null,
        kind: 'TEAM',
      };
    }
    const learner = isLearnerRole(user.role);
    const counterpart = learner
      ? await this.prisma.user.findUnique({ where: { id: identity.staffUserId! }, select: PERSON })
      : await this.prisma.studentProfile
          .findUnique({ where: { id: identity.studentId }, select: { user: { select: PERSON } } })
          .then((st) => st?.user ?? null);
    if (!counterpart) throw new NotFoundException('No one to message here');
    const toAssistant = learner && !!payload.staffUserId;
    return {
      threadId,
      counterpartName: counterpart.fullName,
      counterpartAvatarUrl: avatarUrl(counterpart),
      counterpartKind: !learner ? 'STUDENT' : toAssistant ? 'ASSISTANT' : 'OWNER',
      counterpartTitle: toAssistant
        ? await this.assistantTitle(this.prisma, identity.academyId, identity.staffUserId!)
        : null,
      kind: 'DIRECT',
    };
  }

  // ── The team inbox: claim, assign, resolve ────────────────────────────────

  /** A TEAM conversation the caller may work on, or a refusal that says nothing. */
  private async teamThreadFor(user: JwtPayload, threadId: string) {
    const p = await this.parties(threadId);
    if (!p || p.kind !== 'TEAM' || (await this.access(user, p)) !== 'staff') {
      throw new ForbiddenException('Not your conversation');
    }
    const oversee =
      user.role === Role.SUPER_ADMIN ||
      (await this.teamMayServe(user, p.academyId, p.studentId!, 'message.oversee'));
    return { p, oversee };
  }

  /** Tell everyone on the conversation that its assignment or state moved. */
  private async announce(p: ThreadParties) {
    for (const id of await this.participantIds(p)) {
      this.realtime.emitToUser(id, RealtimeEvents.THREAD_UPDATED, { threadId: p.id });
    }
  }

  /**
   * Take an unassigned conversation. Conditional on it still being
   * unassigned, so two people claiming at once cannot both win. Assigning
   * never changes who said what, and never creates a conversation.
   */
  async claim(user: JwtPayload, threadId: string) {
    const { p } = await this.teamThreadFor(user, threadId);
    const won = await this.prisma.chatThread.updateMany({
      where: { id: threadId, assigneeUserId: null },
      data: { assigneeUserId: user.sub },
    });
    if (!won.count && p.assigneeUserId !== user.sub) {
      throw new ConflictException({ message: 'Someone already has it', code: 'ALREADY_ASSIGNED' });
    }
    await this.announce(p);
    return this.getThread(user, threadId);
  }

  /**
   * Hand a conversation to someone (or to nobody). With message.oversee: to
   * anyone who may see it. Without: only your own — letting it go, or
   * passing one you hold. The new assignee must be able to see it now.
   */
  async assign(user: JwtPayload, threadId: string, assigneeUserId: string | null) {
    const { p, oversee } = await this.teamThreadFor(user, threadId);
    if (!oversee && p.assigneeUserId !== user.sub) {
      throw new ForbiddenException({
        message: 'Only its assignee or a supervisor can reassign this',
        code: 'CANNOT_ASSIGN',
      });
    }
    if (assigneeUserId) {
      const staff = await this.teamStaff(p.academyId, p.studentId!);
      if (!staff.includes(assigneeUserId)) {
        throw new BadRequestException({
          message: 'That person cannot see this conversation',
          code: 'ASSIGNEE_NOT_ELIGIBLE',
        });
      }
    }
    await this.prisma.chatThread.update({ where: { id: threadId }, data: { assigneeUserId } });
    await this.announce(p);
    return this.getThread(user, threadId);
  }

  /** Resolve: the assignee, anyone while it is unassigned, or a supervisor. */
  async resolve(user: JwtPayload, threadId: string, resolved: boolean) {
    const { p, oversee } = await this.teamThreadFor(user, threadId);
    if (!oversee && p.assigneeUserId && p.assigneeUserId !== user.sub) {
      throw new ForbiddenException({
        message: 'Only its assignee or a supervisor can change this',
        code: 'CANNOT_RESOLVE',
      });
    }
    await this.prisma.chatThread.update({
      where: { id: threadId },
      data: resolved
        ? { resolvedAt: new Date(), resolvedById: user.sub }
        : { resolvedAt: null, resolvedById: null },
    });
    await this.announce(p);
    return this.getThread(user, threadId);
  }

  /** Who this conversation could be handed to: the staff who may see it. */
  async assignees(user: JwtPayload, threadId: string) {
    const { p } = await this.teamThreadFor(user, threadId);
    const ids = await this.teamStaff(p.academyId, p.studentId!);
    const people = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: {
        ...PERSON,
        academyMemberships: {
          where: { academyId: p.academyId ?? '', status: 'ACTIVE' },
          select: { role: true, title: true },
        },
      },
    });
    return people.map((u) => ({
      id: u.id,
      name: u.fullName,
      avatarUrl: avatarUrl(u),
      role: u.academyMemberships[0]?.role ?? null,
      title: u.academyMemberships[0]?.title ?? null,
    }));
  }

  /**
   * What staff see beside a conversation: the student, the academy, the
   * student's courses that are inside the viewer's scope (never the rest),
   * the guardian when a guardian is the one writing, and what the viewer may
   * do with the conversation. No wallet, nothing platform-wide.
   */
  async context(user: JwtPayload, threadId: string) {
    const p = await this.parties(threadId);
    // A group has its own info panel (groupInfo); this is about one student.
    if (!p || p.kind === 'GROUP' || (await this.access(user, p)) !== 'staff') {
      throw new ForbiddenException('Not your conversation');
    }
    const scope =
      p.academyId && user.role !== Role.SUPER_ADMIN
        ? await this.scopes.resolve(user.sub, p.academyId, user.role)
        : null;
    const [student, academy, enrollments, guardianLink, guardians, assignee] = await Promise.all([
      this.prisma.studentProfile.findUnique({
        where: { id: p.studentId! },
        select: { id: true, user: { select: PERSON } },
      }),
      p.academyId
        ? this.prisma.academy.findUnique({
            where: { id: p.academyId },
            select: { id: true, name: true },
          })
        : null,
      this.prisma.enrollment.findMany({
        where: {
          studentId: p.studentId!,
          course: scope ? scope.courses : { academyId: p.academyId ?? '__none__' },
        },
        select: { status: true, course: { select: { id: true, title: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      p.guardianUserId
        ? this.prisma.guardianLink.findFirst({
            where: {
              studentId: p.studentId!,
              academyId: p.academyId ?? '',
              guardian: { userId: p.guardianUserId },
            },
            select: {
              relationship: true,
              guardian: { select: { user: { select: { fullName: true } } } },
            },
          })
        : null,
      this.prisma.guardianLink.count({
        where: { studentId: p.studentId!, academyId: p.academyId ?? '', status: 'ACTIVE' },
      }),
      p.assigneeUserId
        ? this.prisma.user.findUnique({
            where: { id: p.assigneeUserId },
            select: { id: true, fullName: true },
          })
        : null,
    ]);
    const oversee = user.role === Role.SUPER_ADMIN || !!scope?.ctx.can('message.oversee');
    const team = p.kind === 'TEAM';
    return {
      student: {
        id: student!.id,
        name: student!.user.fullName,
        avatarUrl: avatarUrl(student!.user),
      },
      academy,
      courses: enrollments.map((e) => ({
        id: e.course.id,
        title: e.course.title,
        status: e.status,
      })),
      guardian: guardianLink
        ? { name: guardianLink.guardian.user.fullName, relationship: guardianLink.relationship }
        : null,
      guardians,
      canManageGuardians: !!scope?.ctx.can('guardian.manage'),
      kind: p.kind,
      assignee: assignee ? { id: assignee.id, name: assignee.fullName } : null,
      resolvedAt: p.resolvedAt?.toISOString() ?? null,
      can: {
        claim: team && !p.assigneeUserId,
        assign: team && (oversee || p.assigneeUserId === user.sub),
        resolve: team && (oversee || !p.assigneeUserId || p.assigneeUserId === user.sub),
      },
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
    historyFrom: Date | null = null,
  ): Promise<string | null> {
    if (!replyToId) return null;
    const target = await db.chatMessage.findFirst({
      where: {
        id: replyToId,
        threadId,
        revokedAt: null,
        ...(historyFrom ? { createdAt: { gte: historyFrom } } : {}),
      },
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
    const auth = await this.authorizeTarget(user, { threadId });
    if (!VOICE_MIME.test(file.mimetype)) {
      throw new BadRequestException({ message: 'Unsupported audio format', code: 'VOICE_FORMAT' });
    }
    if (file.buffer.length > VOICE_MAX_BYTES) {
      throw new BadRequestException({ message: 'Voice note is too long', code: 'VOICE_TOO_LONG' });
    }
    const seconds = Math.min(VOICE_MAX_SECONDS, Math.max(1, Math.round(durationSec || 0)));

    const parties = (await this.parties(threadId))!;
    const replyTo = await this.replyTarget(
      threadId,
      replyToId,
      this.prisma,
      'historyFrom' in auth ? (auth.historyFrom ?? null) : null,
    );
    const sender = await this.senderOf(user, parties);
    const message = await this.prisma.chatMessage.create({
      data: {
        threadId,
        senderId: user.sub,
        senderKind: sender.kind,
        senderTitle: sender.title,
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
        params: { max: MAX_ATTACHMENTS_PER_MESSAGE },
      });
    }
    if (!body && !attachmentIds.length)
      throw new BadRequestException({ message: 'Empty message', code: 'EMPTY_MESSAGE' });
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
        const replyToId = await this.replyTarget(
          threadId,
          payload.replyToId,
          tx,
          'historyFrom' in target ? (target.historyFrom ?? null) : null,
        );
        // Only a lesson that exists, so a bad id becomes a plain message rather
        // than a chip pointing at nothing.
        const lesson = payload.lessonId
          ? await tx.lesson.findUnique({ where: { id: payload.lessonId }, select: { id: true } })
          : null;

        // Who they are here — frozen onto what they said, so a later change of
        // title (or of role) does not rewrite who said it as what.
        const sender = await this.senderOf(user, parties, tx);
        const created = await tx.chatMessage.create({
          data: {
            threadId,
            senderId: user.sub,
            senderKind: sender.kind,
            senderTitle: sender.title,
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
              params: { max: MAX_ATTACHMENTS_PER_MESSAGE },
            });
          }
        }
        const message = await tx.chatMessage.findUniqueOrThrow({
          where: { id: created.id },
          include: MESSAGE_INCLUDE,
        });
        await this.touchLastMessage(tx, threadId, message);
        // A resolved TEAM conversation reopens when the learner side writes
        // again — same conversation, same assignee.
        if (parties.kind === 'TEAM' && parties.resolvedAt && user.sub === parties.learnerUserId) {
          await tx.chatThread.update({
            where: { id: threadId },
            data: { resolvedAt: null, resolvedById: null },
          });
          parties.resolvedAt = null;
        }
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
   * May this user act on this message (react, hide, delete their own): they
   * can read its conversation, and it is inside what they are allowed to
   * read — a message from before a student joined a group is not theirs to
   * touch any more than to see.
   */
  async mayTouch(user: JwtPayload, m: { threadId: string; createdAt: Date }): Promise<boolean> {
    const opened = await this.open(user, m.threadId);
    if (!opened) return false;
    return !opened.v.historyFrom || m.createdAt >= opened.v.historyFrom;
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
      select: { id: true, threadId: true, senderId: true, revokedAt: true, createdAt: true },
    });
    if (!m || !(await this.mayTouch(user, m))) {
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
    for (const id of await this.participantIds(parties)) {
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
      select: { id: true, threadId: true, createdAt: true },
    });
    if (!m || !(await this.mayTouch(user, m))) {
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
   * notify the people it is for.
   *
   * Who is notified follows who the conversation is waiting on. DIRECT:
   * everyone but the sender. TEAM, written by the learner side: its assignee,
   * or — while nobody has it — every staff member who may see it (each in
   * their own inbox; it is still one conversation). TEAM, written by staff:
   * the learner; teammates see the list move but are not pinged. One unread
   * notification per conversation per person, updated as messages arrive,
   * rather than one per message.
   */
  private async fanOut(message: any, parties: ThreadParties, senderUserId: string) {
    const preview = previewOf(message);
    const recipients = await this.participantIds(parties);
    let notify = recipients.filter((id) => id !== senderUserId);
    if (parties.kind === 'TEAM') {
      if (senderUserId === parties.learnerUserId) {
        if (parties.assigneeUserId && recipients.includes(parties.assigneeUserId)) {
          notify = [parties.assigneeUserId];
        }
      } else {
        notify = parties.learnerUserId ? [parties.learnerUserId] : [];
      }
    }
    let title = `رسالة جديدة من ${message.sender.fullName}`;
    if (parties.kind === 'GROUP') {
      // A class chat names the class and who spoke in it.
      const group = parties.groupId
        ? await this.prisma.group.findUnique({
            where: { id: parties.groupId },
            select: { name: true },
          })
        : null;
      title = `${group?.name ?? ''} · ${message.sender.fullName}`;
    } else if (parties.guardianUserId || parties.kind === 'TEAM') {
      const student = parties.studentId
        ? await this.prisma.studentProfile.findUnique({
            where: { id: parties.studentId },
            select: { user: { select: { fullName: true } } },
          })
        : null;
      if (parties.guardianUserId && senderUserId === parties.learnerUserId) {
        title += ` (ولي أمر ${student?.user.fullName ?? ''})`;
      }
      if (parties.kind === 'TEAM') title += ' · فريق الدعم';
    }
    for (const userId of recipients) {
      this.realtime.emitToUser(userId, RealtimeEvents.MESSAGE, toMessageDto(message, userId));
      if (userId === senderUserId) continue;
      this.realtime.emitToUser(userId, RealtimeEvents.THREAD_UPDATED, { threadId: parties.id });
    }
    for (const userId of notify) {
      await this.notifications.upsertForThread({
        userId,
        type: 'CHAT_MESSAGE',
        title,
        body: preview,
        threadId: parties.id,
      });
    }
  }
}
