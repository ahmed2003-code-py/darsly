import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AcademyService } from '../academy/academy.service';
import { LivePipelineStatus, LiveSessionStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { GamificationService } from '../gamification/gamification.service';
import { LIVE_MAX_DURATION_MIN } from './live-timing';
import { validateLiveSession } from '@darsly/shared-types';
import { pipelineStages } from './live-pipeline';
import { recordingStage } from './recording/recording-stage';
import { LiveProviders } from './providers/live-providers';
import type { LiveProviderKind, RoomCloseResult } from './providers/live-provider';
import { RealtimeService } from '../realtime/realtime.service';
import { AiJobService } from '../academy-site/jobs/ai-job.service';

/** How long before the scheduled time the doors open. */
export const JOIN_OPENS_MIN = 15;
/**
 * The dialect the provider is asked to listen for. This is an Egyptian
 * platform, and the recogniser has an Egyptian model: "ar" hears Modern
 * Standard Arabic, which is not what anyone teaches a class in.
 */
const ARABIC_LESSON = 'ar-EG';
/**
 * How long a silence may last before it counts as absence rather than a
 * stutter. Comfortably longer than the heartbeat interval, so one dropped
 * request does not cost a student the minutes they were actually sitting there.
 */
export const PRESENCE_GRACE_SEC = 90;
/**
 * How long a summary may say PROCESSING with no job behind it before it counts
 * as abandoned — a worker that died on its last attempt, or a process killed
 * between claiming the summary and queueing it. Far longer than the moment
 * between those two steps, so a second press of the button never mistakes a
 * request still being made for one that was lost.
 */
export const SUMMARY_STALE_MS = 2 * 60_000;
export { LIVE_MAX_DURATION_MIN } from './live-timing';

/** Why a class ended — the teacher, the clock, or a cancellation. */
export type LiveEndReason = 'MANUAL' | 'SCHEDULED_END' | 'CANCELLED';
/**
 * How long after a class's end its "ended" events are still worth sending.
 * A backlog of classes nobody ended (before the end sweep existed) is closed
 * quietly — nobody is sitting in those rooms.
 */
const END_ANNOUNCE_WINDOW_MS = 30 * 60_000;
/**
 * What counts as having attended, for the LIVE_ATTENDED reward.
 *
 * A share of the class, the same idea a recorded lesson uses (90% watched
 * completes it — see PlaybackService), but capped at an absolute amount: a
 * two-hour revision session should not ask for an hour before it counts, and a
 * short class should not be unreachable for someone who joined a minute late.
 * The threshold is min(LIVE_ATTENDED_MIN_SECONDS, LIVE_ATTENDED_MIN_SHARE ×
 * the session's current length) — so an extension raises it with the class.
 * Counted from accumulated heartbeat time, across reconnects.
 */
export const LIVE_ATTENDED_MIN_SECONDS = 10 * 60;
export const LIVE_ATTENDED_MIN_SHARE = 0.5;
export function liveAttendedThresholdSec(durationMin: number): number {
  return Math.min(LIVE_ATTENDED_MIN_SECONDS, Math.ceil(durationMin * 60 * LIVE_ATTENDED_MIN_SHARE));
}

/** What a client needs to draw the clock, always from the server's own time. */
export interface LiveTiming {
  sessionId: string;
  status: LiveSessionStatus;
  startsAt: Date;
  /** When the teacher actually opened the room; null before that. */
  startedAt: Date | null;
  /** The session's effective end (scheduled end, as extended). */
  endsAt: Date;
  /** The server's clock at the moment this was produced — for drift. */
  serverNow: Date;
}

export interface UpsertLiveDto {
  title: string;
  description?: string;
  startsAt: string;
  durationMin?: number;
  capacity?: number | null;
  courseId?: string | null;
  joinUrl?: string | null;
  /** The teacher who runs it; defaults to the caller when they are a teacher. Validated server-side. */
  teacherUserId?: string | null;
  /** Restricts the audience to one group of the academy. */
  groupId?: string | null;
}

/**
 * Who is acting on live sessions and where. Built by the controller from the
 * validated AcademyContext — never from the body. OWNER (incl. platform
 * admin) reaches every stream in the academy; a TEACHER member only their
 * own. tenantId (authorship) is derived from the assigned teacher's profile.
 */
export interface LiveScope {
  academyId: string;
  userId: string;
  manageAll: boolean;
  role: string;
}

@Injectable()
export class LiveService {
  private readonly logger = new Logger(LiveService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly gamification: GamificationService,
    private readonly providers: LiveProviders,
    private readonly realtime: RealtimeService,
    private readonly jobs: AiJobService,
    private readonly academy: AcademyService,
  ) {}

  // ── Teacher ────────────────────────────────────────────────────────────────

  /**
   * The product's rules for a session (LIVE_SESSION_RULES, shared with the
   * form). Every broken rule is returned at once, each naming its field and a
   * code the form turns into a sentence under that field.
   */
  private assertValidSession(
    dto: Partial<UpsertLiveDto>,
    opts: { creating: boolean; checkPast: boolean },
  ) {
    const errors = validateLiveSession(
      {
        title: dto.title ?? (opts.creating ? '' : 'xx'),
        description: dto.description ?? '',
        startsAt: dto.startsAt ?? (opts.creating ? null : new Date().toISOString()),
        durationMin: dto.durationMin ?? 60,
        capacity: dto.capacity ?? null,
      },
      opts.checkPast ? Date.now() : -Infinity,
    );
    if (errors.length) {
      throw new BadRequestException({
        message: 'Some fields are invalid',
        code: 'LIVE_SESSION_INVALID',
        fields: errors,
      });
    }
  }

  async create(scope: LiveScope, dto: UpsertLiveDto) {
    this.assertValidSession(dto, { creating: true, checkPast: true });
    // The stream's teacher: named explicitly, or the caller when they are a
    // teacher themselves. STAFF must name one — they can schedule, never teach.
    const teacher = await this.academy.assertAssignableTeacher(
      scope.academyId,
      dto.teacherUserId ?? scope.userId,
    );
    const groupId = await this.resolveGroup(scope, dto.groupId ?? null, teacher.userId);
    const startsAt = new Date(dto.startsAt);
    const durationMin = dto.durationMin ?? 60;
    await this.assertTeacherFree(scope, teacher.userId, startsAt, durationMin);
    const session = await this.prisma.liveSession.create({
      data: {
        tenantId: teacher.teacherProfileId,
        academyId: scope.academyId,
        teacherUserId: teacher.userId,
        groupId,
        title: dto.title.trim(),
        description: dto.description ?? '',
        startsAt,
        durationMin,
        capacity: dto.capacity ?? null,
        courseId: dto.courseId ?? null,
        joinUrl: dto.joinUrl ?? null,
        // Fixed here, for the life of the class: a later change to
        // LIVE_PROVIDER moves new classes, never this one.
        provider: this.providers.defaultKind,
      },
    });
    await this.announceToStudents(session, session.title, session.startsAt);
    return session;
  }

  /** A group must be offered in this academy, and the teacher must be assigned to it (an OWNER may take their own group unassigned). */
  private async resolveGroup(
    scope: LiveScope,
    groupId: string | null,
    teacherUserId: string,
  ): Promise<string | null> {
    if (!groupId) return null;
    const group = await this.prisma.group.findFirst({
      where: { id: groupId, academyId: scope.academyId },
      select: { id: true },
    });
    if (!group) throw new NotFoundException('Group not found');
    const ownerSelf = scope.role === 'OWNER' && teacherUserId === scope.userId;
    if (!ownerSelf) {
      const assigned = await this.prisma.groupAssignment.findFirst({
        where: { groupId, userId: teacherUserId },
        select: { id: true },
      });
      if (!assigned) throw new BadRequestException('That teacher is not assigned to this group');
    }
    return groupId;
  }

  /**
   * A person cannot be in two places at once — physical or online, in any
   * academy. GroupSession already enforces this against itself at the DB
   * level; this is the application-level bridge across the two tables.
   * A colliding session from another academy is reported by kind only.
   */
  private async assertTeacherFree(
    scope: LiveScope,
    teacherUserId: string,
    startsAt: Date,
    durationMin: number,
    excludeId?: string,
  ) {
    const endsAt = new Date(startsAt.getTime() + durationMin * 60_000);
    const group = await this.prisma.groupSession.findFirst({
      where: {
        teacherUserId,
        status: { not: 'CANCELLED' },
        startAt: { lt: endsAt },
        endAt: { gt: startsAt },
      },
      select: { id: true, academyId: true },
    });
    if (group) {
      throw new ConflictException({
        message: 'The teacher already has a session in this window',
        code: 'TEACHER_CONFLICT',
        conflictingSessionId: group.academyId === scope.academyId ? group.id : undefined,
      });
    }
    const others = await this.prisma.liveSession.findMany({
      where: {
        teacherUserId,
        status: { not: 'ENDED' },
        ...(excludeId ? { id: { not: excludeId } } : {}),
        startsAt: { lt: endsAt },
      },
      select: { id: true, academyId: true, startsAt: true, durationMin: true },
    });
    const clash = others.find(
      (o) => new Date(o.startsAt.getTime() + o.durationMin * 60_000) > startsAt,
    );
    if (clash) {
      throw new ConflictException({
        message: 'The teacher already has a live session in this window',
        code: 'TEACHER_CONFLICT',
        conflictingSessionId: clash.academyId === scope.academyId ? clash.id : undefined,
      });
    }
  }

  async update(scope: LiveScope, id: string, dto: Partial<UpsertLiveDto>) {
    const existing = await this.assertOwned(scope, id);
    // A start time is only refused for being in the past when it is the thing
    // being changed: renaming yesterday's class is not rescheduling it.
    this.assertValidSession(dto, {
      creating: false,
      checkPast:
        dto.startsAt != null && new Date(dto.startsAt).getTime() !== existing.startsAt.getTime(),
    });
    let teacher: { userId: string; teacherProfileId: string } | null = null;
    if (dto.teacherUserId != null && dto.teacherUserId !== existing.teacherUserId) {
      teacher = await this.academy.assertAssignableTeacher(scope.academyId, dto.teacherUserId);
    }
    const teacherUserId = teacher?.userId ?? existing.teacherUserId;
    const groupId =
      dto.groupId !== undefined
        ? await this.resolveGroup(scope, dto.groupId, teacherUserId ?? scope.userId)
        : existing.groupId;
    const startsAt = dto.startsAt != null ? new Date(dto.startsAt) : existing.startsAt;
    const durationMin = dto.durationMin ?? existing.durationMin;
    // A class that is running has a room whose expiry was set from its timing.
    // Editing the timing here would move Darsly's clock and not Daily's — the
    // room would still eject everyone at the old time. The one way to change a
    // running class's length is `extend`, which moves both.
    const timingChanged =
      startsAt.getTime() !== existing.startsAt.getTime() || durationMin !== existing.durationMin;
    if (timingChanged && existing.status === 'LIVE' && existing.roomName) {
      throw new ConflictException({
        message: 'The class is running — extend it instead of editing its time',
        code: 'LIVE_TIMING_LOCKED',
      });
    }
    if (teacherUserId && (teacher || dto.startsAt != null || dto.durationMin != null)) {
      await this.assertTeacherFree(scope, teacherUserId, startsAt, durationMin, id);
    }
    return this.prisma.liveSession.update({
      where: { id },
      data: {
        ...(teacher ? { tenantId: teacher.teacherProfileId, teacherUserId: teacher.userId } : {}),
        ...(dto.groupId !== undefined ? { groupId } : {}),
        ...(dto.title != null ? { title: dto.title.trim() } : {}),
        ...(dto.description != null ? { description: dto.description } : {}),
        ...(dto.startsAt != null ? { startsAt: new Date(dto.startsAt) } : {}),
        ...(dto.durationMin != null ? { durationMin: dto.durationMin } : {}),
        ...(dto.capacity !== undefined ? { capacity: dto.capacity } : {}),
        ...(dto.courseId !== undefined ? { courseId: dto.courseId } : {}),
        ...(dto.joinUrl !== undefined ? { joinUrl: dto.joinUrl } : {}),
      },
    });
  }

  /**
   * The teacher calls a session off.
   *
   * Still a soft delete — the row, its bookings and its attendance all stay,
   * because they are the record of who was promised what. What changed is
   * everything around it: the cancellation is stamped with its time and
   * reason, the students who booked are told (they used to find out by the
   * session silently vanishing from their list), a class that was running is
   * closed properly instead of left with an open room until it expired, and
   * the act is written to the audit log.
   *
   * A session whose time has already passed is just tidied away: nobody is
   * waiting for it, so nobody is notified.
   */
  async remove(scope: LiveScope, id: string, actorUserId?: string, reason?: string) {
    const session = await this.assertOwned(scope, id);
    const now = new Date();
    // A room is open for any LIVE session — including one whose time is up but
    // the end sweep has not reached yet.
    const wasLive = session.status === 'LIVE';
    const stillAhead = session.status !== 'ENDED' && !this.pastWindow(session);
    const why = reason?.trim().slice(0, 500) || null;

    // Close the class first, through the same path every end takes: the room
    // is deleted (everyone in it removed) and attendance closed, or — if the
    // provider refuses — nothing is written and the cancellation can be tried
    // again, rather than a cancelled session with a room still running.
    if (wasLive) await this.endSession(id, 'CANCELLED');

    // One write: the stamp, the reason, and the soft delete itself. Setting
    // `deletedAt` here is exactly what the middleware's delete would do, and
    // doing it in the same statement means there is no moment where a session
    // is cancelled but still listed, or listed as deleted with no reason.
    await this.prisma.liveSession.update({
      where: { id },
      data: {
        cancelledAt: now,
        cancelReason: why,
        deletedAt: now,
      },
    });
    if (wasLive) {
      this.realtime.emitToLive(id, 'live:ended', { sessionId: id, cancelled: true });
    }

    const booked = stillAhead
      ? await this.prisma.liveBooking.findMany({
          where: { sessionId: id },
          select: { student: { select: { userId: true } } },
        })
      : [];
    for (const b of booked) {
      // The same event the list already listens on, so it drops the card
      // without a reload. `cancelled` lets a page tell the two apart.
      this.realtime.emitToUser(b.student.userId, 'live:ended', { sessionId: id, cancelled: true });
    }
    await Promise.all(
      booked.map((b) =>
        this.notifications.create({
          userId: b.student.userId,
          type: 'LIVE_SESSION_REMINDER',
          title: 'الجلسة المباشرة اتلغت ❌',
          body: why
            ? `«${session.title}» اتلغت. السبب: ${why}`
            : `«${session.title}» اتلغت من المدرّس.`,
          meta: { sessionId: id, cancelled: true },
        }),
      ),
    );

    await this.prisma.auditLog
      .create({
        data: {
          actorUserId: actorUserId ?? scope.userId,
          action: 'live.cancel',
          entity: 'LiveSession',
          entityId: id,
          academyId: session.academyId ?? session.tenantId,
          meta: {
            reason: why,
            wasLive,
            notified: booked.length,
            startsAt: session.startsAt.toISOString(),
          } as never,
        },
      })
      .catch(() => undefined);
    return { id, deleted: true, cancelledAt: now, notified: booked.length };
  }

  async listForTeacher(scope: LiveScope) {
    const sessions = await this.prisma.liveSession.findMany({
      where: this.scopeWhere(scope),
      orderBy: { startsAt: 'asc' },
      include: { _count: { select: { bookings: true } } },
    });
    return sessions.map((s) => ({ ...s, bookedCount: s._count.bookings }));
  }

  async bookingsFor(scope: LiveScope, id: string) {
    await this.assertOwned(scope, id);
    const rows = await this.prisma.liveBooking.findMany({
      where: { sessionId: id },
      orderBy: { createdAt: 'asc' },
      include: { student: { select: { user: { select: { fullName: true, phone: true } } } } },
    });
    return rows.map((r) => ({
      id: r.id,
      fullName: r.student.user.fullName,
      phone: r.student.user.phone,
      bookedAt: r.createdAt,
    }));
  }

  // ── Student ────────────────────────────────────────────────────────────────

  /**
   * Upcoming sessions in the academies the student is actively enrolled with —
   * a group-scoped stream only for that group's members, an academy-wide one
   * for every enrolled student there.
   */
  async upcomingForStudent(userId: string) {
    const student = await this.studentOf(userId);
    const academyIds = await this.enrolledAcademyIds(student.id);
    if (!academyIds.length) return [];
    const groupIds = (
      await this.prisma.groupMembership.findMany({
        where: { studentId: student.id },
        select: { groupId: true },
      })
    ).map((g) => g.groupId);

    const sessions = await this.prisma.liveSession.findMany({
      where: {
        academyId: { in: academyIds },
        OR: [{ groupId: null }, { groupId: { in: groupIds } }],
        startsAt: { gte: new Date(Date.now() - 2 * 3600_000) },
      },
      orderBy: { startsAt: 'asc' },
      include: {
        teacher: { select: { slug: true, user: { select: { fullName: true } } } },
        _count: { select: { bookings: true } },
        bookings: { where: { studentId: student.id }, select: { id: true } },
      },
    });
    return sessions.map((s) => this.studentView(s, s.bookings.length > 0));
  }

  async book(userId: string, sessionId: string) {
    const student = await this.studentOf(userId);
    const session = await this.prisma.liveSession.findUnique({
      where: { id: sessionId },
      include: { _count: { select: { bookings: true } } },
    });
    if (!session || session.deletedAt) throw new NotFoundException('Session not found');
    await this.assertEnrolledWith(student.id, session);

    const already = await this.prisma.liveBooking.findUnique({
      where: { sessionId_studentId: { sessionId, studentId: student.id } },
    });
    if (already) return { ok: true, alreadyBooked: true };

    // Capacity must be enforced atomically — a plain count-then-insert lets two
    // concurrent bookings both pass the check and overbook. Serializable makes
    // Postgres abort one of two conflicting count+insert pairs; we retry, and by
    // then the count reflects the other booking so capacity holds.
    const capacity = session.capacity;
    let inserted = false;
    for (let attempt = 0; attempt < 4 && !inserted; attempt++) {
      try {
        await this.prisma.$transaction(
          async (tx) => {
            if (capacity != null) {
              const count = await tx.liveBooking.count({ where: { sessionId } });
              if (count >= capacity) {
                throw new BadRequestException({ message: 'Session is full', code: 'SESSION_FULL' });
              }
            }
            await tx.liveBooking.create({ data: { sessionId, studentId: student.id } });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        inserted = true;
      } catch (e) {
        // A unique-violation means this student already booked in a race → done.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          return { ok: true, alreadyBooked: true };
        }
        // Serialization conflict → retry; on the last attempt, surface as busy.
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2034' &&
          attempt < 3
        ) {
          continue;
        }
        throw e;
      }
    }

    // Notify the teacher.
    const teacher = await this.prisma.teacherProfile.findUnique({
      where: { id: session.tenantId },
      select: { userId: true },
    });
    if (teacher) {
      await this.notifications.create({
        userId: teacher.userId,
        type: 'LIVE_SESSION_REMINDER',
        title: 'حجز جديد لجلسة مباشرة 📅',
        body: `${student.user.fullName} حجز مقعده في «${session.title}».`,
        meta: { sessionId },
      });
    }
    return { ok: true };
  }

  /**
   * A student gives their seat back.
   *
   * Only while the session is still ahead of them. Once the class has begun —
   * the teacher opened the room, or the scheduled time arrived — the booking is
   * no longer a reservation but the record the attendance, the recording's
   * audience and any later refund are read from, and deleting it would erase
   * that history. Before then it is released exactly as it always was, so the
   * seat goes back to the pool.
   */
  async cancel(userId: string, sessionId: string) {
    const student = await this.studentOf(userId);
    const booking = await this.prisma.liveBooking.findUnique({
      where: { sessionId_studentId: { sessionId, studentId: student.id } },
      include: { session: { select: { startsAt: true, status: true, deletedAt: true } } },
    });
    if (!booking) return { ok: true };
    // The teacher already called it off: the booking stays as the record of
    // that, and there is nothing left for the student to cancel.
    if (booking.session.deletedAt) return { ok: true };
    if (
      booking.session.status !== 'SCHEDULED' ||
      Date.now() >= booking.session.startsAt.getTime()
    ) {
      throw new ConflictException({
        message: 'لا يمكن إلغاء الحجز بعد بدء الحصة',
        code: 'CANCEL_WINDOW_CLOSED',
      });
    }
    await this.prisma.liveBooking.deleteMany({ where: { id: booking.id } });
    return { ok: true };
  }

  /**
   * A booked student enters the classroom.
   *
   * Three things have to be true and the server checks all of them: they booked
   * it, the window is open, and the teacher has actually started — because
   * before that there is no room to enter, and a "join" button that leads
   * nowhere is worse than one that says what it is waiting for.
   */
  async join(userId: string, sessionId: string) {
    const student = await this.studentOf(userId);
    const booking = await this.prisma.liveBooking.findUnique({
      where: { sessionId_studentId: { sessionId, studentId: student.id } },
      include: { session: true },
    });
    if (!booking || booking.session.deletedAt)
      throw new ForbiddenException('You have not booked this session');
    const s = booking.session;
    this.assertWindowOpen(s);

    // No reward here. Being handed a token means being *allowed* in, not having
    // attended — LIVE_ATTENDED is paid from real heartbeat time (see
    // `heartbeat`), once the student has actually sat through enough of it.

    // A session the teacher pointed at Zoom keeps going to Zoom: this feature
    // did not take the old way away from anyone already using it.
    if (!s.roomName) {
      if (s.joinUrl)
        return {
          session: this.meetingSession(s),
          externalUrl: s.joinUrl,
          meeting: null,
          participant: { role: 'STUDENT' as const },
        };
      throw new BadRequestException({ message: 'المدرّس لم يبدأ الفصل بعد', code: 'NOT_STARTED' });
    }

    const meeting = await this.providers.forSession(s).participantAccess({
      session: { id: s.id, roomName: s.roomName, roomUrl: s.roomUrl },
      userName: student.user.fullName,
      userId,
      // The student is never an owner: that is what would let them mute and
      // remove the class, and it is decided here rather than asked for.
      role: 'STUDENT',
      endsAtMs: this.closesAt(s),
    });
    await this.markPresent(sessionId, userId, 'STUDENT');
    return {
      session: this.meetingSession(s),
      externalUrl: null,
      meeting,
      participant: { role: 'STUDENT' as const },
    };
  }

  // ── The meeting itself ─────────────────────────────────────────────────────

  /**
   * The teacher opens the classroom.
   *
   * Creating the room here rather than at scheduling time means a class that
   * never runs never books a room, and the room's own expiry can be set from a
   * start time that is now known rather than guessed at weeks out.
   *
   * One LIVE session per *teacher* at a time — counted on `tenantId`, the
   * teacher's own profile, not on the academy: two teachers in one Center can
   * each run a class at once, and one teacher cannot be live in two academies
   * at once. (This comment used to say "per academy"; the code has always
   * counted per teacher, and that is the rule.) Note this is deliberately *not*
   * `maxConcurrentSessions`, which despite the name governs how many devices a
   * student may be signed in from — borrowing it here would tie a teacher's
   * classroom to an anti-account-sharing setting that has nothing to do with it.
   */
  async start(scope: LiveScope, id: string, actorUserId: string) {
    const session = await this.assertOwned(scope, id);
    // Only the clock closes a session for good. Pressing "end for all" two
    // minutes into an hour-long class — by accident, or to clear a room that
    // went wrong — must not cost the teacher the other fifty-eight and force
    // every student to rebook. Inside its own window a class can be reopened,
    // which creates a fresh room because the old one was deleted on the way out.
    if (this.pastWindow(session)) {
      throw new BadRequestException({ message: 'انتهت هذه الجلسة', code: 'ENDED' });
    }
    if (Date.now() < session.startsAt.getTime() - JOIN_OPENS_MIN * 60_000) {
      throw new BadRequestException({
        message: `يمكن بدء الفصل قبل الموعد بـ${JOIN_OPENS_MIN} دقيقة`,
        code: 'TOO_EARLY',
      });
    }

    // Already running: starting twice is the same room, not a second one. This
    // is the refresh case and the two-tabs case, and both should just work. A
    // session that was ended has no room any more, so it falls through and
    // gets a new one.
    if (session.status === 'LIVE' && session.roomName) {
      return this.teacherEntry(session, actorUserId);
    }

    // Claim the "one live session" slot and the LIVE status in one statement,
    // so two taps a millisecond apart cannot both win it.
    const claimed = await this.prisma.liveSession.updateMany({
      where: { id, academyId: scope.academyId, status: { not: 'LIVE' }, deletedAt: null },
      // `endedAt` is cleared on the way back in, so a reopened class does not
      // carry a finish time from the run before it.
      data: { status: 'LIVE', startedAt: new Date(), endedAt: null },
    });
    if (claimed.count === 0) {
      const fresh = await this.assertOwned(scope, id);
      return this.teacherEntry(fresh, actorUserId);
    }
    const otherLive = await this.prisma.liveSession.count({
      where: { tenantId: session.tenantId, status: 'LIVE', id: { not: id }, deletedAt: null },
    });
    if (otherLive > 0) {
      // Hand the slot back rather than leaving two sessions claiming to be live.
      await this.prisma.liveSession.update({
        where: { id },
        data: { status: 'SCHEDULED', startedAt: null },
      });
      throw new BadRequestException({
        message: 'لديك فصل مباشر شغّال بالفعل. أنهِه أولاً.',
        code: 'ALREADY_LIVE',
      });
    }

    let room;
    try {
      // The session's own provider — fixed when it was created, never the
      // one configured today (see LiveProviders).
      room = await this.providers
        .forSession(session)
        .openRoom({ sessionId: id, startsAtMs: session.startsAt.getTime() });
    } catch (e) {
      // The provider is the one thing here that can fail for reasons of its
      // own. Put the session back where it was so the button can be pressed
      // again, rather than leaving it LIVE with no room behind it.
      await this.prisma.liveSession.update({
        where: { id },
        data: { status: 'SCHEDULED', startedAt: null },
      });
      throw e;
    }
    const updated = await this.prisma.liveSession.update({
      where: { id },
      data: { roomName: room.name, roomUrl: room.url },
    });
    await this.announceStart(updated);
    return this.teacherEntry(updated, actorUserId);
  }

  /** The teacher walks back into a class they already started. */
  async teacherJoin(scope: LiveScope, id: string, actorUserId: string) {
    const session = await this.assertOwned(scope, id);
    if (session.status !== 'LIVE' || !session.roomName) {
      throw new BadRequestException({ message: 'لم يبدأ الفصل بعد', code: 'NOT_STARTED' });
    }
    if (this.pastWindow(session)) {
      throw new BadRequestException({ message: 'انتهت هذه الجلسة', code: 'ENDED' });
    }
    return this.teacherEntry(session, actorUserId);
  }

  /** The teacher closes the classroom. Everyone still inside is checked out. */
  async end(scope: LiveScope, id: string) {
    await this.assertOwned(scope, id);
    const r = await this.endSession(id, 'MANUAL');
    return { id, status: 'ENDED' as const, endedAt: r.endedAt };
  }

  /**
   * The one way a class ends — the teacher's button, the end sweep at the
   * class's effective end, and a cancellation all come here.
   *
   * Under the session's row lock (so a manual end, the sweep on any replica,
   * a cancellation and an extension cannot interleave):
   *  1. already ENDED → nothing to do (idempotent; never ended twice);
   *  2. for SCHEDULED_END, the class must still be LIVE and its *current* end
   *     reached. This is what makes a stale trigger harmless: the end moved by
   *     an extension is read here, not remembered from earlier — 20:00 does
   *     not end a class that now runs to 20:15;
   *  3. the Daily room is deleted — which removes everyone in it within a
   *     couple of seconds (observed) — *before* anything is written. If the
   *     provider refuses, the transaction rolls back and the class stays LIVE,
   *     so the sweep (or the teacher) simply tries again; a room already gone
   *     counts as closed. Never "ENDED" with a meeting still running;
   *  4. status ENDED, and open attendance closed, at `endedAt` = the class's
   *     actual end (now, or its scheduled end if that already passed).
   * Then the room and the class are told — unless this is the quiet close of
   * an old class nobody ended.
   */
  async endSession(
    id: string,
    reason: LiveEndReason,
  ): Promise<{ outcome: 'ended' | 'already-ended' | 'not-due' | 'missing'; endedAt: Date | null }> {
    const r = await this.prisma.$transaction(
      async (tx) => {
        const [s] = await tx.$queryRaw<
          {
            id: string;
            tenantId: string;
            academyId: string | null;
            startsAt: Date;
            durationMin: number;
            status: LiveSessionStatus;
            roomName: string | null;
            provider: LiveProviderKind;
            deletedAt: Date | null;
            endedAt: Date | null;
          }[]
        >`SELECT id, "tenantId", "academyId", "startsAt", "durationMin", status::text AS status,
                 "roomName", provider::text AS provider, "deletedAt", "endedAt"
          FROM "LiveSession" WHERE id = ${id} FOR UPDATE`;
        if (!s) return { outcome: 'missing' as const, endedAt: null };
        if (s.status === 'ENDED') return { outcome: 'already-ended' as const, endedAt: s.endedAt };
        const scheduledEnd = this.closesAt(s);
        const now = Date.now();
        if (reason === 'SCHEDULED_END' && (s.status !== 'LIVE' || now < scheduledEnd)) {
          return { outcome: 'not-due' as const, endedAt: null };
        }
        let provider: RoomCloseResult | 'none' = 'none';
        if (s.status === 'LIVE' && s.roomName) {
          provider = await this.providers
            .forSession(s)
            .closeRoom({ sessionId: id, roomName: s.roomName });
        }
        const endedAt = new Date(Math.min(now, scheduledEnd));
        await tx.liveSession.update({ where: { id }, data: { status: 'ENDED', endedAt } });
        await tx.liveAttendance.updateMany({
          where: { sessionId: id, leftAt: null },
          data: { leftAt: endedAt },
        });
        return { outcome: 'ended' as const, endedAt, session: s, provider };
      },
      // Long enough for the provider call (10s) inside it.
      { timeout: 20_000, maxWait: 10_000 },
    );
    if (r.outcome !== 'ended' || !('session' in r)) {
      return { outcome: r.outcome, endedAt: r.endedAt };
    }
    if (r.provider === 'cleanup-pending' && r.session.roomName) {
      // Closed on our side already — nobody can join, push or pull. The
      // provider's own teardown runs now, outside the lock, and the end sweep
      // retries whatever this one does not finish.
      void this.cleanupRoom(r.session, r.session.roomName);
    }
    this.logger.log(
      `live.end liveSession=${id} academy=${r.session.academyId ?? r.session.tenantId} ` +
        `reason=${reason} endedAt=${r.endedAt.toISOString()} provider=${r.provider}`,
    );

    const recent = Date.now() - r.endedAt.getTime() <= END_ANNOUNCE_WINDOW_MS;
    // A cancellation announces itself (with `cancelled`) from `remove`.
    if (reason !== 'CANCELLED' && recent) {
      // Tell the room, and tell the class.
      //
      // Deleting the Daily room drops everyone's connection, but that is the
      // video going quiet — it is not an answer to "what happened?". Without
      // this, a student sat looking at a dead meeting, and the listing behind
      // it went on saying "live now" until they reloaded.
      this.realtime.emitToLive(id, 'live:ended', { sessionId: id });
      const booked = await this.prisma.liveBooking.findMany({
        where: { sessionId: id },
        select: { student: { select: { userId: true } } },
      });
      for (const b of booked) {
        // Their personal room, which they are in whether or not they were ever
        // inside the meeting — that is what the upcoming list listens on.
        this.realtime.emitToUser(b.student.userId, 'live:ended', { sessionId: id });
      }
    }
    return { outcome: 'ended', endedAt: r.endedAt };
  }

  /**
   * LIVE classes whose effective end has passed — what the end sweep closes.
   *
   * Bounded and indexed: `("status", "startsAt")` narrows it to LIVE sessions
   * that have started, which is the handful running now plus any backlog; the
   * end itself is then compared per row. Oldest first, a batch at a time.
   */
  async overdueLiveSessionIds(limit: number): Promise<string[]> {
    const at = Prisma.sql`(to_timestamp(${Date.now()}::double precision / 1000) AT TIME ZONE 'UTC')`;
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "LiveSession"
      WHERE status = 'LIVE' AND "deletedAt" IS NULL
        AND "startsAt" <= ${at}
        AND "startsAt" + make_interval(mins => "durationMin") <= ${at}
      ORDER BY "startsAt"
      LIMIT ${limit}`;
    return rows.map((r) => r.id);
  }

  /**
   * The provider's own teardown after a class closed with `cleanup-pending`.
   *
   * Outside the row lock and never able to reopen anything: the class is
   * already ENDED, and every way in checks that first. Failures are logged and
   * left for the end sweep, which asks each provider what is still pending.
   */
  async cleanupRoom(
    s: { id: string; provider?: LiveProviderKind | string | null },
    roomName: string,
  ): Promise<boolean> {
    const provider = this.providers.forSession(s);
    if (!provider.cleanup) return true;
    try {
      return await provider.cleanup({ sessionId: s.id, roomName });
    } catch (e) {
      this.logger.warn(`live.cleanup liveSession=${s.id} failed: ${(e as Error).message}`);
      return false;
    }
  }

  /** One pass of every provider's owed teardown (see LiveEndWorker). */
  async sweepProviderCleanups(limit: number): Promise<{ closed: number; pending: number }> {
    let closed = 0;
    let pending = 0;
    for (const p of this.providers.all()) {
      if (!p.sweepPending) continue;
      const r = await p.sweepPending(limit);
      closed += r.closed;
      pending += r.pending;
    }
    return { closed, pending };
  }

  /**
   * Make a running class longer.
   *
   * Darsly's end is the authority, and the class is ended by closing its room
   * at that end (`endSession`). The provider's room expiry is a safety TTL set
   * when the room was created, already past the longest end any class can
   * reach (LIVE_MAX_DURATION_MIN, enforced below) — so an extension is a
   * database change, and nothing at Daily has to move. (Moving it would not
   * help anyway: Daily fixes each participant's ejection time when they join,
   * and a later change to the room's `exp` does not reach them — observed.)
   *
   * Under the row lock, so two extensions, an extension and the end sweep, or
   * an extension and a manual end run one after another:
   *  - the class must be LIVE and its current end not yet reached — once it is
   *    over (by the clock, or ENDED) it is not brought back;
   *  - `expectedEndsAt` (what the page sends — the end it was showing): if the
   *    end already moved, TIMING_CHANGED with the current timing rather than
   *    a second extension the teacher did not ask for twice. Without it, each
   *    confirmed request adds its minutes: never a lost update;
   *  - never past LIVE_MAX_DURATION_MIN, nor into the teacher's next session.
   * Only after the commit is anyone told.
   */
  async extend(
    scope: LiveScope,
    id: string,
    minutes: number,
    opts: { expectedEndsAt?: string; actorUserId?: string } = {},
  ): Promise<LiveTiming> {
    // Scope first: a colleague's or another academy's class is a 404, before
    // any lock is taken.
    await this.assertOwned(scope, id);
    const before = { endsAt: 0 };
    const updated = await this.prisma.$transaction(async (tx) => {
      const [s] = await tx.$queryRaw<
        {
          id: string;
          tenantId: string;
          academyId: string | null;
          teacherUserId: string | null;
          startsAt: Date;
          durationMin: number;
          startedAt: Date | null;
          status: LiveSessionStatus;
          roomName: string | null;
          deletedAt: Date | null;
        }[]
      >`SELECT id, "tenantId", "academyId", "teacherUserId", "startsAt", "durationMin",
                 "startedAt", status::text AS status, "roomName", "deletedAt"
          FROM "LiveSession" WHERE id = ${id} FOR UPDATE`;
      if (!s || s.deletedAt) throw new NotFoundException('Session not found');
      if (s.status !== 'LIVE' || !s.roomName) {
        throw new BadRequestException({
          message: 'Only a class that is running can be extended',
          code: 'SESSION_NOT_LIVE',
        });
      }
      const oldEnd = this.closesAt(s);
      before.endsAt = oldEnd;
      // Over is over: at its end the class is closed, and an extension that
      // arrives after that moment does not reopen it.
      if (Date.now() >= oldEnd) {
        throw new BadRequestException({ message: 'انتهت هذه الجلسة', code: 'ENDED' });
      }
      if (opts.expectedEndsAt && new Date(opts.expectedEndsAt).getTime() !== oldEnd) {
        throw new ConflictException({
          message: 'The class was already extended',
          code: 'TIMING_CHANGED',
          timing: this.timingOf(s),
        });
      }
      const durationMin = s.durationMin + minutes;
      if (durationMin > LIVE_MAX_DURATION_MIN) {
        throw new BadRequestException({
          message: `A class cannot run longer than ${LIVE_MAX_DURATION_MIN} minutes`,
          code: 'EXTENSION_TOO_LONG',
          params: { max: LIVE_MAX_DURATION_MIN },
        });
      }
      // Still cannot be in two places at once.
      if (s.teacherUserId) {
        await this.assertTeacherFree(scope, s.teacherUserId, s.startsAt, durationMin, id);
      }
      await tx.liveSession.update({ where: { id }, data: { durationMin } });
      return { ...s, durationMin };
    });

    const timing = this.timingOf(updated);
    this.logger.log(
      `live.extend liveSession=${id} academy=${updated.academyId ?? updated.tenantId} ` +
        `teacher=${updated.teacherUserId} +${minutes}m ` +
        `oldEndsAt=${new Date(before.endsAt).toISOString()} newEndsAt=${timing.endsAt.toISOString()}`,
    );
    // Only now — once it is committed — is anyone told. The payload is absolute, so a client that reconnects later and
    // reads it from anywhere else gets the same answer.
    this.realtime.emitToLive(id, 'live:timing-updated', timing);
    await this.prisma.auditLog
      .create({
        data: {
          actorUserId: opts.actorUserId ?? scope.userId,
          action: 'live.extend',
          entity: 'LiveSession',
          entityId: id,
          academyId: updated.academyId ?? updated.tenantId,
          meta: {
            minutes,
            oldEndsAt: new Date(before.endsAt).toISOString(),
            newEndsAt: timing.endsAt.toISOString(),
          } as never,
        },
      })
      .catch(() => undefined);
    return timing;
  }

  /**
   * "I am still here."
   *
   * Duration is built from these rather than from `leftAt - joinedAt`, because
   * the browser cannot be relied on to announce its own departure — a closed
   * laptop, a dead battery and a tunnel all look the same from here. A gap
   * longer than the grace period is counted as absence, so the number means
   * time in the room rather than time since arriving.
   */
  async heartbeat(userId: string, sessionId: string) {
    const now = Date.now();
    // One statement, so it holds under every way heartbeats can collide.
    //
    // The old read-then-write let two requests — two tabs in step, a retried
    // request, two replicas — read the same `lastSeenAt` and both add the same
    // gap: sixty seconds of attendance for thirty real ones. Here Postgres
    // takes the row lock and, for a second UPDATE that waited on it,
    // re-evaluates the expressions against the row the first one wrote — so
    // the second sees a gap of ~0 and adds nothing. Works across replicas;
    // needs no lock of ours.
    //
    // The gap rule is unchanged: whole seconds since the last heartbeat, and a
    // gap longer than PRESENCE_GRACE_SEC is absence, credited as 0. New: the
    // credit stops at the session's effective end (its scheduled end as
    // extended, or when the teacher ended it) — a heartbeat after the class is
    // over counts nothing, never reopens the attendance row, and closes one left
    // open by a class that simply ran out of time (at the class's end). The clock
    // is the server's, passed in as epoch-ms so a non-UTC database session
    // cannot shift it; nothing the client sends is trusted.
    // The server's clock, as a UTC timestamp, bound as a parameter.
    const at = Prisma.sql`(to_timestamp(${now}::double precision / 1000) AT TIME ZONE 'UTC')`;
    // The session's effective end: its scheduled end as extended, or the
    // moment the teacher ended it if that came first.
    const effectiveEnd = Prisma.sql`(CASE
        WHEN s.status = 'ENDED' AND s."endedAt" IS NOT NULL
          THEN LEAST(s."endedAt", s."startsAt" + make_interval(mins => s."durationMin"))
        ELSE s."startsAt" + make_interval(mins => s."durationMin")
      END)`;
    const rows = await this.prisma.$queryRaw<
      {
        role: string;
        durationSeconds: number;
        tenantId: string;
        title: string;
        startsAt: Date;
        durationMin: number;
        startedAt: Date | null;
        status: LiveSessionStatus;
      }[]
    >`
      UPDATE "LiveAttendance" a
      SET "durationSeconds" = a."durationSeconds" + (CASE
            WHEN floor(extract(epoch FROM (${at} - a."lastSeenAt"))) BETWEEN 1 AND ${PRESENCE_GRACE_SEC}
            THEN GREATEST(0, floor(extract(epoch FROM (LEAST(${at}, ${effectiveEnd}) - a."lastSeenAt"))))::int
            ELSE 0
          END),
          "lastSeenAt" = GREATEST(a."lastSeenAt", ${at}),
          "leftAt" = CASE
            WHEN s.status = 'LIVE' AND s."deletedAt" IS NULL AND ${at} < ${effectiveEnd}
            THEN NULL
            -- Over: a row still open is closed at the class's end, never later.
            ELSE COALESCE(a."leftAt", LEAST(${at}, ${effectiveEnd})) END
      FROM "LiveSession" s
      WHERE a."sessionId" = ${sessionId} AND a."userId" = ${userId} AND s.id = a."sessionId"
      RETURNING a.role::text AS role, a."durationSeconds", s."tenantId", s.title,
        s."startsAt", s."durationMin", s."startedAt", s.status::text AS status
    `;
    const row = rows[0];
    if (!row) return { ok: false };
    if (row.role === 'STUDENT') {
      await this.maybeAwardAttendance(userId, sessionId, row);
    }
    return { ok: true, timing: this.timingOf({ id: sessionId, ...row }) };
  }

  /**
   * Pay LIVE_ATTENDED once the accumulated attendance crosses the threshold.
   *
   * Exactly once, by the gamification ledger's own unique key
   * (`LIVE_ATTENDED:{studentId}:{sessionId}`): two heartbeats crossing the
   * line together both try, the second collides and pays nothing. Attendance
   * is never rolled back for this — it was already committed above — and a
   * failed award is simply tried again by the next heartbeat, because only an
   * award that actually exists stops the retries.
   *
   * Cheap on the hot path: nothing at all below the threshold; above it, one
   * indexed lookup of the award by its key per heartbeat.
   */
  private async maybeAwardAttendance(
    userId: string,
    sessionId: string,
    row: { durationSeconds: number; durationMin: number; tenantId: string; title: string },
  ) {
    const threshold = liveAttendedThresholdSec(row.durationMin);
    if (row.durationSeconds < threshold) return;
    try {
      const student = await this.prisma.studentProfile.findUnique({
        where: { userId },
        select: { id: true },
      });
      if (!student) return;
      const key = `LIVE_ATTENDED:${student.id}:${sessionId}`;
      const paid = await this.prisma.gamificationEvent.findUnique({
        where: { idempotencyKey: key },
        select: { id: true },
      });
      if (paid) return;
      const outcome = await this.gamification.recordOrThrow({
        studentId: student.id,
        type: 'LIVE_ATTENDED',
        key,
        tenantId: row.tenantId,
        entityType: 'liveSession',
        entityId: sessionId,
        meta: { title: row.title, attendedSeconds: row.durationSeconds },
      });
      this.logger.log(
        `LIVE_ATTENDED liveSession=${sessionId} student=${student.id} ` +
          `seconds=${row.durationSeconds} threshold=${threshold} awarded=${outcome.awarded}`,
      );
    } catch (e) {
      this.logger.warn(
        `LIVE_ATTENDED award failed liveSession=${sessionId} user=${userId} ` +
          `seconds=${row.durationSeconds} — the next heartbeat will retry: ${(e as Error).message}`,
      );
    }
  }

  /** An explicit goodbye. Best-effort — `heartbeat` is what the count rests on. */
  async leave(userId: string, sessionId: string) {
    const now = new Date();
    await this.prisma.liveAttendance.updateMany({
      where: { sessionId, userId, leftAt: null },
      data: { leftAt: now, lastSeenAt: now },
    });
    return { ok: true };
  }

  // ── The classroom's chat ───────────────────────────────────────────────────

  /**
   * Everyone in the room can read it, and only they can.
   *
   * "In the room" is the same question the join gate answers — booked student
   * or the academy's own staff — so it is asked the same way rather than
   * invented again here.
   */
  async assertInSession(userId: string, sessionId: string) {
    const session = await this.prisma.liveSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        tenantId: true,
        academyId: true,
        deletedAt: true,
        teacher: { select: { userId: true } },
      },
    });
    if (!session || session.deletedAt) throw new NotFoundException('Session not found');
    if (session.teacher.userId === userId) return { session, role: 'TEACHER' as const };
    // Staff means a staff *role* — an ACTIVE membership with role STUDENT is a
    // learner, and must not be waved in as the teacher side of the room.
    const staff = await this.prisma.academyMembership.findFirst({
      where: {
        academyId: session.academyId ?? session.tenantId,
        userId,
        status: 'ACTIVE',
        role: { in: ['OWNER', 'TEACHER', 'ASSISTANT'] },
      },
      select: { id: true },
    });
    if (staff) return { session, role: 'TEACHER' as const };
    const student = await this.prisma.studentProfile.findUnique({
      where: { userId },
      select: { id: true },
    });
    const booked =
      student &&
      (await this.prisma.liveBooking.findUnique({
        where: { sessionId_studentId: { sessionId, studentId: student.id } },
        select: { id: true },
      }));
    if (!booked) throw new ForbiddenException('You are not in this session');
    return { session, role: 'STUDENT' as const };
  }

  async chatHistory(userId: string, sessionId: string) {
    await this.assertInSession(userId, sessionId);
    const rows = await this.prisma.liveChatMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
      take: 200,
      include: { user: { select: { id: true, fullName: true, role: true } } },
    });
    return rows.map((m) => this.chatView(m));
  }

  async sendChat(userId: string, sessionId: string, body: string) {
    const { session } = await this.assertInSession(userId, sessionId);
    const text = body.trim();
    if (!text) throw new BadRequestException('Empty message');
    const saved = await this.prisma.liveChatMessage.create({
      data: { sessionId, userId, body: text.slice(0, 2000) },
      include: { user: { select: { id: true, fullName: true, role: true } } },
    });
    const view = this.chatView(saved);
    // Same socket server the rest of the app uses; a room per session so a
    // message never reaches anyone who was not admitted to it.
    this.realtime.emitToLive(session.id, 'live:message', view);
    return view;
  }

  private chatView(m: {
    id: string;
    body: string;
    createdAt: Date;
    user: { id: string; fullName: string; role: string };
  }) {
    return {
      id: m.id,
      body: m.body,
      createdAt: m.createdAt,
      senderId: m.user.id,
      senderName: m.user.fullName,
      senderRole: m.user.role,
    };
  }

  // ── Recording ──────────────────────────────────────────────────────────────

  /**
   * The teacher records, and only deliberately.
   *
   * Daily starts the recording from the client — the owner token is what
   * permits it — so this records the intent and the id. The provider's own
   * state is asked for later, because a recording is not finished when the
   * class is.
   */
  async markRecording(scope: LiveScope, id: string, recordingId: string | null) {
    await this.assertOwned(scope, id);
    return this.prisma.liveSession.update({
      where: { id },
      data: {
        recordingStatus: 'PROCESSING',
        recordingId,
        recordingStartedAt: new Date(),
      },
      select: { id: true, recordingStatus: true, recordingStartedAt: true },
    });
  }

  /** Stopped. Processing continues at the provider for a while yet. */
  async stopRecording(scope: LiveScope, id: string) {
    await this.assertOwned(scope, id);
    return this.prisma.liveSession.update({
      where: { id },
      data: { recordingStatus: 'PROCESSING' },
      select: { id: true, recordingStatus: true },
    });
  }

  /**
   * A link to watch, minted now and expiring on its own.
   *
   * Never stored: a recording URL in a database row is a permanent public link
   * the first time that row is read by the wrong person.
   */
  async recordingLink(userId: string, sessionId: string) {
    const { session, role } = await this.assertInSession(userId, sessionId);
    const full = await this.prisma.liveSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        provider: true,
        recordingId: true,
        recordingStatus: true,
        summaryForStudents: true,
      },
    });
    if (full) full.recordingStatus = await this.refreshRecording(full);
    if (full?.provider === 'CLOUDFLARE') {
      // Darsly's own recording: packaged as encrypted HLS by the video
      // pipeline. Watching it goes through the lesson player, which is where
      // it will be published (Checkpoint C) — there is no provider link.
      throw new ConflictException({
        message: 'التسجيل اتحفظ وهيتاح للمشاهدة من خلال الكورس',
        code: 'RECORDING_PLAYBACK_PENDING',
      });
    }
    if (!full?.recordingId || full.recordingStatus !== 'READY') {
      throw new BadRequestException({ message: 'التسجيل مش جاهز', code: 'RECORDING_NOT_READY' });
    }
    // A student sees the recording on the same permission that shows them the
    // summary: the teacher decided this lesson is theirs to keep.
    if (role === 'STUDENT' && !full.summaryForStudents) {
      throw new ForbiddenException({
        message: 'التسجيل غير متاح للطلبة',
        code: 'RECORDING_NOT_SHARED',
      });
    }
    const link = await this.providers.forSession(full).recordings?.link(full.recordingId);
    if (!link)
      throw new BadRequestException({ message: 'التسجيل مش جاهز', code: 'RECORDING_NOT_READY' });
    void session;
    return link;
  }

  // ── Transcript and summary ─────────────────────────────────────────────────

  /**
   * Ask for a summary. Returns immediately; the work happens on the queue.
   *
   * Idempotent on purpose: pressing the button twice, or a webhook arriving
   * twice, must not spend two model calls on one lesson.
   *
   * The order matters, and it used to be wrong. The session was marked
   * PROCESSING and *then* the job was queued — so any refusal from the queue
   * (AI switched off, the month's budget spent, or another academy job the
   * old academy-wide lock counted as a clash) left the lesson reading
   * "processing" forever, and the button refused to try again because
   * PROCESSING is what it returns early on.
   *
   * Now: claim the summary with a compare-and-set from the state we read (two
   * presses cannot both queue a job), queue it, and if queueing is refused put
   * the state back exactly as it was and say why. A PROCESSING that has no job
   * behind it and has not moved for SUMMARY_STALE_MS is treated as lost and
   * may be claimed again — which also frees any lesson already stuck by the
   * old order.
   *
   * The job is billed to the session's own academy (a Center's summary is the
   * Center's spend, not the teacher's personal workspace's), and it only
   * clashes with another summary of the same lesson.
   */
  async requestSummary(scope: LiveScope, id: string) {
    const session = await this.assertOwned(scope, id);
    if (session.summaryStatus === 'READY') return { status: 'READY' as const };
    // A Cloudflare lesson's words come from Darsly's own transcript of its
    // recording. Without one there is nothing to summarise — refused here,
    // before a job is queued to fail with NO_TRANSCRIPT and spend a retry.
    if (session.provider === 'CLOUDFLARE' && !session.transcriptText?.trim()) {
      throw new ConflictException({
        message: 'The lesson transcript is not ready',
        code: 'TRANSCRIPT_NOT_READY',
      });
    }

    // A job for this lesson is already queued or running — typically the
    // queue's own retry after a failed attempt marked the lesson FAILED. That
    // job is the answer to this press too: say so, rather than queueing a
    // second one or refusing.
    if (await this.jobs.hasActiveJobFor('LIVE_SUMMARY', 'liveSessionId', id)) {
      await this.prisma.liveSession.updateMany({
        where: { id, summaryStatus: { not: 'READY' } },
        data: { summaryStatus: 'PROCESSING', summaryError: null },
      });
      return { status: 'PROCESSING' as const };
    }

    const previous = { status: session.summaryStatus, error: session.summaryError };
    let claimWhere: Prisma.LiveSessionWhereInput;
    if (session.summaryStatus === 'PROCESSING') {
      // Set a moment ago by a press whose job is still being queued.
      if (Date.now() - session.updatedAt.getTime() < SUMMARY_STALE_MS) {
        return { status: 'PROCESSING' as const };
      }
      claimWhere = {
        id,
        summaryStatus: 'PROCESSING',
        updatedAt: { lt: new Date(Date.now() - SUMMARY_STALE_MS) },
      };
    } else {
      claimWhere = { id, summaryStatus: session.summaryStatus };
    }

    const claimed = await this.prisma.liveSession.updateMany({
      where: claimWhere,
      data: { summaryStatus: 'PROCESSING', summaryError: null },
    });
    // Somebody else's press got there first; theirs is the one in flight.
    if (claimed.count === 0) return { status: 'PROCESSING' as const };

    try {
      await this.jobs.enqueue(
        session.academyId ?? session.tenantId,
        'LIVE_SUMMARY',
        { liveSessionId: id },
        { sameInput: { path: 'liveSessionId', equals: id } },
      );
    } catch (e) {
      // Put it back. A lesson that was never summarised goes back to "not
      // started"; one recovered from a lost PROCESSING becomes a plain failure
      // the teacher can retry, rather than a fresh-looking PROCESSING.
      const restore =
        previous.status === 'PROCESSING'
          ? { summaryStatus: 'FAILED' as const, summaryError: 'ENQUEUE_FAILED' }
          : { summaryStatus: previous.status, summaryError: previous.error };
      await this.prisma.liveSession.updateMany({
        where: { id, summaryStatus: 'PROCESSING' },
        data: restore,
      });
      throw e;
    }
    return { status: 'PROCESSING' as const };
  }

  /**
   * Whether a PROCESSING summary is really being worked on: a job for this
   * lesson is queued or running, or the status was set too recently for its
   * job to have been queued yet.
   */
  private async summaryInFlight(sessionId: string, updatedAt: Date): Promise<boolean> {
    if (Date.now() - updatedAt.getTime() < SUMMARY_STALE_MS) return true;
    return this.jobs.hasActiveJobFor('LIVE_SUMMARY', 'liveSessionId', sessionId);
  }

  /** The teacher decides whether the class gets to keep the notes. */
  async setSummaryVisibility(scope: LiveScope, id: string, visible: boolean) {
    await this.assertOwned(scope, id);
    const updated = await this.prisma.liveSession.update({
      where: { id },
      data: { summaryForStudents: visible },
      select: {
        id: true,
        summaryForStudents: true,
        summaryStatus: true,
        title: true,
        tenantId: true,
      },
    });
    if (visible && updated.summaryStatus === 'READY') {
      const booked = await this.prisma.liveBooking.findMany({
        where: { sessionId: id },
        select: { student: { select: { userId: true } } },
      });
      await Promise.all(
        booked.map((b) =>
          this.notifications.create({
            userId: b.student.userId,
            type: 'LIVE_SESSION_REMINDER',
            title: 'ملخّص الحصة جاهز 📝',
            body: `ملخّص «${updated.title}» بقى متاح ليك.`,
            meta: { sessionId: id, summary: true },
          }),
        ),
      );
    }
    return updated;
  }

  /**
   * Catch a finished recording up with the provider.
   *
   * A recording is still being processed when the class ends, and there is no
   * webhook telling us when that changes — so the question is asked the moment
   * somebody opens the page that would show it. Self-healing, and it costs one
   * request only while a recording is actually in flight.
   */
  private async refreshRecording(session: {
    id: string;
    provider: LiveProviderKind;
    recordingId: string | null;
    recordingStatus: LivePipelineStatus;
  }) {
    if (session.recordingStatus !== 'PROCESSING' || !session.recordingId)
      return session.recordingStatus;
    const remote = await this.providers.forSession(session).recordings?.status(session.recordingId);
    if (!remote) return session.recordingStatus;
    // Daily's own vocabulary; anything else means it is still working.
    const done = /finish|complete/i.test(remote.status);
    const failed = /fail|error|cancel/i.test(remote.status);
    if (!done && !failed) return session.recordingStatus;
    const next: LivePipelineStatus = done ? 'READY' : 'FAILED';
    await this.prisma.liveSession.update({
      where: { id: session.id },
      data: {
        recordingStatus: next,
        ...(remote.duration ? { recordingDuration: remote.duration } : {}),
      },
    });
    return next;
  }

  /** What a viewer is allowed to read about a finished session. */
  async sessionDetail(userId: string, sessionId: string) {
    const { role } = await this.assertInSession(userId, sessionId);
    const s = await this.prisma.liveSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: {
        id: true,
        title: true,
        startsAt: true,
        durationMin: true,
        status: true,
        provider: true,
        recordingStatus: true,
        recordingId: true,
        recordingDuration: true,
        summaryStatus: true,
        summary: true,
        summaryError: true,
        summaryForStudents: true,
        transcriptStatus: true,
        transcriptText: true,
        updatedAt: true,
      },
    });
    const recordingStatus = await this.refreshRecording(s);
    // Darsly's own recording (Cloudflare): its stage, not a bare status.
    const rec =
      s.provider === 'CLOUDFLARE'
        ? await this.prisma.liveRecording.findFirst({
            where: { sessionId },
            orderBy: { createdAt: 'desc' },
          })
        : null;
    const recStage = rec ? recordingStage(rec) : null;
    const canSeeSummary = role === 'TEACHER' || s.summaryForStudents;
    // A PROCESSING with nothing behind it is shown as the failure it is, so the
    // page offers "try again" instead of a spinner that never stops.
    let summaryStatus = s.summaryStatus;
    let summaryError = s.summaryError;
    if (summaryStatus === 'PROCESSING' && !(await this.summaryInFlight(s.id, s.updatedAt))) {
      summaryStatus = 'FAILED';
      summaryError = summaryError ?? 'STALLED';
    }
    const stages = pipelineStages({
      provider: s.provider,
      transcriptStatus: s.transcriptStatus,
      hasTranscriptText: !!s.transcriptText?.trim(),
      summaryStatus,
      summaryError,
      recordingStage: recStage?.stage ?? null,
    });
    return {
      id: s.id,
      title: s.title,
      startsAt: s.startsAt,
      durationMin: s.durationMin,
      status: this.effectiveStatus(s),
      role,
      provider: s.provider,
      recording: {
        status: recordingStatus,
        // What the page shows: REQUESTED → CAPTURING → FINALIZING →
        // PROCESSING → READY / FAILED (with a reason a teacher can read).
        stage:
          recStage?.stage ??
          (recordingStatus === 'PROCESSING'
            ? 'PROCESSING'
            : recordingStatus === 'READY'
              ? 'READY'
              : recordingStatus === 'FAILED'
                ? 'FAILED'
                : null),
        failure: recStage?.failure ?? (recordingStatus === 'FAILED' ? 'PROCESSING_FAILED' : null),
        durationSeconds: s.recordingDuration ?? (rec?.durationSec || null),
        // A student is told there is a recording only once it is theirs to see.
        available:
          recordingStatus === 'READY' &&
          s.provider !== 'CLOUDFLARE' &&
          (role === 'TEACHER' || s.summaryForStudents),
      },
      transcript: role === 'TEACHER' ? stages.transcript : null,
      summary: {
        stage: canSeeSummary ? stages.summary.stage : 'NOT_STARTED',
        canGenerate: role === 'TEACHER' && stages.summary.canGenerate,
        status: canSeeSummary ? summaryStatus : 'NOT_STARTED',
        data: canSeeSummary && summaryStatus === 'READY' ? s.summary : null,
        sharedWithStudents: s.summaryForStudents,
        // Only the teacher is told why, and only they can act on it.
        ...(role === 'TEACHER'
          ? { transcriptStatus: s.transcriptStatus, error: summaryError }
          : {}),
      },
    };
  }

  /**
   * The classroom reporting that transcription did not come up.
   *
   * Recorded because the alternative is a lie: without it, a lesson taught for
   * an hour with transcription switched off at the provider produces an empty
   * transcript, and the summary tells the teacher that nobody spoke. The
   * difference between "you said nothing" and "we could not listen" is the
   * difference between a puzzled teacher and an operator who knows to enable
   * transcription on the Daily account.
   */
  async reportTranscriptionFailure(scope: LiveScope, id: string) {
    await this.assertOwned(scope, id);
    await this.prisma.liveSession.update({
      where: { id },
      data: { transcriptStatus: 'FAILED' },
    });
    return { ok: true };
  }

  /** Who actually turned up, for the teacher's own session. */
  async attendanceFor(scope: LiveScope, id: string) {
    await this.assertOwned(scope, id);
    const rows = await this.prisma.liveAttendance.findMany({
      where: { sessionId: id },
      orderBy: { joinedAt: 'asc' },
      include: { user: { select: { fullName: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      fullName: r.user.fullName,
      role: r.role,
      joinedAt: r.joinedAt,
      leftAt: r.leftAt,
      durationSeconds: r.durationSeconds,
    }));
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** When the doors open, and when they shut. The server's clock, not the browser's. */
  private opensAt(s: { startsAt: Date }) {
    return s.startsAt.getTime() - JOIN_OPENS_MIN * 60_000;
  }
  private closesAt(s: { startsAt: Date; durationMin: number }) {
    return s.startsAt.getTime() + s.durationMin * 60_000;
  }
  private pastWindow(s: { startsAt: Date; durationMin: number }) {
    return Date.now() > this.closesAt(s);
  }

  /**
   * The status a session actually has right now.
   *
   * Stored status records what a person did; this adds what the clock did. A
   * class nobody remembered to end reads as ENDED once its window closes,
   * without a background job having to go round and tidy up.
   */
  private effectiveStatus(s: {
    status: LiveSessionStatus;
    startsAt: Date;
    durationMin: number;
  }): LiveSessionStatus {
    if (s.status === 'ENDED') return 'ENDED';
    if (this.pastWindow(s)) return 'ENDED';
    return s.status;
  }

  private assertWindowOpen(s: { startsAt: Date; durationMin: number; status: LiveSessionStatus }) {
    if (Date.now() < this.opensAt(s)) {
      throw new BadRequestException({
        message: `يفتح الفصل قبل الموعد بـ${JOIN_OPENS_MIN} دقيقة`,
        code: 'NOT_OPEN_YET',
      });
    }
    if (this.effectiveStatus(s) === 'ENDED') {
      throw new BadRequestException({ message: 'انتهت هذه الجلسة', code: 'ENDED' });
    }
  }

  /**
   * The language this academy teaches in.
   *
   * Already on the teacher's profile and set at sign-up, so the classroom does
   * not ask a question the platform has an answer to. Arabic when unset, which
   * is what most of this platform is.
   */
  private async lessonLanguage(tenantId?: string): Promise<string> {
    if (!tenantId) return ARABIC_LESSON;
    const t = await this.prisma.teacherProfile.findUnique({
      where: { id: tenantId },
      select: { language: true },
    });
    return t?.language === 'en' ? 'en' : ARABIC_LESSON;
  }

  /** The shape both sides of the classroom read the session from. */
  private meetingSession(s: {
    id: string;
    title: string;
    startsAt: Date;
    durationMin: number;
    status: LiveSessionStatus;
    startedAt?: Date | null;
  }) {
    return {
      id: s.id,
      title: s.title,
      startsAt: s.startsAt,
      durationMin: s.durationMin,
      status: this.effectiveStatus(s),
      endsAt: new Date(this.closesAt(s)),
      // Enough to draw both clocks without trusting the browser's own time:
      // elapsed from `startedAt`, remaining to `endsAt`, and `serverNow` to
      // correct for however far the device clock is off.
      startedAt: s.startedAt ?? null,
      serverNow: new Date(),
    };
  }

  /** The authoritative clock of one session, as every channel reports it. */
  private timingOf(s: {
    id: string;
    startsAt: Date;
    durationMin: number;
    status: LiveSessionStatus | string;
    startedAt?: Date | null;
  }): LiveTiming {
    const status = this.effectiveStatus({ ...s, status: s.status as LiveSessionStatus });
    return {
      sessionId: s.id,
      status,
      startsAt: s.startsAt,
      startedAt: s.startedAt ?? null,
      endsAt: new Date(this.closesAt(s)),
      serverNow: new Date(),
    };
  }

  /** The teacher's own way in: an owner token, which is what allows moderation. */
  private async teacherEntry(
    s: {
      id: string;
      tenantId?: string;
      title: string;
      startsAt: Date;
      durationMin: number;
      status: LiveSessionStatus;
      startedAt?: Date | null;
      roomName: string | null;
      roomUrl: string | null;
      provider?: LiveProviderKind | string | null;
    },
    actorUserId: string,
  ) {
    if (!s.roomName) {
      throw new BadRequestException({ message: 'لم يبدأ الفصل بعد', code: 'NOT_STARTED' });
    }
    // The name shown in the room comes from the account, not the request: a
    // display name a caller could choose is a display name they could borrow.
    const actor = await this.prisma.user.findUnique({
      where: { id: actorUserId },
      select: { fullName: true },
    });
    const meeting = await this.providers.forSession(s).participantAccess({
      session: { id: s.id, roomName: s.roomName, roomUrl: s.roomUrl },
      userName: actor?.fullName ?? 'المدرّس',
      userId: actorUserId,
      role: 'TEACHER',
      endsAtMs: this.closesAt(s),
      // What language to listen for. Transcription was starting with no
      // language at all, so the provider assumed English and heard nothing
      // in an Arabic lesson — which is how a class that was taught came to
      // report that nobody spoke in it.
      language: await this.lessonLanguage(s.tenantId),
    });
    await this.markPresent(s.id, actorUserId, 'TEACHER');
    return {
      session: this.meetingSession(s),
      externalUrl: null,
      meeting,
      participant: { role: 'TEACHER' as const },
    };
  }

  /**
   * Check someone in, once.
   *
   * An upsert keyed on (session, user): rejoining after a refresh, a reconnect
   * or in a second tab lands on the row they already have and reopens it,
   * rather than filing a second attendance for the same person.
   */
  private async markPresent(sessionId: string, userId: string, role: 'TEACHER' | 'STUDENT') {
    const now = new Date();
    await this.prisma.liveAttendance.upsert({
      where: { sessionId_userId: { sessionId, userId } },
      create: { sessionId, userId, role, joinedAt: now, lastSeenAt: now },
      update: { lastSeenAt: now, leftAt: null },
    });
  }

  private async announceStart(s: { id: string; title: string }) {
    const booked = await this.prisma.liveBooking.findMany({
      where: { sessionId: s.id },
      select: { student: { select: { userId: true } } },
    });
    // So the listing turns from "waiting for the teacher" into a way in,
    // without the student refreshing a page to find out.
    for (const b of booked) {
      this.realtime.emitToUser(b.student.userId, 'live:started', { sessionId: s.id });
    }
    await Promise.all(
      booked.map((b) =>
        this.notifications.create({
          userId: b.student.userId,
          type: 'LIVE_SESSION_REMINDER',
          title: 'الفصل بدأ الآن 🔴',
          body: `«${s.title}» شغّال دلوقتي. ادخل من صفحة الجلسات المباشرة.`,
          meta: { sessionId: s.id, live: true },
        }),
      ),
    );
  }

  private studentView(s: any, booked: boolean) {
    const status = this.effectiveStatus(s);
    return {
      id: s.id,
      title: s.title,
      description: s.description,
      startsAt: s.startsAt,
      durationMin: s.durationMin,
      capacity: s.capacity,
      bookedCount: s._count.bookings,
      seatsLeft: s.capacity != null ? Math.max(0, s.capacity - s._count.bookings) : null,
      teacherName: s.teacher.user.fullName,
      teacherSlug: s.teacher.slug,
      booked,
      status,
      // What the button should say, worked out where the clock is trusted. The
      // page renders this rather than recomputing the rules in the browser.
      joinOpensAt: new Date(this.opensAt(s)),
      canJoin: booked && status === 'LIVE' && Date.now() >= this.opensAt(s),
      // A session pointed at Zoom still says so, without leaking the link.
      external: !s.roomName && !!s.joinUrl,
    };
  }

  private scopeWhere(scope: LiveScope) {
    return {
      academyId: scope.academyId,
      ...(scope.manageAll ? {} : { teacherUserId: scope.userId }),
    };
  }

  /** Organisation scope first, then (for a non-owner) authorship — a foreign or colleague's stream 404s. */
  /** The session, if this scope may manage it — the same check every teacher route makes. */
  ownedSession(scope: LiveScope, id: string) {
    return this.assertOwned(scope, id);
  }

  private async assertOwned(scope: LiveScope, id: string) {
    const s = await this.prisma.liveSession.findFirst({ where: { id, ...this.scopeWhere(scope) } });
    if (!s) throw new NotFoundException('Session not found');
    return s;
  }

  private async studentOf(userId: string) {
    const s = await this.prisma.studentProfile.findUnique({
      where: { userId },
      include: { user: { select: { fullName: true } } },
    });
    if (!s) throw new BadRequestException('No student profile for this account');
    return s;
  }

  /** ACTIVE and not lapsed — a monthly subscription whose window has passed
   * stays status=ACTIVE but must no longer grant entitlements. */
  private activeEnrollmentWhere() {
    return {
      status: 'ACTIVE' as const,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    };
  }

  private async enrolledAcademyIds(studentId: string): Promise<string[]> {
    const rows = await this.prisma.enrollment.findMany({
      where: { studentId, ...this.activeEnrollmentWhere() },
      select: { academyId: true, tenantId: true },
    });
    return [...new Set(rows.map((r) => r.academyId ?? r.tenantId))];
  }

  private async assertEnrolledWith(
    studentId: string,
    session: { academyId: string | null; tenantId: string; groupId: string | null },
  ) {
    if (session.groupId) {
      const member = await this.prisma.groupMembership.findFirst({
        where: { groupId: session.groupId, studentId },
        select: { id: true },
      });
      if (!member)
        throw new ForbiddenException({
          message: 'This session is for a group you are not in',
          code: 'NOT_IN_GROUP',
        });
    }
    const active = await this.prisma.enrollment.findFirst({
      where: {
        studentId,
        academyId: session.academyId ?? session.tenantId,
        ...this.activeEnrollmentWhere(),
      },
      select: { id: true },
    });
    if (!active) throw new ForbiddenException('You must be enrolled with this teacher to book');
  }

  private async announceToStudents(
    session: { id: string; academyId: string | null; tenantId: string; groupId: string | null },
    title: string,
    startsAt: Date,
  ) {
    const sessionId = session.id;
    const students = session.groupId
      ? await this.prisma.groupMembership.findMany({
          where: { groupId: session.groupId },
          select: { student: { select: { userId: true } } },
          distinct: ['studentId'],
        })
      : await this.prisma.enrollment.findMany({
          // The same "active" every other live path uses (booking, the upcoming
          // list): an expired monthly subscription is still status ACTIVE, and
          // announcing a session to someone who can no longer book it is a
          // notification they cannot act on.
          where: {
            academyId: session.academyId ?? session.tenantId,
            ...this.activeEnrollmentWhere(),
          },
          select: { student: { select: { userId: true } } },
          distinct: ['studentId'],
        });
    const when = startsAt.toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' });
    await Promise.all(
      students.map((e) =>
        this.notifications.create({
          userId: e.student.userId,
          type: 'LIVE_SESSION_REMINDER',
          title: 'جلسة مباشرة جديدة 🔴',
          body: `«${title}» يوم ${when}. احجز مقعدك الآن.`,
          meta: { sessionId },
        }),
      ),
    );
  }
}
