import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SessionLocationType, SessionMode } from '@prisma/client';
import { AcademyService } from '../academy/academy.service';
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
  /** How it is delivered — data on the occurrence, never a role. Defaults to PHYSICAL. */
  mode?: SessionMode;
  /** Where a PHYSICAL/HYBRID occurrence happens. Must be null for ONLINE. */
  locationType?: SessionLocationType | null;
  locationNote?: string | null;
  /** Online access for ONLINE/HYBRID when no LiveSession covers the same group and window. */
  joinUrl?: string | null;
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
    private readonly academy: AcademyService,
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
    academyId?: string,
  ): Promise<void> {
    const conflict = await this.prisma.groupSession.findFirst({
      where: {
        [field]: value,
        status: { not: 'CANCELLED' },
        startAt: { lt: endAt },
        endAt: { gt: startAt },
        ...(excludeSessionId ? { id: { not: excludeSessionId } } : {}),
      },
      select: { id: true, academyId: true },
    });
    if (conflict) {
      // A collision in another academy is real, but its id is not ours to reveal.
      const ownId = !academyId || conflict.academyId === academyId ? conflict.id : undefined;
      throw new ScheduleConflictError(code, `${code.replace('_', ' ').toLowerCase()} — another session overlaps this time`, ownId);
    }
  }

  /** The teacher's live streams are the other half of "cannot be in two places at once". */
  private async precheckLiveOverlap(teacherUserId: string, startAt: Date, endAt: Date, academyId: string): Promise<void> {
    const candidates = await this.prisma.liveSession.findMany({
      where: { teacherUserId, status: { not: 'ENDED' }, startsAt: { lt: endAt } },
      select: { id: true, academyId: true, startsAt: true, durationMin: true },
    });
    const clash = candidates.find((c) => new Date(c.startsAt.getTime() + c.durationMin * 60_000) > startAt);
    if (clash) {
      throw new ScheduleConflictError('TEACHER_CONFLICT', 'teacher conflict — a live session overlaps this time', clash.academyId === academyId ? clash.id : undefined);
    }
  }

  /**
   * Mode and location are one consistent statement about the occurrence:
   *   ONLINE   — no physical location, no room; needs online access
   *   PHYSICAL — a location type; no online access recorded
   *   HYBRID   — a location type AND online access
   * Online access is a joinUrl, or a LiveSession already scheduled for the
   * same group inside the window (the derived link the contract prefers).
   */
  private async resolveDelivery(
    input: CreateSessionInput | UpdateSessionInput,
    existing: { mode: SessionMode; locationType: SessionLocationType | null; locationNote: string | null; joinUrl: string | null } | undefined,
    groupId: string,
    roomId: string | null,
    startAt: Date,
    endAt: Date,
  ) {
    const mode = input.mode ?? existing?.mode ?? 'PHYSICAL';
    // A room is, by definition, at the Center — the location type follows from it.
    const locationType = input.locationType !== undefined ? input.locationType : existing?.locationType ?? (roomId ? 'CENTER' : null);
    const locationNote = input.locationNote !== undefined ? input.locationNote : existing?.locationNote ?? null;
    const joinUrl = input.joinUrl !== undefined ? input.joinUrl : existing?.joinUrl ?? null;

    if (mode === 'ONLINE') {
      if (locationType || roomId) throw new BadRequestException({ message: 'An online session has no physical location', code: 'ONLINE_HAS_LOCATION' });
    } else {
      if (!locationType) throw new BadRequestException({ message: 'A physical or hybrid session needs a location type', code: 'LOCATION_REQUIRED' });
      if (roomId && locationType !== 'CENTER') throw new BadRequestException({ message: 'A room means the session is at the Center', code: 'ROOM_NEEDS_CENTER_LOCATION' });
    }
    if (mode !== 'PHYSICAL' && !joinUrl) {
      const live = await this.prisma.liveSession.findFirst({
        where: { groupId, status: { not: 'ENDED' }, startsAt: { lt: endAt } },
        select: { startsAt: true, durationMin: true },
      });
      const covered = live && new Date(live.startsAt.getTime() + live.durationMin * 60_000) > startAt;
      if (!covered) throw new BadRequestException({ message: 'An online or hybrid session needs a join link or a live session for this group', code: 'ONLINE_ACCESS_REQUIRED' });
    }
    return { mode, locationType: mode === 'ONLINE' ? null : locationType, locationNote: mode === 'ONLINE' ? null : locationNote, joinUrl: mode === 'PHYSICAL' ? null : joinUrl };
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

  private async resolveAndValidate(ctx: AcademyContext, groupId: string, input: CreateSessionInput | UpdateSessionInput, existing?: { startAt: Date; endAt: Date; roomId: string | null; teacherUserId: string | null; mode: SessionMode; locationType: SessionLocationType | null; locationNote: string | null; joinUrl: string | null }) {
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
      // An approved TEACHER identity with ACTIVE membership here — STAFF,
      // students and other Centers' teachers are refused by this check.
      await this.academy.assertAssignableTeacher(ctx.academyId, teacherUserId);
      const isOwnerSelf = ctx.role === 'OWNER' && teacherUserId === ctx.userId;
      if (!isOwnerSelf) {
        const assigned = await this.prisma.groupAssignment.findFirst({ where: { groupId, userId: teacherUserId } });
        if (!assigned) throw new BadRequestException('That user is not assigned to this group');
      }
    }
    const delivery = await this.resolveDelivery(input, existing, groupId, roomId ?? null, startAt, endAt);
    return { startAt, endAt, roomId: roomId ?? null, teacherUserId: teacherUserId ?? null, ...delivery };
  }

  async create(ctx: AcademyContext, groupId: string, dto: CreateSessionInput) {
    await this.access.assertGroupAccess(ctx, groupId);
    const { startAt, endAt, roomId, teacherUserId, mode, locationType, locationNote, joinUrl } = await this.resolveAndValidate(ctx, groupId, dto);

    await this.precheckOverlap('groupId', groupId, startAt, endAt, undefined, 'GROUP_CONFLICT', ctx.academyId);
    if (roomId) await this.precheckOverlap('roomId', roomId, startAt, endAt, undefined, 'ROOM_CONFLICT', ctx.academyId);
    if (teacherUserId) {
      await this.precheckOverlap('teacherUserId', teacherUserId, startAt, endAt, undefined, 'TEACHER_CONFLICT', ctx.academyId);
      await this.precheckLiveOverlap(teacherUserId, startAt, endAt, ctx.academyId);
    }

    try {
      const session = await this.prisma.groupSession.create({
        data: { academyId: ctx.academyId, groupId, roomId, teacherUserId, startAt, endAt, mode, locationType, locationNote, joinUrl, createdBy: ctx.userId },
      });
      await this.audit.log({
        actorUserId: ctx.userId, action: 'session.create', entity: 'GroupSession', entityId: session.id, academyId: ctx.academyId,
        meta: { groupId, roomId, teacherUserId, mode, locationType, startAt: dto.startAt, endAt: dto.endAt },
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

    const { startAt, endAt, roomId, teacherUserId, mode, locationType, locationNote, joinUrl } = await this.resolveAndValidate(ctx, existing.groupId, dto, existing);

    await this.precheckOverlap('groupId', existing.groupId, startAt, endAt, sessionId, 'GROUP_CONFLICT', ctx.academyId);
    if (roomId) await this.precheckOverlap('roomId', roomId, startAt, endAt, sessionId, 'ROOM_CONFLICT', ctx.academyId);
    if (teacherUserId) {
      await this.precheckOverlap('teacherUserId', teacherUserId, startAt, endAt, sessionId, 'TEACHER_CONFLICT', ctx.academyId);
      await this.precheckLiveOverlap(teacherUserId, startAt, endAt, ctx.academyId);
    }

    try {
      const session = await this.prisma.groupSession.update({
        where: { id: sessionId },
        data: { startAt, endAt, roomId, teacherUserId, mode, locationType, locationNote, joinUrl, ...(dto.status ? { status: dto.status } : {}) },
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

    const groupSessions = await this.prisma.groupSession.findMany({
      where: { academyId: ctx.academyId, startAt: { lt: to }, endAt: { gt: from }, ...groupFilter },
      orderBy: { startAt: 'asc' },
      include: {
        group: { select: { id: true, name: true } },
        room: { select: { id: true, name: true } },
        teacher: { select: { id: true, fullName: true } },
      },
    });
    // Live streams of the same academy, scoped the same way: OWNER sees all; a
    // staff member their own or their assigned groups'; a student the streams
    // of groups they are in (or academy-wide ones).
    const groupIds = 'groupId' in groupFilter ? (groupFilter.groupId as { in: string[] }).in : null;
    const liveWhere: Prisma.LiveSessionWhereInput = {
      academyId: ctx.academyId,
      startsAt: { lt: to },
      ...(ctx.role === 'OWNER'
        ? {}
        : ctx.role === 'STUDENT'
          ? { OR: [{ groupId: null }, { groupId: { in: groupIds ?? [] } }] }
          : { OR: [{ teacherUserId: ctx.userId }, { groupId: { in: groupIds ?? [] } }] }),
    };
    const liveSessions = await this.prisma.liveSession.findMany({
      where: liveWhere,
      orderBy: { startsAt: 'asc' },
      include: { group: { select: { id: true, name: true } }, teacherUser: { select: { id: true, fullName: true } } },
    });
    const live = liveSessions
      .map((l) => ({ ...this.liveAsEvent(l), academyId: ctx.academyId }))
      .filter((l) => l.endAt > from);
    return [...groupSessions.map((g) => ({ kind: 'GROUP' as const, ...g })), ...live].sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  }

  /** A live stream in the same shape as a GroupSession event, so one calendar can hold both. */
  liveAsEvent(l: { id: string; title: string; startsAt: Date; durationMin: number; status: string; groupId: string | null; teacherUserId: string | null; joinUrl: string | null; group?: { id: string; name: string } | null; teacherUser?: { id: string; fullName: string } | null }) {
    return {
      kind: 'LIVE' as const,
      id: l.id,
      title: l.title,
      groupId: l.groupId,
      group: l.group ?? null,
      roomId: null,
      room: null,
      teacherUserId: l.teacherUserId,
      teacher: l.teacherUser ?? null,
      mode: 'ONLINE' as const,
      locationType: null,
      locationNote: null,
      joinUrl: l.joinUrl,
      startAt: l.startsAt,
      endAt: new Date(l.startsAt.getTime() + l.durationMin * 60_000),
      status: l.status === 'ENDED' ? ('COMPLETED' as const) : ('SCHEDULED' as const),
    };
  }

  /**
   * One teacher's whole week, every workspace: their own PERSONAL academy and
   * every Center they belong to, both physical slots and live streams. Keyed
   * on the teacher as a User — nobody else's sessions can appear here.
   */
  async mySchedule(userId: string, from: Date, to: Date) {
    const [groupSessions, liveSessions] = await Promise.all([
      this.prisma.groupSession.findMany({
        where: { teacherUserId: userId, startAt: { lt: to }, endAt: { gt: from } },
        orderBy: { startAt: 'asc' },
        include: {
          academy: { select: { id: true, name: true, slug: true, kind: true } },
          group: { select: { id: true, name: true } },
          room: { select: { id: true, name: true } },
          teacher: { select: { id: true, fullName: true } },
        },
      }),
      this.prisma.liveSession.findMany({
        where: { teacherUserId: userId, startsAt: { lt: to } },
        orderBy: { startsAt: 'asc' },
        include: {
          academy: { select: { id: true, name: true, slug: true, kind: true } },
          group: { select: { id: true, name: true } },
          teacherUser: { select: { id: true, fullName: true } },
        },
      }),
    ]);
    const live = liveSessions
      .map((l) => ({ ...this.liveAsEvent(l), academyId: l.academyId, academy: l.academy }))
      .filter((l) => l.endAt > from);
    return [...groupSessions.map((g) => ({ kind: 'GROUP' as const, ...g })), ...live].sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  }
}
