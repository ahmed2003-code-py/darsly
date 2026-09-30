import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { GroupScheduleSlot, Prisma, SessionLocationType } from '@prisma/client';
import { AcademyContext } from '../academy/academy-context';
import { AcademyService } from '../academy/academy.service';
import { AcademyOpsAccessService } from '../academy-ops/academy-ops-access.service';
import { ConflictCode, ScheduleConflictError } from '../academy-ops/sessions.service';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSlotDto, UpdateSlotDto } from './dto';
import {
  addDays,
  dateKey,
  dateValue,
  formatClock,
  isValidTimeZone,
  parseClock,
  wallClock,
  weekdayOf,
  zonedToInstant,
} from './zoned-time';

/** Occurrences exist this many local days ahead, today included. */
export const HORIZON_DAYS = 28;
/** Raised inside a dry run to roll the transaction back with its summary. */
class DryRun extends Error {
  constructor(readonly summary: SlotChangeSummary) {
    super('dry run');
  }
}

export interface SlotChangeSummary {
  /** Future untouched classes moved to the new time/room/teacher. */
  updated: number;
  /** Future untouched classes that no longer fall on the timetable. */
  removed: number;
  /** New classes created. */
  created: number;
  /** Future classes left exactly as they are (cancelled, started, edited by hand, or with attendance). */
  kept: number;
  /** First local date the change applies from. */
  from: string;
}

type Db = Prisma.TransactionClient;

/**
 * Center Operations C2 — the weekly timetable and the classes it generates.
 *
 * A slot is a rule; the classes are real GroupSession rows, because a class is
 * what attendance, cancelling, starting and (later) scanning and fees hang on.
 * They exist for a rolling HORIZON_DAYS ahead, created when a slot is saved and
 * topped up by ClassOpsWorker and on reading Today.
 *
 * The rules that keep this honest:
 *  - One class per slot per local date: a partial unique index. A CANCELLED
 *    class keeps that key, so generating again can never bring it back.
 *  - A class is "untouched" while it is SCHEDULED, in the future, never
 *    started, never edited by hand (customizedAt) and has no attendance sheet.
 *    Only untouched classes ever change when the slot changes; everything
 *    else is history and stays exactly as it is.
 *  - Room, teacher and group overlaps are the GiST exclusion constraints on
 *    GroupSession (the guarantee under concurrency); the checks here only
 *    turn them into a friendly, dated conflict before anything is written.
 *  - Every generation for a slot runs under a per-slot advisory lock, so a
 *    save and the worker (or two workers) never interleave.
 */
@Injectable()
export class ClassScheduleService {
  private readonly logger = new Logger(ClassScheduleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AcademyOpsAccessService,
    private readonly audit: AuditService,
    private readonly academy: AcademyService,
  ) {}

  // ── Reads ───────────────────────────────────────────────────────────────

  async academyClock(academyId: string) {
    const a = await this.prisma.academy.findUniqueOrThrow({
      where: { id: academyId },
      select: { timezone: true, lateGraceMin: true },
    });
    const timezone = isValidTimeZone(a.timezone) ? a.timezone : 'Africa/Cairo';
    return { timezone, lateGraceMin: a.lateGraceMin, today: wallClock(new Date(), timezone).date };
  }

