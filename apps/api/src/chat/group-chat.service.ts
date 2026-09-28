import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { GroupChatInfoDto, JwtPayload, RealtimeEvents, Role } from '@darsly/shared-types';
import { AcademyContext } from '../academy/academy-context';
import { AcademyOpsAccessService } from '../academy-ops/academy-ops-access.service';
import { avatarUrl } from '../common/signed-link';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { newThreadId } from './chat-thread.identity';
import { ConversationPolicy } from './conversation-policy';

/** The one chat of a group, derived on the server: `<academy>|GROUP:<group>`. */
export const groupChatKey = (academyId: string, groupId: string) => `${academyId}|GROUP:${groupId}`;

/**
 * A class group's chat. The Group — its members, its assigned staff — stays
 * the only source of truth: the chat keeps no member list of its own. This
 * service switches a group's chat on and off and sets its mode; who may read
 * and write in it is ConversationPolicy's to decide on every request.
 */
@Injectable()
export class GroupChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AcademyOpsAccessService,
    private readonly policy: ConversationPolicy,
    private readonly realtime: RealtimeService,
  ) {}

  /** The chat's state for the group screen. */
  async status(ctx: AcademyContext, groupId: string) {
    await this.access.assertGroupAccess(ctx, groupId);
    const t = await this.prisma.chatThread.findUnique({
      where: { dedupeKey: groupChatKey(ctx.academyId, groupId) },
      select: { id: true, groupMode: true, archivedAt: true },
    });
    return {
      threadId: t && !t.archivedAt ? t.id : null,
      enabled: !!t && !t.archivedAt,
      mode: t?.groupMode ?? 'OPEN',
    };
  }

  /**
   * Switch the group's chat on — creating its one conversation the first
   * time, reviving it (history intact) afterwards. INSERT … ON CONFLICT on the
   * derived key, so two managers pressing at once get the same conversation;
   * a partial unique index on (groupId) WHERE kind = 'GROUP' holds the rule
   * in the database too.
   */
  async enable(ctx: AcademyContext, groupId: string) {
    const group = await this.access.assertGroupAccess(ctx, groupId);
    if (group.status !== 'ACTIVE') {
      throw new BadRequestException({ message: 'This group is archived', code: 'GROUP_ARCHIVED' });
    }
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "ChatThread"
        ("id", "type", "kind", "academyId", "groupId", "groupMode", "dedupeKey",
         "lastMessageAt", "createdAt", "updatedAt")
      VALUES
        (${newThreadId()}, 'DM'::"ChatThreadType", 'GROUP'::"ChatThreadKind", ${ctx.academyId},
         ${groupId}, 'OPEN'::"GroupChatMode", ${groupChatKey(ctx.academyId, groupId)},
         now(), now(), now())
      ON CONFLICT ("dedupeKey") DO UPDATE SET "archivedAt" = NULL, "updatedAt" = now()
      RETURNING "id"`;
    await this.announce(rows[0].id);
    return this.status(ctx, groupId);
  }

  /** Switch the chat off (the group and the history are untouched), or change its mode. */
  async update(
    ctx: AcademyContext,
    groupId: string,
    change: { enabled?: boolean; mode?: 'OPEN' | 'ANNOUNCEMENTS' },
  ) {
    await this.access.assertGroupAccess(ctx, groupId);
    const t = await this.prisma.chatThread.findUnique({
      where: { dedupeKey: groupChatKey(ctx.academyId, groupId) },
      select: { id: true },
    });
    if (!t)
      throw new NotFoundException({ message: 'This group has no chat yet', code: 'NO_GROUP_CHAT' });
    if (change.enabled === true) return this.enable(ctx, groupId);
    await this.prisma.chatThread.update({
      where: { id: t.id },
      data: {
        ...(change.enabled === false ? { archivedAt: new Date() } : {}),
        ...(change.mode ? { groupMode: change.mode } : {}),
      },
    });
    await this.announce(t.id, true);
    return this.status(ctx, groupId);
  }

  /**
   * The group's info panel, for anyone in the chat: who teaches and helps in
   * it, how many students — and, for staff only, which students. Management
   * controls are offered only to someone the policy lets manage it.
   */
  async info(user: JwtPayload, threadId: string): Promise<GroupChatInfoDto> {
    const p = await this.policy.parties(threadId);
    if (!p || p.kind !== 'GROUP' || !p.groupId || !p.academyId)
      throw new ForbiddenException('Not yours');
    const v = await this.policy.viewer(user, p);
    if (!v) throw new ForbiddenException('Not yours');
    const [group, academy, members, staffIds] = await Promise.all([
      this.prisma.group.findUnique({ where: { id: p.groupId }, select: { name: true } }),
      this.prisma.academy.findUnique({ where: { id: p.academyId }, select: { name: true } }),
      this.prisma.groupMembership.findMany({
        where: { groupId: p.groupId },
        orderBy: { addedAt: 'asc' },
        select: {
          student: {
            select: {
              id: true,
              user: { select: { id: true, fullName: true, avatarUrl: true, updatedAt: true } },
            },
          },
        },
      }),
      this.policy.groupStaff(p.academyId, p.groupId),
    ]);
    const staffUsers = await this.prisma.user.findMany({
      where: { id: { in: staffIds } },
      select: {
        id: true,
        fullName: true,
        avatarUrl: true,
        updatedAt: true,
        academyMemberships: {
          where: { academyId: p.academyId, status: 'ACTIVE' },
          select: { role: true, title: true },
        },
      },
    });
    const kindOf = (role?: string) =>
      role === 'OWNER' ? 'OWNER' : role === 'ASSISTANT' ? 'ASSISTANT' : 'TEACHER';
    return {
      threadId: p.id,
      groupId: p.groupId,
      name: group?.name ?? '',
      academyName: academy?.name ?? null,
      enabled: !p.archivedAt,
      mode: p.groupMode ?? 'OPEN',
      memberCount: members.length,
      staff: staffUsers.map((u) => ({
        id: u.id,
        name: u.fullName,
        avatarUrl: avatarUrl(u),
        kind: kindOf(u.academyMemberships[0]?.role) as any,
        title: u.academyMemberships[0]?.title ?? null,
      })),
      students:
        v.side === 'staff' || user.role === Role.SUPER_ADMIN
          ? members.map((m) => ({
              id: m.student.id,
              name: m.student.user.fullName,
              avatarUrl: avatarUrl(m.student.user),
            }))
          : null,
      can: { send: v.canSend, manage: v.canManage },
    };
  }

  /** Change the mode from inside the chat — for someone the policy lets manage it. */
  async setModeFromChat(user: JwtPayload, threadId: string, mode: 'OPEN' | 'ANNOUNCEMENTS') {
    const p = await this.policy.parties(threadId);
    if (!p || p.kind !== 'GROUP') throw new ForbiddenException('Not yours');
    const v = await this.policy.viewer(user, p);
    if (!v?.canManage) {
      throw new ForbiddenException({
        message: 'Only the group’s managers can change this',
        code: 'CANNOT_MANAGE',
      });
    }
    await this.prisma.chatThread.update({ where: { id: threadId }, data: { groupMode: mode } });
    await this.announce(threadId, true);
    return this.info(user, threadId);
  }

  /** Tell everyone in the chat (and, when it was just switched off, those who were) that it changed. */
  private async announce(threadId: string, includeStudents = false) {
    const p = await this.policy.parties(threadId);
    if (!p) return;
    const ids = new Set(await this.policy.recipients(p));
    if (includeStudents && p.groupId)
      for (const id of await this.policy.groupStudents(p.groupId)) ids.add(id);
    for (const id of ids) this.realtime.emitToUser(id, RealtimeEvents.THREAD_UPDATED, { threadId });
  }
}
