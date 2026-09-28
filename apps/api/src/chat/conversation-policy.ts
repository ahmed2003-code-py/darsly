import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ChatSenderKind, JwtPayload, Role } from '@darsly/shared-types';
import { StaffScopeService } from '../academy/staff-scope.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Who is in a conversation, as every read and every fan-out needs it.
 *
 *  - DIRECT: one learner-side party (a student, or one of their guardians)
 *    and one named staff member.
 *  - TEAM: one learner-side party and the academy's support team.
 *  - GROUP: the chat of an existing Group — its active students and the
 *    staff allowed into it. There is no learner-side party and no student.
 */
export interface ThreadParties {
  id: string;
  kind: 'DIRECT' | 'TEAM' | 'GROUP';
  tenantId: string | null;
  academyId: string | null;
  studentId: string | null;
  dedupeKey: string;
  studentUserId: string | null;
  guardianUserId: string | null;
  /** Whoever speaks for the learner side (DIRECT/TEAM); null for GROUP. */
  learnerUserId: string | null;
  /** DIRECT only: the staff member, and whether they are the teacher or an assistant. */
  staffUserId: string | null;
  staffKind: 'OWNER' | 'ASSISTANT' | null;
  assigneeUserId: string | null;
  resolvedAt: Date | null;
  groupId: string | null;
  groupMode: 'OPEN' | 'ANNOUNCEMENTS' | null;
  archivedAt: Date | null;
  clearedForTeacherAt: Date | null;
  clearedForStudentAt: Date | null;
}

/**
 * What one person may do in one conversation, right now.
 *
 *  - `side`: learner (the student or guardian of a DIRECT/TEAM conversation),
 *    member (a student of a GROUP), or staff.
 *  - `canSend`: write, reply, attach, record — false in an announcements-only
 *    group for students, and in a switched-off group for everyone.
 *  - `canManage`: TEAM — reassign/resolve anyone's (message.oversee); GROUP —
 *    switch the chat on/off and change its mode (group.manage on this group).
 *  - `historyFrom`: nothing said before this is theirs to read (a student
 *    added to a group sees from the moment they joined).
 */
export interface Viewer {
  side: 'learner' | 'member' | 'staff';
  canSend: boolean;
  canManage: boolean;
  historyFrom: Date | null;
}

export const isLearnerRole = (role: string) => role === Role.STUDENT || role === Role.GUARDIAN;

/**
 * The one place that decides who may see, write in, and be told about a
 * conversation — for every kind of conversation.
 *
 * Everything is read from the database on every call: a guardian link
 * revoked, a course taken off an assistant, a student removed from a group
 * or a capability lost all take effect on the next request, whatever URL,
 * API call or socket it arrives through. Services ask here; they do not
 * branch on conversation kind themselves.
 */