  /**
   * What a timetable or group form may choose from, scoped to one group the
   * caller may plan: the academy's active rooms (names only — managing rooms
   * stays the owner's), the teachers on this group, the subjects the academy
   * offers and the school years. Nothing about students.
   */
  async options(ctx: AcademyContext, groupId: string) {
    await this.access.assertGroupAccess(ctx, groupId);
    const academy = await this.prisma.academy.findUniqueOrThrow({
      where: { id: ctx.academyId },
      select: { kind: true, ownerUserId: true, owner: { select: { id: true, fullName: true } } },
    });
    const [rooms, assigned, subjects, grades] = await Promise.all([
      this.prisma.room.findMany({
        where: { academyId: ctx.academyId, status: 'ACTIVE' },
        select: { id: true, name: true, capacity: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.groupAssignment.findMany({
        where: { groupId, role: 'TEACHER' },
        select: { user: { select: { id: true, fullName: true } } },
      }),
      academy.kind === 'CENTER'
        ? this.prisma.subject.findMany({
            where: {
              isActive: true,
              academies: { some: { academyId: ctx.academyId, isActive: true } },
            },
            select: { id: true, nameAr: true, nameEn: true },
            orderBy: { sortOrder: 'asc' },
          })
        : this.prisma.subject.findMany({
            where: { isActive: true },
            select: { id: true, nameAr: true, nameEn: true },
            orderBy: { sortOrder: 'asc' },
          }),
      this.prisma.gradeLevel.findMany({
        where: { isActive: true },
        select: { id: true, nameAr: true, nameEn: true },
        orderBy: { sortOrder: 'asc' },
      }),
    ]);
    const teachers = assigned.map((a) => a.user);
    // A PERSONAL academy's owner teaches their own groups.
    if (academy.kind === 'PERSONAL' && !teachers.some((t) => t.id === academy.ownerUserId))
      teachers.unshift(academy.owner);
    return { rooms, teachers, subjects, grades, kind: academy.kind };
  }

  async listSlots(ctx: AcademyContext, groupId: string) {
    await this.access.assertGroupAccess(ctx, groupId);
    const slots = await this.prisma.groupScheduleSlot.findMany({
      where: { groupId, academyId: ctx.academyId },
      orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }],
      include: {
        room: { select: { id: true, name: true } },
        teacher: { select: { id: true, fullName: true } },
      },
    });
    return slots.map((s) => this.view(s));
  }

  private view(
    s: GroupScheduleSlot & {
      room?: { id: string; name: string } | null;
      teacher?: { id: string; fullName: string } | null;
    },
  ) {
    return {
      id: s.id,
      groupId: s.groupId,
      weekday: s.weekday,
      startTime: formatClock(s.startMinute),
      durationMin: s.durationMin,
      roomId: s.roomId,
      room: s.room ?? null,
      teacherUserId: s.teacherUserId,
      teacher: s.teacher ?? null,
      locationType: s.locationType,
      locationNote: s.locationNote,
      validFrom: dateKey(s.validFrom),
      validTo: s.validTo ? dateKey(s.validTo) : null,
      generatedThrough: s.generatedThrough ? dateKey(s.generatedThrough) : null,
    };
  }

  // ── Writes ──────────────────────────────────────────────────────────────

  async createSlot(ctx: AcademyContext, groupId: string, dto: CreateSlotDto) {
    const group = await this.access.assertGroupAccess(ctx, groupId);
    if (group.status !== 'ACTIVE')
      throw new ConflictException({ message: 'That group is archived', code: 'GROUP_ARCHIVED' });
    const clock = await this.academyClock(ctx.academyId);
    if (dto.requestKey) {
      const prior = await this.prisma.groupScheduleSlot.findFirst({
        where: { academyId: ctx.academyId, requestKey: dto.requestKey, deletedAt: undefined },
      });
      if (prior) return this.view(prior);
    }
    const shape = await this.resolveShape(ctx, groupId, dto, undefined, clock.today);

    try {
      const slot = await this.prisma.$transaction(
        async (tx) => {
          const created = await tx.groupScheduleSlot.create({
            data: {
              academyId: ctx.academyId,
              groupId,
              ...shape,
              requestKey: dto.requestKey ?? null,
              createdBy: ctx.userId,
            },
          });
          await this.generate(tx, created, clock.timezone, clock.today, true);
          return created;
        },
        { timeout: 30_000 },
      );
      await this.audit.log({
        actorUserId: ctx.userId,
        action: 'schedule.slot.create',
        entity: 'GroupScheduleSlot',
        entityId: slot.id,
        academyId: ctx.academyId,
        meta: {
          groupId,
          weekday: shape.weekday,
          startTime: dto.startTime,
          durationMin: shape.durationMin,
          roomId: shape.roomId,
          teacherUserId: shape.teacherUserId,
        },
      });
      return this.view(
        await this.prisma.groupScheduleSlot.findUniqueOrThrow({ where: { id: slot.id } }),
      );
    } catch (e) {
      // A concurrent save with the same key won; return its slot.
      if (
        dto.requestKey &&
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const prior = await this.prisma.groupScheduleSlot.findFirst({
          where: { academyId: ctx.academyId, requestKey: dto.requestKey, deletedAt: undefined },
        });
        if (prior) return this.view(prior);
      }
      throw this.translate(e);
    }
  }

  /**
   * Changes a timetable line. From the first local date the change can apply
   * (today, or the new validFrom if later), every UNTOUCHED future class of
   * the slot is brought in line: moved in place where its date still falls on
   * the timetable, removed where it no longer does, and missing dates are
   * created. Cancelled, started, hand-edited and attended classes are kept as
   * they are. `dryRun` reports exactly that without keeping any of it.
   */
  async updateSlot(ctx: AcademyContext, slotId: string, dto: UpdateSlotDto) {
    const slot = await this.findSlot(ctx, slotId);
    await this.access.assertGroupAccess(ctx, slot.groupId);
    const clock = await this.academyClock(ctx.academyId);
    const shape = await this.resolveShape(ctx, slot.groupId, dto, slot, clock.today);

    try {
      const summary = await this.prisma.$transaction(
        async (tx) => {
          await this.lockSlot(tx, slotId);
          const updated = await tx.groupScheduleSlot.update({ where: { id: slotId }, data: shape });
          const result = await this.realign(tx, updated, clock.timezone, clock.today);
          if (dto.dryRun) throw new DryRun(result);
          return result;
        },
        { timeout: 30_000 },
      );
      await this.audit.log({
        actorUserId: ctx.userId,
        action: 'schedule.slot.update',
        entity: 'GroupScheduleSlot',
        entityId: slotId,
        academyId: ctx.academyId,
        meta: { groupId: slot.groupId, changes: this.changedKeys(dto), ...summary },
      });
      const fresh = await this.prisma.groupScheduleSlot.findUniqueOrThrow({
        where: { id: slotId },
        include: {
          room: { select: { id: true, name: true } },
          teacher: { select: { id: true, fullName: true } },
        },
      });
      return { slot: this.view(fresh), summary };
    } catch (e) {
      if (e instanceof DryRun) return { slot: null, summary: e.summary, dryRun: true };
      throw this.translate(e);
    }
  }

  /** Ends a timetable line: its untouched future classes go, everything else stays. */
  async deleteSlot(ctx: AcademyContext, slotId: string, dryRun = false) {
    const slot = await this.findSlot(ctx, slotId);
    await this.access.assertGroupAccess(ctx, slot.groupId);
    const clock = await this.academyClock(ctx.academyId);
    try {
      const summary = await this.prisma.$transaction(async (tx) => {
        await this.lockSlot(tx, slotId);
        const { untouched, kept } = await this.futureClasses(tx, slotId);
        if (untouched.length)
          await tx.groupSession.updateMany({
            where: { id: { in: untouched.map((o) => o.id) } },
            data: { deletedAt: new Date() },
          });
        await tx.groupScheduleSlot.update({
          where: { id: slotId },
          data: { deletedAt: new Date() },
        });
        const result: SlotChangeSummary = {
          updated: 0,
          removed: untouched.length,
          created: 0,
          kept: kept.length,
          from: clock.today,
        };
        if (dryRun) throw new DryRun(result);
        return result;
      });
      await this.audit.log({
        actorUserId: ctx.userId,
        action: 'schedule.slot.delete',
        entity: 'GroupScheduleSlot',
        entityId: slotId,
        academyId: ctx.academyId,
        meta: { groupId: slot.groupId, ...summary },
      });
      return { summary };
    } catch (e) {
      if (e instanceof DryRun) return { summary: e.summary, dryRun: true };
      throw e;
    }
  }

  // ── Generation ──────────────────────────────────────────────────────────

  /**
   * Keeps every live slot of the academy generated HORIZON_DAYS ahead. Cheap
   * when there is nothing to do (one indexed query); safe to call on reads.
   */
  async ensureHorizon(academyId: string) {
    const clock = await this.academyClock(academyId);
    const through = dateValue(addDays(clock.today, HORIZON_DAYS - 1));
    const stale = await this.prisma.groupScheduleSlot.findMany({
      where: {
        academyId,
        group: { status: 'ACTIVE', deletedAt: null },
        OR: [{ generatedThrough: null }, { generatedThrough: { lt: through } }],
        AND: [{ OR: [{ validTo: null }, { validTo: { gte: dateValue(clock.today) } }] }],
      },
    });
    let created = 0;
    for (const slot of stale) {
      try {
        created += await this.prisma.$transaction(
          async (tx) => {
            await this.lockSlot(tx, slot.id);
            const fresh = await tx.groupScheduleSlot.findFirst({ where: { id: slot.id } });
            if (!fresh) return 0;
            return (await this.generate(tx, fresh, clock.timezone, clock.today, false)).created;
          },
          { timeout: 30_000 },
        );
      } catch (e) {
        this.logger.warn(`top-up of slot ${slot.id} failed: ${(e as Error).message}`);
      }
    }
    return created;
  }

  /**
   * Creates the slot's missing classes from `today` through the horizon (and
   * its validity). With `strict`, anything that cannot be scheduled — a room,
   * teacher, group or live-stream overlap — refuses the whole save with the
   * first conflicting date; without it (the worker), that one class is
   * skipped and the rest are created. Idempotent: existing keys, including
   * cancelled classes, are never touched.
   */
  async generate(
    tx: Db,
    slot: GroupScheduleSlot,
    timezone: string,
    today: string,
    strict: boolean,
  ): Promise<{ created: number; skipped: string[] }> {
    await this.lockSlot(tx, slot.id);
    const last = addDays(today, HORIZON_DAYS - 1);
    const from = [today, dateKey(slot.validFrom)].sort()[1];
    const until = slot.validTo && dateKey(slot.validTo) < last ? dateKey(slot.validTo) : last;
    const dates: string[] = [];
    for (let d = from; d <= until; d = addDays(d, 1))
      if (weekdayOf(d) === slot.weekday) dates.push(d);

    const existing = new Set(
      (
        await tx.groupSession.findMany({
          where: { slotId: slot.id, occurrenceDate: { in: dates.map(dateValue) } },
          select: { occurrenceDate: true },
        })
      ).map((o) => dateKey(o.occurrenceDate!)),
    );
    const now = Date.now();
    const wanted = dates
      .filter((d) => !existing.has(d))
      .map((d) => {
        const startAt = zonedToInstant(d, slot.startMinute, timezone);
        return { date: d, startAt, endAt: new Date(startAt.getTime() + slot.durationMin * 60_000) };
      })
      // A class that has already ended today is not created after the fact.
      .filter((o) => o.endAt.getTime() > now);

    const skipped: string[] = [];
    const insertable: typeof wanted = [];
    for (const o of wanted) {
      const clash = await this.conflictFor(tx, slot, o.startAt, o.endAt, undefined);
      if (clash) {
        if (strict) throw new ScheduleConflictError(clash.code, clash.message, clash.id, o.date);
        skipped.push(o.date);
      } else insertable.push(o);
    }
    let created = 0;
    if (insertable.length) {
      // skipDuplicates is ON CONFLICT DO NOTHING without a target: it also
      // yields to the exclusion constraints, so a booking that raced in after
      // the check above is skipped rather than failing the batch.
      const res = await tx.groupSession.createMany({
        data: insertable.map((o) => ({
          academyId: slot.academyId,
          groupId: slot.groupId,
          slotId: slot.id,
          occurrenceDate: dateValue(o.date),
          startAt: o.startAt,
          endAt: o.endAt,
          roomId: slot.roomId,
          teacherUserId: slot.teacherUserId,
          mode: 'PHYSICAL' as const,
          locationType: slot.locationType,
          locationNote: slot.locationNote,
          createdBy: slot.createdBy,
        })),
        skipDuplicates: true,
      });
      created = res.count;
      if (created < insertable.length) {
        // Something committed between the check and the insert took a slot
        // this class needed. Name it, as the check would have.
        const made = new Set(
          (
            await tx.groupSession.findMany({
              where: {
                slotId: slot.id,
                occurrenceDate: { in: insertable.map((o) => dateValue(o.date)) },
              },
              select: { occurrenceDate: true },
            })
          ).map((o) => dateKey(o.occurrenceDate!)),
        );
        for (const o of insertable) {
          if (made.has(o.date)) continue;
          if (strict) {
            const clash = await this.conflictFor(tx, slot, o.startAt, o.endAt, undefined);
            throw new ScheduleConflictError(
              clash?.code ?? 'GROUP_CONFLICT',
              clash?.message ?? 'another session overlaps this time',
              clash?.id,
              o.date,
            );
          }
          skipped.push(o.date);
        }
      }
    }
    await tx.groupScheduleSlot.update({
      where: { id: slot.id },
      data: { generatedThrough: dateValue(last) },
    });
    if (skipped.length)
      this.logger.warn(`slot ${slot.id}: ${skipped.length} class(es) skipped for conflicts`);
    return { created, skipped };
  }

  /** Brings the slot's untouched future classes in line with its (new) rule. */
  private async realign(
    tx: Db,
    slot: GroupScheduleSlot,
    timezone: string,
    today: string,
  ): Promise<SlotChangeSummary> {
    const from = [today, dateKey(slot.validFrom)].sort()[1];
    const { untouched, kept } = await this.futureClasses(tx, slot.id);
    let updated = 0;
    let removed = 0;
    const onRule = (d: string) =>
      d >= from && (!slot.validTo || d <= dateKey(slot.validTo)) && weekdayOf(d) === slot.weekday;
    // Remove first, so a moved class never collides with one about to go.
    const stays = untouched.filter((o) => onRule(dateKey(o.occurrenceDate!)));
    const goes = untouched.filter((o) => !onRule(dateKey(o.occurrenceDate!)));
    if (goes.length) {
      await tx.groupSession.updateMany({
        where: { id: { in: goes.map((o) => o.id) } },
        data: { deletedAt: new Date() },
      });
      removed = goes.length;
    }
    for (const o of stays) {
      const d = dateKey(o.occurrenceDate!);
      const startAt = zonedToInstant(d, slot.startMinute, timezone);
      const endAt = new Date(startAt.getTime() + slot.durationMin * 60_000);
      const clash = await this.conflictFor(tx, slot, startAt, endAt, o.id);
      if (clash) throw new ScheduleConflictError(clash.code, clash.message, clash.id, d);
      await tx.groupSession.update({
        where: { id: o.id },
        data: {
          startAt,
          endAt,
          roomId: slot.roomId,
          teacherUserId: slot.teacherUserId,
          locationType: slot.locationType,
          locationNote: slot.locationNote,
        },
      });
      updated++;
    }
    const { created } = await this.generate(tx, slot, timezone, today, true);
    return { updated, removed, created, kept: kept.length, from };
  }

  /** The slot's classes that have not started yet, split by whether a change may touch them. */
  private async futureClasses(tx: Db, slotId: string) {
    const future = await tx.groupSession.findMany({
      where: { slotId, startAt: { gt: new Date() } },
      select: {
        id: true,
        occurrenceDate: true,
        status: true,
        customizedAt: true,
        startedAt: true,
        attendance: { select: { id: true } },
      },
    });
    const isUntouched = (o: (typeof future)[number]) =>
      o.status === 'SCHEDULED' && !o.customizedAt && !o.startedAt && !o.attendance;
    return { untouched: future.filter(isUntouched), kept: future.filter((o) => !isUntouched(o)) };
  }

  /**
   * The first thing that would make this class impossible: another class of
   * the group, the room, or the teacher (any academy — a person cannot be in
   * two places) overlapping it, or the teacher's live stream. The same rule
   * the exclusion constraints and SessionsService's pre-check encode.
   */
  private async conflictFor(
    tx: Db,
    slot: Pick<GroupScheduleSlot, 'academyId' | 'groupId' | 'roomId' | 'teacherUserId'>,
    startAt: Date,
    endAt: Date,
    excludeId: string | undefined,
  ): Promise<{ code: ConflictCode; message: string; id?: string } | null> {
    const overlapping = (extra: Prisma.GroupSessionWhereInput) =>
      tx.groupSession.findFirst({
        where: {
          ...extra,
          status: { not: 'CANCELLED' },
          startAt: { lt: endAt },
          endAt: { gt: startAt },
          ...(excludeId ? { id: { not: excludeId } } : {}),
        },
        select: { id: true, academyId: true },
      });
    const own = (hit: { id: string; academyId: string }) =>
      hit.academyId === slot.academyId ? hit.id : undefined;
    const g = await overlapping({ groupId: slot.groupId });
    if (g) return { code: 'GROUP_CONFLICT', message: 'group conflict', id: own(g) };
    if (slot.roomId) {
      const r = await overlapping({ roomId: slot.roomId });
      if (r) return { code: 'ROOM_CONFLICT', message: 'room conflict', id: own(r) };
    }
    if (slot.teacherUserId) {
      const t = await overlapping({ teacherUserId: slot.teacherUserId });
      if (t) return { code: 'TEACHER_CONFLICT', message: 'teacher conflict', id: own(t) };
      const live = await tx.liveSession.findMany({
        where: {
          teacherUserId: slot.teacherUserId,
          status: { not: 'ENDED' },
          startsAt: { lt: endAt },
        },
        select: { id: true, academyId: true, startsAt: true, durationMin: true },
      });
      const clash = live.find(
        (l) => l.startsAt.getTime() + l.durationMin * 60_000 > startAt.getTime(),
      );
      if (clash)
        return {
          code: 'TEACHER_CONFLICT',
          message: 'teacher conflict — a live session overlaps this time',
          id: clash.academyId === slot.academyId ? clash.id : undefined,
        };
    }
    return null;
  }

  // ── Validation ──────────────────────────────────────────────────────────

  /**
   * The stored shape of a slot after this request: validated against the
   * academy (room here and not archived; teacher an assignable teacher of this
   * academy who is on the group — the same rules as a one-off class) and
   * against itself (a room means the Center; physical needs a location type).
   */
  private async resolveShape(
    ctx: AcademyContext,
    groupId: string,
    dto: CreateSlotDto | UpdateSlotDto,
    existing: GroupScheduleSlot | undefined,
    today: string,
  ) {
    const startMinute =
      dto.startTime !== undefined ? parseClock(dto.startTime) : (existing?.startMinute ?? null);
    if (startMinute == null)
      throw new BadRequestException({
        message: 'Start time is required',
        code: 'VALIDATION_FAILED',
        field: 'startTime',
      });
    const weekday = dto.weekday ?? existing?.weekday;
    const durationMin = dto.durationMin ?? existing?.durationMin;
    if (weekday == null || durationMin == null)
      throw new BadRequestException({
        message: 'Weekday and duration are required',
        code: 'VALIDATION_FAILED',
      });

    const roomId = dto.roomId !== undefined ? dto.roomId : (existing?.roomId ?? null);
    const teacherUserId =
      dto.teacherUserId !== undefined ? dto.teacherUserId : (existing?.teacherUserId ?? null);
    let locationType: SessionLocationType | null =
      dto.locationType !== undefined ? dto.locationType : (existing?.locationType ?? null);
    if (roomId && !locationType) locationType = 'CENTER';
    const locationNote =
      dto.locationNote !== undefined ? dto.locationNote : (existing?.locationNote ?? null);

    if (roomId) {
      const room = await this.prisma.room.findFirst({
        where: { id: roomId, academyId: ctx.academyId },
      });
      if (!room)
        throw new NotFoundException({
          message: 'Room not found',
          code: 'ROOM_NOT_FOUND',
          field: 'roomId',
        });
      if (room.status === 'ARCHIVED')
        throw new BadRequestException({
          message: 'This room is archived',
          code: 'ROOM_ARCHIVED',
          field: 'roomId',
        });
      if (locationType !== 'CENTER')
        throw new BadRequestException({
          message: 'A room means the session is at the Center',
          code: 'ROOM_NEEDS_CENTER_LOCATION',
        });
    }
    if (!locationType)
      throw new BadRequestException({
        message: 'A physical class needs a place',
        code: 'LOCATION_REQUIRED',
        field: 'locationType',
      });
    if (teacherUserId) {
      await this.academy.assertAssignableTeacher(ctx.academyId, teacherUserId);
      const isOwnerSelf = ctx.role === 'OWNER' && teacherUserId === ctx.userId;
      if (!isOwnerSelf) {
        const assigned = await this.prisma.groupAssignment.findFirst({
          where: { groupId, userId: teacherUserId },
          select: { id: true },
        });
        if (!assigned)
          throw new BadRequestException({
            message: 'That user is not assigned to this group',
            code: 'TEACHER_NOT_IN_GROUP',
            field: 'teacherUserId',
          });
      }
    }
    const validFrom = dto.validFrom ?? (existing ? dateKey(existing.validFrom) : today);
    const validTo =
      dto.validTo !== undefined
        ? dto.validTo
        : existing?.validTo
          ? dateKey(existing.validTo)
          : null;
    if (validTo && validTo < validFrom)
      throw new BadRequestException({
        message: 'The end date is before the start date',
        code: 'END_BEFORE_START',
        field: 'validTo',
      });
    return {
      weekday,
      startMinute,
      durationMin,
      roomId,
      teacherUserId,
      locationType,
      locationNote,
      validFrom: dateValue(validFrom),
      validTo: validTo ? dateValue(validTo) : null,
    };
  }

  private async findSlot(ctx: AcademyContext, slotId: string) {
    const slot = await this.prisma.groupScheduleSlot.findFirst({
      where: { id: slotId, academyId: ctx.academyId },
    });
    if (!slot)
      throw new NotFoundException({ message: 'Timetable line not found', code: 'SLOT_NOT_FOUND' });
    return slot;
  }

  private lockSlot(tx: Db, slotId: string) {
    return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('class-slot'), hashtext(${slotId}))`;
  }

  private changedKeys(dto: UpdateSlotDto) {
    return Object.keys(dto).filter((k) => k !== 'dryRun');
  }

  /** The exclusion constraints, surfaced as the same structured conflict. */
  private translate(e: unknown): unknown {
    if (
      e instanceof Prisma.PrismaClientUnknownRequestError ||
      e instanceof Prisma.PrismaClientKnownRequestError
    ) {
      const msg = String((e as { message?: string }).message ?? e);
      const map: Record<string, ConflictCode> = {
        GroupSession_room_no_overlap: 'ROOM_CONFLICT',
        GroupSession_teacher_no_overlap: 'TEACHER_CONFLICT',
        GroupSession_group_no_overlap: 'GROUP_CONFLICT',
      };
      for (const [constraint, code] of Object.entries(map))
        if (msg.includes(constraint)) return new ScheduleConflictError(code, `${code} — overlap`);
    }
    return e;
  }
}
