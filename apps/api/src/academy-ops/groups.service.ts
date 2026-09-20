import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AcademyContext } from '../academy/academy-context';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
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
      ...(ctx.role === 'OWNER' ? {} : { assignments: { some: { userId: ctx.userId } } }),
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
          _count: { select: { members: true } },
        },
      }),
    ]);

    const ids = groups.map((g) => g.id);
    const assignmentRows = ids.length
      ? await this.prisma.groupAssignment.findMany({
          where: { groupId: { in: ids } },
          select: { groupId: true, role: true, user: { select: { fullName: true } } },
        })
      : [];
    const byGroup = new Map<string, { role: string; name: string }[]>();
    for (const a of assignmentRows) {
      const list = byGroup.get(a.groupId) ?? [];
      list.push({ role: a.role, name: a.user.fullName });
      byGroup.set(a.groupId, list);
    }

    return {
      total, page, pageSize,
      groups: groups.map((g) => ({
        id: g.id, name: g.name, description: g.description, status: g.status, createdAt: g.createdAt,
        studentsCount: g._count.members,
        staff: byGroup.get(g.id) ?? [],
      })),
    };
  }

  async create(ctx: AcademyContext, dto: CreateGroupDto) {
    const group = await this.prisma.group.create({
      data: { academyId: ctx.academyId, name: dto.name, description: dto.description },
    });
    await this.audit.log({
      actorUserId: ctx.userId, action: 'group.create', entity: 'Group', entityId: group.id, academyId: ctx.academyId,
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
      where: { id: { in: dto.studentIds }, enrollments: { some: { tenantId: ctx.academyId } } },
      select: { id: true },
    });
    const validIds = new Set(validStudents.map((s) => s.id));
    const invalid = dto.studentIds.filter((id) => !validIds.has(id));
    if (invalid.length) {
      throw new BadRequestException({ message: 'Some students are not enrolled in this academy', invalid });
    }

    await this.prisma.$transaction(
      [...validIds].map((studentId) =>
        this.prisma.groupMembership.upsert({
          where: { groupId_studentId: { groupId, studentId } },
          create: { groupId, studentId, academyId: ctx.academyId },
          update: {}, // already a member — idempotent, not an error
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
    if (!membership) throw new NotFoundException('Membership not found');
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
    if (!group) throw new NotFoundException('Group not found');
    if (ctx.role !== 'OWNER') throw new BadRequestException('Only the academy owner can assign group staff');

    const membership = await this.prisma.academyMembership.findFirst({
      where: { userId: dto.userId, academyId: ctx.academyId, status: 'ACTIVE', role: { in: ['TEACHER', 'ASSISTANT', 'OWNER'] } },
    });
    if (!membership) throw new BadRequestException('That user is not active staff of this academy');

    const assignment = await this.prisma.groupAssignment.upsert({
      where: { groupId_userId: { groupId, userId: dto.userId } },
      create: { groupId, userId: dto.userId, role: dto.role, academyId: ctx.academyId },
      update: { role: dto.role },
    });
    await this.audit.log({
      actorUserId: ctx.userId, action: 'group.assignment.set', entity: 'Group', entityId: groupId, academyId: ctx.academyId,
      meta: { userId: dto.userId, role: dto.role },
    });
    return assignment;
  }

  async unassignStaff(ctx: AcademyContext, groupId: string, userId: string) {
    const group = await this.prisma.group.findFirst({ where: { id: groupId, academyId: ctx.academyId } });
    if (!group) throw new NotFoundException('Group not found');
    if (ctx.role !== 'OWNER') throw new BadRequestException('Only the academy owner can change group staff');

    const assignment = await this.prisma.groupAssignment.findFirst({ where: { groupId, userId } });
    if (!assignment) throw new NotFoundException('Assignment not found');
    await this.prisma.groupAssignment.delete({ where: { id: assignment.id } });
    await this.audit.log({
      actorUserId: ctx.userId, action: 'group.assignment.remove', entity: 'Group', entityId: groupId, academyId: ctx.academyId,
      meta: { userId },
    });
  }
}