@Injectable()
export class ConversationPolicy {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: StaffScopeService,
  ) {}

  /** The conversation's participants, or null when it does not exist. */
  async parties(
    threadId: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<ThreadParties | null> {
    const t = await db.chatThread.findUnique({
      where: { id: threadId },
      select: {
        id: true,
        kind: true,
        tenantId: true,
        academyId: true,
        studentId: true,
        dedupeKey: true,
        staffUserId: true,
        guardianUserId: true,
        assigneeUserId: true,
        resolvedAt: true,
        groupId: true,
        groupMode: true,
        archivedAt: true,
        clearedForTeacherAt: true,
        clearedForStudentAt: true,
        student: { select: { userId: true } },
        teacher: { select: { userId: true } },
      },
    });
    if (!t) return null;
    const direct = t.kind === 'DIRECT';
    const staffUserId = direct ? (t.staffUserId ?? t.teacher?.userId ?? null) : null;
    const studentUserId = t.student?.userId ?? null;
    return {
      id: t.id,
      kind: t.kind,
      tenantId: t.tenantId,
      academyId: t.academyId,
      studentId: t.studentId,
      dedupeKey: t.dedupeKey,
      studentUserId,
      guardianUserId: t.guardianUserId,
      learnerUserId: t.kind === 'GROUP' ? null : (t.guardianUserId ?? studentUserId),
      staffUserId,
      staffKind: direct ? (staffUserId === t.teacher?.userId ? 'OWNER' : 'ASSISTANT') : null,
      assigneeUserId: t.assigneeUserId,
      resolvedAt: t.resolvedAt,
      groupId: t.groupId,
      groupMode: t.groupMode,
      archivedAt: t.archivedAt,
      clearedForTeacherAt: t.clearedForTeacherAt,
      clearedForStudentAt: t.clearedForStudentAt,
    };
  }

  /** What this user may do in this conversation — or null: not theirs. */
  async viewer(user: JwtPayload, p: ThreadParties): Promise<Viewer | null> {
    const open = (side: Viewer['side'], extra: Partial<Viewer> = {}): Viewer => ({
      side,
      canSend: true,
      canManage: false,
      historyFrom: null,
      ...extra,
    });
    if (user.role === Role.SUPER_ADMIN) {
      return open('staff', { canSend: !p.archivedAt, canManage: true });
    }
    if (p.kind === 'GROUP') return this.groupViewer(user, p);

    // DIRECT / TEAM: the learner side first.
    if (p.guardianUserId) {
      if (user.sub === p.guardianUserId && user.role === Role.GUARDIAN) {
        return (await this.guardianLinked(user.sub, p.studentId!, p.academyId))
          ? open('learner')
          : null;
      }
    } else if (user.sub === p.studentUserId && user.role === Role.STUDENT) {
      return open('learner');
    }
    if (isLearnerRole(user.role)) return null;

    if (p.kind === 'TEAM') {
      const scope = await this.scopeWithStudent(user, p.academyId, p.studentId!);
      if (!scope?.ctx.can('message.inbox')) return null;
      return open('staff', { canManage: scope.ctx.can('message.oversee') });
    }
    if (p.staffUserId !== user.sub) return null;
    if (p.staffKind === 'OWNER') {
      // `!!user.tenantId`: `undefined === undefined` must never grant.
      return user.role === Role.TEACHER && !!user.tenantId && p.tenantId === user.tenantId
        ? open('staff')
        : null;
    }
    return (await this.assistantMayServe(user, p.academyId, p.studentId!)) ? open('staff') : null;
  }

  /**
   * GROUP: an active student of the Group reads from the moment they joined
   * and writes while the chat is OPEN; staff come in through message.group on
   * a group that is theirs — the owner's every group, anyone else's only
   * groups they are assigned to (the Group's own scope, GroupAssignment).
   * A switched-off chat is closed to students and read-only for staff.
   */
  private async groupViewer(user: JwtPayload, p: ThreadParties): Promise<Viewer | null> {
    if (!p.groupId || !p.academyId) return null;
    const group = await this.prisma.group.findFirst({
      where: { id: p.groupId, academyId: p.academyId },
      select: { status: true },
    });
    if (!group) return null;
    if (user.role === Role.STUDENT) {
      if (p.archivedAt || group.status !== 'ACTIVE') return null;
      const membership = await this.prisma.groupMembership.findFirst({
        where: { groupId: p.groupId, student: { userId: user.sub } },
        select: { addedAt: true },
      });
      if (!membership) return null;
      return {
        side: 'member',
        canSend: p.groupMode !== 'ANNOUNCEMENTS',
        canManage: false,
        historyFrom: membership.addedAt,
      };
    }
    if (isLearnerRole(user.role)) return null;
    const staff = await this.groupStaffAccess(user, p.academyId, p.groupId);
    if (!staff) return null;
    return { side: 'staff', canSend: !p.archivedAt, canManage: staff.manage, historyFrom: null };
  }

  /** A staff member's standing in a group's chat: in or out, and whether they manage it. */
  async groupStaffAccess(
    user: Pick<JwtPayload, 'sub' | 'role'>,
    academyId: string,
    groupId: string,
  ): Promise<{ manage: boolean } | null> {
    const scope = await this.scopes.resolve(user.sub, academyId, user.role);
    const ctx = scope?.ctx;
    if (!ctx || !ctx.can('message.group')) return null;
    if (ctx.role !== 'OWNER' && !ctx.isPlatformAdmin) {
      const assigned = await this.prisma.groupAssignment.findFirst({
        where: { groupId, userId: user.sub },
        select: { id: true },
      });
      if (!assigned) return null;
    }
    return { manage: ctx.can('group.manage') };
  }

  /** An ACTIVE link between this guardian and this student, in this academy. */
  async guardianLinked(guardianUserId: string, studentId: string, academyId: string | null) {
    if (!academyId) return false;
    const n = await this.prisma.guardianLink.count({
      where: { status: 'ACTIVE', studentId, academyId, guardian: { userId: guardianUserId } },
    });
    return n > 0;
  }

  /** A live staff membership in this academy whose scope includes this student. */
  private async scopeWithStudent(
    user: Pick<JwtPayload, 'sub' | 'role'>,
    academyId: string | null,
    studentId: string,
  ) {
    if (!academyId) return null;
    const scope = await this.scopes.resolve(user.sub, academyId, user.role);
    if (!scope || !(await this.scopes.hasStudent(scope, studentId))) return null;
    return scope;
  }

  /** May this staff member talk with this student directly (message.reply + scope). */
  async assistantMayServe(
    user: Pick<JwtPayload, 'sub' | 'role'>,
    academyId: string | null,
    studentId: string,
  ): Promise<boolean> {
    const scope = await this.scopeWithStudent(user, academyId, studentId);
    return !!scope?.ctx.can('message.reply');
  }

  /** May this staff member work this student's TEAM conversations (or oversee them). */
  async teamMayServe(
    user: Pick<JwtPayload, 'sub' | 'role'>,
    academyId: string | null,
    studentId: string,
    cap: 'message.inbox' | 'message.oversee' = 'message.inbox',
  ): Promise<boolean> {
    const scope = await this.scopeWithStudent(user, academyId, studentId);
    return !!scope?.ctx.can(cap);
  }

  /** The academy's active staff, with their account role (for scope resolution). */
  private staffOf(academyId: string) {
    return this.prisma.academyMembership.findMany({
      where: { academyId, status: 'ACTIVE', role: { in: ['OWNER', 'TEACHER', 'ASSISTANT'] } },
      select: { userId: true, user: { select: { role: true } } },
    });
  }

  /** Staff who may see this student's TEAM conversations — computed, never "everyone". */
  async teamStaff(academyId: string | null, studentId: string): Promise<string[]> {
    if (!academyId) return [];
    const out: string[] = [];
    for (const m of await this.staffOf(academyId)) {
      const who = { sub: m.userId, role: m.user.role as Role };
      if (await this.teamMayServe(who, academyId, studentId)) out.push(m.userId);
    }
    return out;
  }

  /** Staff who may be in this group's chat right now. */
  async groupStaff(academyId: string, groupId: string): Promise<string[]> {
    const out: string[] = [];
    for (const m of await this.staffOf(academyId)) {
      const who = { sub: m.userId, role: m.user.role as Role };
      if (await this.groupStaffAccess(who, academyId, groupId)) out.push(m.userId);
    }
    return out;
  }

  /** The group's active students' user ids. */
  async groupStudents(groupId: string): Promise<string[]> {
    const members = await this.prisma.groupMembership.findMany({
      where: { groupId },
      select: { student: { select: { userId: true } } },
    });
    return members.map((m) => m.student.userId);
  }

  /**
   * Everyone who receives this conversation's live events now: DIRECT — the
   * learner and the staff member; TEAM — the learner and the staff who may
   * see it; GROUP — its active students (unless switched off) and its staff.
   */
  async recipients(p: ThreadParties): Promise<string[]> {
    let ids: (string | null)[];
    if (p.kind === 'GROUP') {
      if (!p.groupId || !p.academyId) return [];
      const [students, staff] = await Promise.all([
        p.archivedAt ? Promise.resolve([] as string[]) : this.groupStudents(p.groupId),
        this.groupStaff(p.academyId, p.groupId),
      ]);
      ids = [...students, ...staff];
    } else if (p.kind === 'TEAM') {
      ids = [p.learnerUserId, ...(await this.teamStaff(p.academyId, p.studentId!))];
    } else {
      ids = [p.learnerUserId, p.staffUserId];
    }
    return [...new Set(ids.filter((x): x is string => !!x))];
  }

  /**
   * Who the sender is in THIS conversation, frozen onto the message: kind and
   * title come from the conversation and the sender's membership, never from
   * the request. A team or group reply is by a person ("Ahmed · Student
   * Support"), never by "the academy" or "the group".
   */
  async senderOf(
    user: JwtPayload,
    p: ThreadParties,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<{ kind: ChatSenderKind; title: string | null }> {
    if (p.learnerUserId && user.sub === p.learnerUserId) {
      if (!p.guardianUserId) return { kind: 'STUDENT', title: null };
      const link = await db.guardianLink.findFirst({
        where: {
          studentId: p.studentId!,
          academyId: p.academyId ?? '',
          guardian: { userId: user.sub },
        },
        select: { relationship: true },
      });
      return { kind: 'GUARDIAN', title: link?.relationship ?? null };
    }
    if (user.role === Role.STUDENT) return { kind: 'STUDENT', title: null };
    if (user.role === Role.SUPER_ADMIN) return { kind: 'ADMIN', title: null };
    if (p.kind === 'DIRECT' && user.sub === p.staffUserId && p.staffKind === 'OWNER') {
      return { kind: 'OWNER', title: null };
    }
    const m = p.academyId
      ? await db.academyMembership.findFirst({
          where: { academyId: p.academyId, userId: user.sub, status: 'ACTIVE' },
          select: { role: true, title: true },
        })
      : null;
    if (m?.role === 'ASSISTANT') return { kind: 'ASSISTANT', title: m.title ?? null };
    if (m?.role === 'OWNER') return { kind: 'OWNER', title: null };
    return { kind: 'TEACHER', title: null };
  }
}
