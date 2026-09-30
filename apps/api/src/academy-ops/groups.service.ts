import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { GroupAssignmentRole, Prisma } from '@prisma/client';
import { AcademyContext } from '../academy/academy-context';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { asPage } from '../common/pagination';
import { AcademyOpsAccessService } from './academy-ops-access.service';
import {
  AddGroupMembersDto,
  AssignStaffDto,
  CreateGroupDto,
  UpdateGroupDto,
} from './dto/academy-ops.dto';

const MAX_PAGE_SIZE = 100;

@Injectable()
export class GroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AcademyOpsAccessService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Every group in the academy an OWNER sees; a TEACHER/ASSISTANT sees only
   *  the ones they're assigned to. */
  async list(ctx: AcademyContext, query: { page?: number; pageSize?: number }) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? 20));

    const where: Prisma.GroupWhereInput = {
      academyId: ctx.academyId,
      deletedAt: null,
      ...(ctx.role === 'OWNER'
        ? {}
        : { assignments: { some: { userId: ctx.userId, deletedAt: null } } }),
    };

    const [total, groups] = await Promise.all([
      this.prisma.group.count({ where }),
      this.prisma.group.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          name: true,
          description: true,
          status: true,
          createdAt: true,
          capacity: true,
          _count: { select: { members: { where: { deletedAt: null } } } },
        },
      }),
    ]);

    const ids = groups.map((g) => g.id);
    const assignmentRows = ids.length
      ? await this.prisma.groupAssignment.findMany({
          where: { groupId: { in: ids }, deletedAt: null },
          select: { groupId: true, role: true, user: { select: { fullName: true } } },
        })
      : [];
    const byGroup = new Map<string, { role: string; name: string }[]>();
    for (const a of assignmentRows) {
      const list = byGroup.get(a.groupId) ?? [];
      list.push({ role: a.role, name: a.user.fullName });
      byGroup.set(a.groupId, list);
    }

    const items = groups.map((g) => ({
      id: g.id,
      name: g.name,
      description: g.description,
      status: g.status,
      createdAt: g.createdAt,
      studentsCount: g._count.members,
      capacity: g.capacity,
      staff: byGroup.get(g.id) ?? [],
    }));
    // `groups` is the same array under its original name. It is the one key in
    // the API that calls the list something other than `items`, which is the
    // whole of why a client written against courses could not read this. Both
    // are returned so nothing has to change at once; `groups` is deprecated.
    return { ...asPage(items, total, page, pageSize), groups: items };
  }

  /**
   * A group its creator can actually use.
   *
   * Holding `group.manage` means "I may manage the groups I'm assigned to"
   * (see AcademyOpsAccessService), so a TEACHER/ASSISTANT who created a group
   * without also being assigned to it owned nothing: `list` filtered it out of
   * their own screen and every follow-up call — add students, take attendance
   * — came back "You are not assigned to this group". They then pressed create
   * again, because from where they sat nothing had happened, and the academy
   * quietly collected twins. The assignment is part of creating, in the same
   * transaction: whoever made the group is on it, or the group does not exist.
   *
   * An OWNER acts academy-wide already, so they get no assignment row — one
   * would claim they personally teach every group they ever set up.
   */
  async create(ctx: AcademyContext, dto: CreateGroupDto) {
    const name = dto.name.trim();
    // The same refusal a second press would have earned had the first one been
    // visible. Scoped to live groups, so a name is reusable after archiving.
    const clash = await this.prisma.group.findFirst({
      where: {
        academyId: ctx.academyId,
        deletedAt: null,
        status: 'ACTIVE',
        name: { equals: name, mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictException({
        message: 'A group with this name already exists',
        code: 'GROUP_NAME_TAKEN',
        groupId: clash.id,
      });
    }

    const config = await this.classConfig(ctx.academyId, dto);
    const group = await this.prisma.$transaction(async (tx) => {
      const created = await tx.group.create({
        data: { academyId: ctx.academyId, name, description: dto.description, ...config },
      });
      if (ctx.role === 'TEACHER' || ctx.role === 'ASSISTANT') {
        await tx.groupAssignment.create({
          data: {
            groupId: created.id,
            userId: ctx.userId,
            academyId: ctx.academyId,
            role:
              ctx.role === 'ASSISTANT'
                ? GroupAssignmentRole.ASSISTANT
                : GroupAssignmentRole.TEACHER,
          },
        });
      }
      return created;
    });

    await this.audit.log({
      actorUserId: ctx.userId,
      action: 'group.create',
      entity: 'Group',
      entityId: group.id,
      academyId: ctx.academyId,
      meta: { selfAssigned: ctx.role === 'TEACHER' || ctx.role === 'ASSISTANT' },
    });
    return group;
  }

  async detail(ctx: AcademyContext, groupId: string) {
    await this.access.assertGroupAccess(ctx, groupId);
    const [group, members, assignments] = await Promise.all([
      this.prisma.group.findUniqueOrThrow({
        where: { id: groupId },
        include: {
          subject: { select: { id: true, nameAr: true, nameEn: true } },
          grade: { select: { id: true, nameAr: true, nameEn: true } },
        },
      }),
      this.prisma.groupMembership.findMany({
        where: { groupId, deletedAt: null },
        orderBy: { addedAt: 'asc' },
        select: {
          id: true,
          addedAt: true,
          student: {
            select: {
              id: true,
              user: { select: { fullName: true, email: true, avatarUrl: true } },
            },
          },
        },
      }),
      this.prisma.groupAssignment.findMany({
        where: { groupId, deletedAt: null },
        select: {
          id: true,
          role: true,
          user: { select: { id: true, fullName: true, email: true, avatarUrl: true } },
        },
      }),
    ]);
    return {
      id: group.id,
      name: group.name,
      description: group.description,
      status: group.status,
      createdAt: group.createdAt,
      subject: group.subject,
      grade: group.grade,
      capacity: group.capacity,
      lateGraceMin: group.lateGraceMin,
      members: members.map((m) => ({
        membershipId: m.id,
        addedAt: m.addedAt,
        studentId: m.student.id,
        ...m.student.user,
      })),
      assignments: assignments.map((a) => ({
        assignmentId: a.id,
        role: a.role,
        userId: a.user.id,
        ...a.user,
      })),
    };
  }

  async update(ctx: AcademyContext, groupId: string, dto: UpdateGroupDto) {
    await this.access.assertGroupAccess(ctx, groupId);
    const config = await this.classConfig(ctx.academyId, dto);
    const group = await this.prisma.$transaction(async (tx) => {
      if (config.capacity != null) {
        // Under the same lock seat-taking uses: a capacity below the students
        // already in the group would describe a group that cannot exist.
        await tx.$queryRaw`SELECT id FROM "Group" WHERE id = ${groupId} FOR UPDATE`;
        const seated = await tx.groupMembership.count({ where: { groupId, deletedAt: null } });
        if (seated > config.capacity)
          throw new ConflictException({
            message: 'More students are already in this group',
            code: 'CAPACITY_BELOW_MEMBERS',
            seated,
          });
      }
      return tx.group.update({
        where: { id: groupId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.status ? { status: dto.status } : {}),
          ...config,
        },
      });
    });
    await this.audit.log({
      actorUserId: ctx.userId,
      action: 'group.update',
      entity: 'Group',
      entityId: groupId,
      academyId: ctx.academyId,
      meta: { ...dto },
    });
    return group;
  }

  /**
   * The class configuration a create/update may set (C2), validated against
   * this academy: a Center may only name a subject it offers (the same rule as
   * its courses; a PERSONAL academy is never gated), and a year must be a live
   * one. Keys absent from the request are left out; null clears.
   */
  private async classConfig(
    academyId: string,
    dto: {
      subjectId?: string | null;
      gradeId?: string | null;
      capacity?: number | null;
      lateGraceMin?: number | null;
    },
  ): Promise<{
    subjectId?: string | null;
    gradeId?: string | null;
    capacity?: number | null;
    lateGraceMin?: number | null;
  }> {
    const out: Awaited<ReturnType<GroupsService['classConfig']>> = {};
    if (dto.subjectId !== undefined) {
      if (dto.subjectId) {
        const [academy, subject] = await Promise.all([
          this.prisma.academy.findUnique({ where: { id: academyId }, select: { kind: true } }),
          this.prisma.subject.findFirst({ where: { id: dto.subjectId, isActive: true } }),
        ]);
        const offered =
          !!subject &&
          (academy?.kind !== 'CENTER' ||
            !!(await this.prisma.academySubject.findFirst({
              where: { academyId, subjectId: dto.subjectId, isActive: true },
              select: { id: true },
            })));
        if (!offered)
          throw new BadRequestException({
            message: 'This academy does not offer that subject',
            code: 'SUBJECT_NOT_OFFERED',
            field: 'subjectId',
          });
      }
      out.subjectId = dto.subjectId;
    }
    if (dto.gradeId !== undefined) {
      if (dto.gradeId) {
        const grade = await this.prisma.gradeLevel.findFirst({
          where: { id: dto.gradeId, isActive: true },
          select: { id: true },
        });
        if (!grade)
          throw new BadRequestException({
            message: 'Grade not found',
            code: 'GRADE_NOT_FOUND',
            field: 'gradeId',
          });
      }
      out.gradeId = dto.gradeId;
    }
    if (dto.capacity !== undefined) out.capacity = dto.capacity;
    if (dto.lateGraceMin !== undefined) out.lateGraceMin = dto.lateGraceMin;
    return out;
  }

  async addMembers(ctx: AcademyContext, groupId: string, dto: AddGroupMembersDto) {
    await this.access.assertGroupAccess(ctx, groupId);
    // Every student must be on THIS academy's register — a group can never be
    // used to smuggle in a student from elsewhere.
    const ids = await this.admissible(ctx.academyId, [...new Set(dto.studentIds)]);
    await this.prisma.$transaction((tx) => this.writeMemberships(tx, ctx.academyId, groupId, ids));
    await this.audit.log({
      actorUserId: ctx.userId,
      action: 'group.members.add',
      entity: 'Group',
      entityId: groupId,
      academyId: ctx.academyId,
      meta: { studentIds: ids },
    });
    return this.detail(ctx, groupId);
  }

  /**
   * Which of these learners may join a group of this academy: those ACTIVE on
   * its register (AcademyStudent). The register includes everyone enrolled in
   * the academy's courses (the Enrollment trigger and the C1 backfill put them
   * there), so no online student loses anything; a learner registered at the
   * desk with no course at all is now admissible too, without a fake
   * enrollment. Refuses the whole request, naming who is not admissible.
   */
  async admissible(academyId: string, studentIds: string[]): Promise<string[]> {
    const rows = await this.prisma.academyStudent.findMany({
      where: { academyId, studentId: { in: studentIds } },
      select: { studentId: true, status: true },
    });
    const status = new Map(rows.map((r) => [r.studentId, r.status]));

    // Belt and braces for the trigger: an enrolled learner the register somehow
    // missed is registered now rather than refused.
    const missing = studentIds.filter((id) => !status.has(id));
    if (missing.length) {
      const enrolled = await this.prisma.enrollment.findMany({
        where: { academyId, studentId: { in: missing } },
        select: { studentId: true },
        distinct: ['studentId'],
      });
      for (const e of enrolled) {
        await this.prisma
          .$queryRaw`SELECT academy_student_ensure(${academyId}, ${e.studentId}, 'ONLINE'::"AcademyStudentSource", now()::timestamp)`;
        status.set(e.studentId, 'ACTIVE');
      }
    }

    const withdrawn = studentIds.filter((id) => status.get(id) === 'WITHDRAWN');
    if (withdrawn.length) {
      throw new BadRequestException({
        message: 'Some students have withdrawn from this academy',
        code: 'STUDENT_WITHDRAWN',
        invalid: withdrawn,
      });
    }
    const invalid = studentIds.filter((id) => !status.has(id));
    if (invalid.length) {
      throw new BadRequestException({
        message: 'Some students are not students of this academy',
        code: 'STUDENTS_NOT_ENROLLED',
        invalid,
      });
    }
    return studentIds;
  }

  /**
   * The one place group memberships are written. Idempotent: an active
   * member is left exactly as they are (the open-stint unique index makes a
   * concurrent or repeated add a no-op), and a student removed earlier and
   * added back starts a NEW stint — a new row from now, while the old one
   * keeps the dates it covered (C2: who was in the group on a past class is
   * what attendance is expected against). `addedAt` is also the start of what
   * the group's chat lets them read, so they never come back into what was
   * said while they were out.
   *
   * Seats (Group.capacity) are taken under a lock on the group's row: the
   * count and the insert below see every other desk's add, so the last seat
   * goes to exactly one of two concurrent requests and the other is refused
   * with GROUP_FULL. Returns the ids that were not already active members.
   */
  async writeMemberships(
    tx: Prisma.TransactionClient,
    academyId: string,
    groupId: string,
    studentIds: string[],
  ): Promise<string[]> {
    if (!studentIds.length) return [];
    const [group] = await tx.$queryRaw<{ capacity: number | null }[]>`
      SELECT capacity FROM "Group" WHERE id = ${groupId} AND "academyId" = ${academyId} FOR UPDATE`;
    if (!group)
      throw new NotFoundException({ message: 'Group not found', code: 'GROUP_NOT_FOUND' });
    const active = await tx.groupMembership.findMany({
      where: { groupId, studentId: { in: studentIds }, deletedAt: null },
      select: { studentId: true },
    });
    const already = new Set(active.map((m) => m.studentId));
    const fresh = [...new Set(studentIds)].filter((id) => !already.has(id));
    if (!fresh.length) return [];
    if (group.capacity != null) {
      const seated = await tx.groupMembership.count({ where: { groupId, deletedAt: null } });
      if (seated + fresh.length > group.capacity) {
        throw new ConflictException({
          message: 'This group is full',
          code: 'GROUP_FULL',
          capacity: group.capacity,
          seated,
        });
      }
    }
    await tx.groupMembership.createMany({
      data: fresh.map((studentId) => ({ groupId, studentId, academyId })),
      skipDuplicates: true,
    });
    return fresh;
  }

  /**
   * Moves a learner from one group to another as one step: the stint in
   * `fromGroupId` ends and one in `toGroupId` begins, in a single
   * transaction, so they are never in both and never in neither. The old
   * stint and every attendance taken under it stay as they were. The target's
   * seats are checked under its lock like any add; both groups are locked in
   * id order first, so two opposite transfers cannot deadlock.
   */
  async transfer(ctx: AcademyContext, fromGroupId: string, studentId: string, toGroupId: string) {
    if (fromGroupId === toGroupId)
      throw new BadRequestException({
        message: 'Pick a different group',
        code: 'TRANSFER_SAME_GROUP',
      });
    await this.access.assertGroupAccess(ctx, fromGroupId);
    const target = await this.access.assertGroupAccess(ctx, toGroupId);
    if (target.status !== 'ACTIVE')
      throw new ConflictException({
        message: 'That group is archived',
        code: 'GROUP_ARCHIVED',
      });
    await this.prisma.$transaction(async (tx) => {
      // The learner's register row first — the lock a withdrawal holds while
      // it ends their memberships — then the groups: the same learner→group
      // order the desk's add-to-group takes, so none of them can deadlock and
      // a transfer can never reopen a stint for someone withdrawn meanwhile.
      const [record] = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM "AcademyStudent"
        WHERE "academyId" = ${ctx.academyId} AND "studentId" = ${studentId} FOR UPDATE`;
      const ordered = [fromGroupId, toGroupId].sort();
      await tx.$queryRaw`
        SELECT id FROM "Group" WHERE id IN (${ordered[0]}, ${ordered[1]}) ORDER BY id FOR UPDATE`;
      const stint = await tx.groupMembership.findFirst({
        where: { groupId: fromGroupId, studentId, academyId: ctx.academyId, deletedAt: null },
        select: { id: true },
      });
      if (!stint)
        throw new NotFoundException({
          message: 'Membership not found',
          code: 'MEMBERSHIP_NOT_FOUND',
        });
      if (record?.status === 'WITHDRAWN')
        throw new ConflictException({
          message: 'This student has withdrawn; reactivate them first',
          code: 'STUDENT_WITHDRAWN',
        });
      await tx.groupMembership.update({ where: { id: stint.id }, data: { deletedAt: new Date() } });
      await this.writeMemberships(tx, ctx.academyId, toGroupId, [studentId]);
    });
    await this.leaveGroupChats([fromGroupId], studentId);
    await this.audit.log({
      actorUserId: ctx.userId,
      action: 'group.members.transfer',
      entity: 'Group',
      entityId: toGroupId,
      academyId: ctx.academyId,
      meta: { studentId, fromGroupId, toGroupId },
    });
    return this.detail(ctx, fromGroupId);
  }

  /**
   * Ends every active membership a learner holds in this academy's groups
   * (the same soft delete as removeMember), inside the caller's transaction.
   * Returns the groups, so the caller can evict the learner from their chats
   * once the transaction has committed ({@link leaveGroupChats}).
   */
  async endMemberships(
    tx: Prisma.TransactionClient,
    academyId: string,
    studentId: string,
  ): Promise<string[]> {
    const rows = await tx.groupMembership.findMany({
      where: { academyId, studentId, deletedAt: null },
      select: { groupId: true },
    });
    if (!rows.length) return [];
    await tx.groupMembership.updateMany({
      where: { academyId, studentId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return rows.map((r) => r.groupId);
  }

  /** An open chat tab must stop hearing these groups' rooms straight away. */
  async leaveGroupChats(groupIds: string[], studentId: string) {
    if (!groupIds.length) return;
    const [student, chats] = await Promise.all([
      this.prisma.studentProfile.findUnique({ where: { id: studentId }, select: { userId: true } }),
      this.prisma.chatThread.findMany({
        where: { groupId: { in: groupIds }, kind: 'GROUP' },
        select: { id: true },
      }),
    ]);
    if (student) for (const c of chats) this.realtime.leaveThread(c.id, student.userId);
  }

  async removeMember(ctx: AcademyContext, groupId: string, studentId: string) {
    await this.access.assertGroupAccess(ctx, groupId);
    const membership = await this.prisma.groupMembership.findFirst({
      where: { groupId, studentId },
    });
    if (!membership)
      throw new NotFoundException({
        message: 'Membership not found',
        code: 'MEMBERSHIP_NOT_FOUND',
      });
    await this.prisma.groupMembership.delete({ where: { id: membership.id } });
    // An open chat tab must stop hearing the group's room straight away.
    const [student, chats] = await Promise.all([
      this.prisma.studentProfile.findUnique({ where: { id: studentId }, select: { userId: true } }),
      this.prisma.chatThread.findMany({ where: { groupId, kind: 'GROUP' }, select: { id: true } }),
    ]);
    if (student) for (const c of chats) this.realtime.leaveThread(c.id, student.userId);
    await this.audit.log({
      actorUserId: ctx.userId,
      action: 'group.members.remove',
      entity: 'Group',
      entityId: groupId,
      academyId: ctx.academyId,
      meta: { studentId },
    });
  }

  /** Assigning staff is OWNER-only, not just "anyone with group.manage on this
   *  group" — a teacher assigned to a group must not be able to hand it to a
   *  third party or remove the owner's own oversight of it. */
  async assignStaff(ctx: AcademyContext, groupId: string, dto: AssignStaffDto) {
    const group = await this.prisma.group.findFirst({
      where: { id: groupId, academyId: ctx.academyId },
    });
    if (!group)
      throw new NotFoundException({ message: 'Group not found', code: 'GROUP_NOT_FOUND' });
    if (ctx.role !== 'OWNER')
      throw new BadRequestException({
        message: 'Only the academy owner can assign group staff',
        code: 'GROUP_STAFF_OWNER_ONLY',
      });

    const membership = await this.prisma.academyMembership.findFirst({
      where: {
        userId: dto.userId,
        academyId: ctx.academyId,
        status: 'ACTIVE',
        role: { in: ['TEACHER', 'ASSISTANT', 'OWNER'] },
      },
    });
    if (!membership)
      throw new BadRequestException({
        message: 'That user is not active staff of this academy',
        code: 'NOT_ACADEMY_STAFF',
      });

    const assignment = await this.prisma.groupAssignment.upsert({
      where: { groupId_userId: { groupId, userId: dto.userId } },
      create: { groupId, userId: dto.userId, role: dto.role, academyId: ctx.academyId },
      // Same soft-delete revival as group membership: an unassigned row still
      // holds the unique pair, so re-assigning the same person has to clear it.
      update: { role: dto.role, deletedAt: null },
    });
    await this.audit.log({
      actorUserId: ctx.userId,
      action: 'group.assignment.set',
      entity: 'Group',
      entityId: groupId,
      academyId: ctx.academyId,
      meta: { userId: dto.userId, role: dto.role },
    });
    return assignment;
  }

  async unassignStaff(ctx: AcademyContext, groupId: string, userId: string) {
    const group = await this.prisma.group.findFirst({
      where: { id: groupId, academyId: ctx.academyId },
    });
    if (!group)
      throw new NotFoundException({ message: 'Group not found', code: 'GROUP_NOT_FOUND' });
    if (ctx.role !== 'OWNER')
      throw new BadRequestException({
        message: 'Only the academy owner can change group staff',
        code: 'GROUP_STAFF_OWNER_ONLY',
      });

    const assignment = await this.prisma.groupAssignment.findFirst({ where: { groupId, userId } });
    if (!assignment)
      throw new NotFoundException({
        message: 'Assignment not found',
        code: 'ASSIGNMENT_NOT_FOUND',
      });
    await this.prisma.groupAssignment.delete({ where: { id: assignment.id } });
    await this.audit.log({
      actorUserId: ctx.userId,
      action: 'group.assignment.remove',
      entity: 'Group',
      entityId: groupId,
      academyId: ctx.academyId,
      meta: { userId },
    });
  }
}
