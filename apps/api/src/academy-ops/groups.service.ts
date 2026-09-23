import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { GroupAssignmentRole, Prisma } from '@prisma/client';
import { AcademyContext } from '../academy/academy-context';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { asPage } from '../common/pagination';
import { AcademyOpsAccessService } from './academy-ops-access.service';
import { AddGroupMembersDto, AssignStaffDto, CreateGroupDto, UpdateGroupDto } from './dto/academy-ops.dto';

const MAX_PAGE_SIZE = 100;

@Injectable()
export class GroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AcademyOpsAccessService,
    private readonly audit: AuditService,
  ) {}

  /** Every group in the academy an OWNER sees; a TEACHER/ASSISTANT sees only
   *  the ones they're assigned to. */
  async list(ctx: AcademyContext, query: { page?: number; pageSize?: number }) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? 20));

    const where: Prisma.GroupWhereInput = {
      academyId: ctx.academyId,
      deletedAt: null,
      ...(ctx.role === 'OWNER' ? {} : { assignments: { some: { userId: ctx.userId, deletedAt: null } } }),
    };

    const [total, groups] = await Promise.all([
      this.prisma.group.count({ where }),
      this.prisma.group.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true, name: true, description: true, status: true, createdAt: true,
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
      id: g.id, name: g.name, description: g.description, status: g.status, createdAt: g.createdAt,
      studentsCount: g._count.members,
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
      where: { academyId: ctx.academyId, deletedAt: null, status: 'ACTIVE', name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictException({ message: 'A group with this name already exists', code: 'GROUP_NAME_TAKEN', groupId: clash.id });
    }

    const group = await this.prisma.$transaction(async (tx) => {
      const created = await tx.group.create({
        data: { academyId: ctx.academyId, name, description: dto.description },
      });
      if (ctx.role === 'TEACHER' || ctx.role === 'ASSISTANT') {
        await tx.groupAssignment.create({
          data: {
            groupId: created.id,
            userId: ctx.userId,
            academyId: ctx.academyId,
            role: ctx.role === 'ASSISTANT' ? GroupAssignmentRole.ASSISTANT : GroupAssignmentRole.TEACHER,
          },
        });
      }
      return created;
    });

    await this.audit.log({
      actorUserId: ctx.userId, action: 'group.create', entity: 'Group', entityId: group.id, academyId: ctx.academyId,
      meta: { selfAssigned: ctx.role === 'TEACHER' || ctx.role === 'ASSISTANT' },
    });
    return group;
  }

  async detail(ctx: AcademyContext, groupId: string) {
    await this.access.assertGroupAccess(ctx, groupId);
    const [group, members, assignments] = await Promise.all([
      this.prisma.group.findUniqueOrThrow({ where: { id: groupId } }),
      this.prisma.groupMembership.findMany({
        where: { groupId, deletedAt: null },
        orderBy: { addedAt: 'asc' },
        select: { id: true, addedAt: true, student: { select: { id: true, user: { select: { fullName: true, email: true, avatarUrl: true } } } } },
      }),
      this.prisma.groupAssignment.findMany({
        where: { groupId, deletedAt: null },
        select: { id: true, role: true, user: { select: { id: true, fullName: true, email: true, avatarUrl: true } } },
      }),
    ]);
    return {
      id: group.id, name: group.name, description: group.description, status: group.status, createdAt: group.createdAt,
      members: members.map((m) => ({ membershipId: m.id, addedAt: m.addedAt, studentId: m.student.id, ...m.student.user })),
      assignments: assignments.map((a) => ({ assignmentId: a.id, role: a.role, userId: a.user.id, ...a.user })),
    };
  }

  async update(ctx: AcademyContext, groupId: string, dto: UpdateGroupDto) {
    await this.access.assertGroupAccess(ctx, groupId);
    const group = await this.prisma.group.update({
      where: { id: groupId },
      data: { ...(dto.name !== undefined ? { name: dto.name } : {}), ...(dto.description !== undefined ? { description: dto.description } : {}), ...(dto.status ? { status: dto.status } : {}) },
    });
    await this.audit.log({
      actorUserId: ctx.userId, action: 'group.update', entity: 'Group', entityId: groupId, academyId: ctx.academyId, meta: { ...dto },
    });
    return group;
  }

  async addMembers(ctx: AcademyContext, groupId: string, dto: AddGroupMembersDto) {
    await this.access.assertGroupAccess(ctx, groupId);
    // Every student must actually be enrolled in THIS academy — a group can
    // never be used to smuggle in a student from elsewhere.
    const validStudents = await this.prisma.studentProfile.findMany({
      where: { id: { in: dto.studentIds }, enrollments: { some: { academyId: ctx.academyId } } },
      select: { id: true },
    });
    const validIds = new Set(validStudents.map((s) => s.id));
    const invalid = dto.studentIds.filter((id) => !validIds.has(id));
    if (invalid.length) {
      throw new BadRequestException({ message: 'Some students are not enrolled in this academy', code: 'STUDENTS_NOT_ENROLLED', invalid });
    }

    await this.prisma.$transaction(
      [...validIds].map((studentId) =>
        this.prisma.groupMembership.upsert({
          where: { groupId_studentId: { groupId, studentId } },
          create: { groupId, studentId, academyId: ctx.academyId },
          // `upsert` matches on the unique pair, which a soft-deleted row still
          // occupies — so a student who was removed and is being added back
          // lands here, not in `create`. Clearing `deletedAt` is what makes the
          // second add work; an empty update silently did nothing and the
          // student never reappeared in the group.
          update: { deletedAt: null },
        }),
      ),
    );
    await this.audit.log({
      actorUserId: ctx.userId, action: 'group.members.add', entity: 'Group', entityId: groupId, academyId: ctx.academyId,
      meta: { studentIds: [...validIds] },
    });
    return this.detail(ctx, groupId);
  }

  async removeMember(ctx: AcademyContext, groupId: string, studentId: string) {
    await this.access.assertGroupAccess(ctx, groupId);
    const membership = await this.prisma.groupMembership.findFirst({ where: { groupId, studentId } });
    if (!membership) throw new NotFoundException({ message: 'Membership not found', code: 'MEMBERSHIP_NOT_FOUND' });
    await this.prisma.groupMembership.delete({ where: { id: membership.id } });
    await this.audit.log({
      actorUserId: ctx.userId, action: 'group.members.remove', entity: 'Group', entityId: groupId, academyId: ctx.academyId,
      meta: { studentId },
    });
  }

  /** Assigning staff is OWNER-only, not just "anyone with group.manage on this
   *  group" — a teacher assigned to a group must not be able to hand it to a
   *  third party or remove the owner's own oversight of it. */
  async assignStaff(ctx: AcademyContext, groupId: string, dto: AssignStaffDto) {
    const group = await this.prisma.group.findFirst({ where: { id: groupId, academyId: ctx.academyId } });
    if (!group) throw new NotFoundException({ message: 'Group not found', code: 'GROUP_NOT_FOUND' });
    if (ctx.role !== 'OWNER') throw new BadRequestException({ message: 'Only the academy owner can assign group staff', code: 'GROUP_STAFF_OWNER_ONLY' });

    const membership = await this.prisma.academyMembership.findFirst({
      where: { userId: dto.userId, academyId: ctx.academyId, status: 'ACTIVE', role: { in: ['TEACHER', 'ASSISTANT', 'OWNER'] } },
    });
    if (!membership) throw new BadRequestException({ message: 'That user is not active staff of this academy', code: 'NOT_ACADEMY_STAFF' });

    const assignment = await this.prisma.groupAssignment.upsert({
      where: { groupId_userId: { groupId, userId: dto.userId } },
      create: { groupId, userId: dto.userId, role: dto.role, academyId: ctx.academyId },
      // Same soft-delete revival as group membership: an unassigned row still
      // holds the unique pair, so re-assigning the same person has to clear it.
      update: { role: dto.role, deletedAt: null },
    });
    await this.audit.log({
      actorUserId: ctx.userId, action: 'group.assignment.set', entity: 'Group', entityId: groupId, academyId: ctx.academyId,
      meta: { userId: dto.userId, role: dto.role },
    });
    return assignment;
  }

  async unassignStaff(ctx: AcademyContext, groupId: string, userId: string) {
    const group = await this.prisma.group.findFirst({ where: { id: groupId, academyId: ctx.academyId } });
    if (!group) throw new NotFoundException({ message: 'Group not found', code: 'GROUP_NOT_FOUND' });
    if (ctx.role !== 'OWNER') throw new BadRequestException({ message: 'Only the academy owner can change group staff', code: 'GROUP_STAFF_OWNER_ONLY' });

    const assignment = await this.prisma.groupAssignment.findFirst({ where: { groupId, userId } });
    if (!assignment) throw new NotFoundException({ message: 'Assignment not found', code: 'ASSIGNMENT_NOT_FOUND' });
    await this.prisma.groupAssignment.delete({ where: { id: assignment.id } });
    await this.audit.log({
      actorUserId: ctx.userId, action: 'group.assignment.remove', entity: 'Group', entityId: groupId, academyId: ctx.academyId,
      meta: { userId },
    });
  }
}
