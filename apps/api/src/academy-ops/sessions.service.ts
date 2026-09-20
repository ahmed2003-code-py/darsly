import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AcademyContext } from '../academy/academy-context';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { AcademyOpsAccessService } from './academy-ops-access.service';

export type ConflictCode = 'ROOM_CONFLICT' | 'TEACHER_CONFLICT' | 'GROUP_CONFLICT';

export interface CreateSessionInput {
  roomId?: string;
  teacherUserId?: string;
  startAt: string;
  endAt: string;
}
export interface UpdateSessionInput extends Partial<CreateSessionInput> {
  status?: 'SCHEDULED' | 'CANCELLED' | 'COMPLETED';
}

/** conflictingSessionId is included when known, so the frontend can link to it. */
export class ScheduleConflictError extends ConflictException {
  constructor(
    public readonly code: ConflictCode,
    message: string,
    public readonly conflictingSessionId?: string,
  ) {
    super({ message, code, conflictingSessionId });
  }
}

const EXCLUSION_CONSTRAINT_CODE: Record<string, ConflictCode> = {
  GroupSession_room_no_overlap: 'ROOM_CONFLICT',
  GroupSession_teacher_no_overlap: 'TEACHER_CONFLICT',
  GroupSession_group_no_overlap: 'GROUP_CONFLICT',
};

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AcademyOpsAccessService,
    private readonly audit: AuditService,
  ) {}

  /** Same "existing.start < requested.end AND existing.end > requested.start"
   *  rule the DB exclusion constraints encode — this is the friendly
   *  pre-check; the constraints are the actual race-condition guarantee. */
  private async precheckOverlap(
    field: 'roomId' | 'teacherUserId' | 'groupId',
    value: string,
    startAt: Date,
    endAt: Date,
    excludeSessionId: string | undefined,
    code: ConflictCode,
  ): Promise<void> {
    const conflict = await this.prisma.groupSession.findFirst({
      where: {
        [field]: value,
        status: { not: 'CANCELLED' },
        startAt: { lt: endAt },
        endAt: { gt: startAt },
        ...(excludeSessionId ? { id: { not: excludeSessionId } } : {}),
      },
      select: { id: true },
    });
    if (conflict) {
      throw new ScheduleConflictError(code, `${code.replace('_', ' ').toLowerCase()} — another session overlaps this time`, conflict.id);
    }
  }

  /** Catches the DB exclusion-constraint violation a concurrent request can
   *  still hit despite the pre-check above (the actual race-condition
   *  guarantee — see the migration for why the constraint alone is
   *  authoritative), and turns it into the same structured conflict shape. */
  private translateExclusionError(e: unknown): never {
    if (e instanceof Prisma.PrismaClientUnknownRequestError || e instanceof Prisma.PrismaClientKnownRequestError) {
      const msg = String((e as { message?: string }).message ?? e);
      for (const [constraint, code] of Object.entries(EXCLUSION_CONSTRAINT_CODE)) {
        if (msg.includes(constraint)) {
          throw new ScheduleConflictError(code, `${code.replace('_', ' ').toLowerCase()} — another session overlaps this time`);
        }
      }
    }
    throw e;
  }

  private async resolveAndValidate(ctx: AcademyContext, groupId: string, input: CreateSessionInput | UpdateSessionInput, existing?: { startAt: Date; endAt: Date; roomId: string | null; teacherUserId: string | null }) {
    const startAt = input.startAt ? new Date(input.startAt) : existing!.startAt;
    const endAt = input.endAt ? new Date(input.endAt) : existing!.endAt;
    if (!(endAt > startAt)) throw new BadRequestException('endAt must be after startAt');

    const roomId = input.roomId !== undefined ? input.roomId : existing?.roomId ?? undefined;
    const teacherUserId = input.teacherUserId !== undefined ? input.teacherUserId : existing?.teacherUserId ?? undefined;

    if (roomId) {
      const room = await this.prisma.room.findFirst({ where: { id: roomId, academyId: ctx.academyId } });
      if (!room) throw new NotFoundException('Room not found');
      if (room.status === 'ARCHIVED') throw new BadRequestException('This room is archived and cannot be scheduled into');
    }
    if (teacherUserId) {
      const isOwnerSelf = ctx.role === 'OWNER' && teacherUserId === ctx.userId;
      if (!isOwnerSelf) {
        const assigned = await this.prisma.groupAssignment.findFirst({ where: { groupId, userId: teacherUserId } });
        if (!assigned) throw new BadRequestException('That user is not assigned to this group');
      }
    }
    return { startAt, endAt, roomId: roomId ?? null, teacherUserId: teacherUserId ?? null };
  }

  async create(ctx: AcademyContext, groupId: string, dto: CreateSessionInput) {
    await this.access.assertGroupAccess(ctx, groupId);
    const { startAt, endAt, roomId, teacherUserId } = await this.resolveAndValidate(ctx, groupId, dto);

    await this.precheckOverlap('groupId', groupId, startAt, endAt, undefined, 'GROUP_CONFLICT');
    if (roomId) await this.precheckOverlap('roomId', roomId, startAt, endAt, undefined, 'ROOM_CONFLICT');
    if (teacherUserId) await this.precheckOverlap('teacherUserId', teacherUserId, startAt, endAt, undefined, 'TEACHER_CONFLICT');

    try {
      const session = await this.prisma.groupSession.create({
        data: { academyId: ctx.academyId, groupId, roomId, teacherUserId, startAt, endAt, createdBy: ctx.userId },
      });
      await this.audit.log({
        actorUserId: ctx.userId, action: 'session.create', entity: 'GroupSession', entityId: session.id, academyId: ctx.academyId,
        meta: { groupId, roomId, teacherUserId, startAt: dto.startAt, endAt: dto.endAt },
      });
      return session;
    } catch (e) {
      this.translateExclusionError(e);
    }
  }

  async update(ctx: AcademyContext, sessionId: string, dto: UpdateSessionInput) {
    const existing = await this.prisma.groupSession.findFirst({ where: { id: sessionId, academyId: ctx.academyId } });
    if (!existing) throw new NotFoundException('Session not found');
    await this.access.assertGroupAccess(ctx, existing.groupId);

    if (dto.status === 'CANCELLED') {
      const cancelled = await this.prisma.groupSession.update({ where: { id: sessionId }, data: { status: 'CANCELLED' } });
      await this.audit.log({ actorUserId: ctx.userId, action: 'session.cancel', entity: 'GroupSession', entityId: sessionId, academyId: ctx.academyId });
      return cancelled;
    }

    const { startAt, endAt, roomId, teacherUserId } = await this.resolveAndValidate(ctx, existing.groupId, dto, existing);

    await this.precheckOverlap('groupId', existing.groupId, startAt, endAt, sessionId, 'GROUP_CONFLICT');
    if (roomId) await this.precheckOverlap('roomId', roomId, startAt, endAt, sessionId, 'ROOM_CONFLICT');
    if (teacherUserId) await this.precheckOverlap('teacherUserId', teacherUserId, startAt, endAt, sessionId, 'TEACHER_CONFLICT');

    try {
      const session = await this.prisma.groupSession.update({
        where: { id: sessionId },
        data: { startAt, endAt, roomId, teacherUserId, ...(dto.status ? { status: dto.status } : {}) },
      });
      await this.audit.log({
        actorUserId: ctx.userId, action: 'session.update', entity: 'GroupSession', entityId: sessionId, academyId: ctx.academyId,
        meta: { roomId, teacherUserId, startAt: dto.startAt, endAt: dto.endAt, status: dto.status },
      });
      return session;
    } catch (e) {
      this.translateExclusionError(e);
    }
  }

  async cancel(ctx: AcademyContext, sessionId: string) {
    return this.update(ctx, sessionId, { status: 'CANCELLED' });
  }

  /** Role-scoped calendar read: OWNER sees the whole academy; TEACHER/
   *  ASSISTANT see only their assigned groups; STUDENT sees only groups
   *  they're a member of. Always bounded by [from, to) — never the whole
   *  history. */
  async schedule(ctx: AcademyContext, from: Date, to: Date) {
    let groupFilter: Prisma.GroupSessionWhereInput = {};
    if (ctx.role === 'TEACHER' || ctx.role === 'ASSISTANT') {
      const assigned = await this.prisma.groupAssignment.findMany({ where: { userId: ctx.userId }, select: { groupId: true } });
      groupFilter = { groupId: { in: assigned.map((a) => a.groupId) } };
    } else if (ctx.role === 'STUDENT') {
      const memberships = await this.prisma.groupMembership.findMany({
        where: { academyId: ctx.academyId, student: { userId: ctx.userId } },
        select: { groupId: true },
      });
      groupFilter = { groupId: { in: memberships.map((m) => m.groupId) } };
    }

    return this.prisma.groupSession.findMany({
      where: { academyId: ctx.academyId, startAt: { lt: to }, endAt: { gt: from }, ...groupFilter },
      orderBy: { startAt: 'asc' },
      include: {
        group: { select: { id: true, name: true } },
        room: { select: { id: true, name: true } },
        teacher: { select: { id: true, fullName: true } },
      },
    });
  }
}
