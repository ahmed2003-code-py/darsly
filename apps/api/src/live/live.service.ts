import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AcademyService } from '../academy/academy.service';
import { LivePipelineStatus, LiveSessionStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { GamificationService } from '../gamification/gamification.service';
import { DailyService } from './daily.service';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly gamification: GamificationService,
    private readonly daily: DailyService,
    private readonly realtime: RealtimeService,
    private readonly jobs: AiJobService,
    private readonly academy: AcademyService,
  ) {}

  // ── Teacher ────────────────────────────────────────────────────────────────

  async create(scope: LiveScope, dto: UpsertLiveDto) {
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
    const wasLive = session.status === 'LIVE' && !this.pastWindow(session);
    const stillAhead = session.status !== 'ENDED' && !this.pastWindow(session);
    const why = reason?.trim().slice(0, 500) || null;

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
        ...(wasLive ? { status: 'ENDED' as const, endedAt: now } : {}),
      },
    });
    if (wasLive) {
      await this.prisma.liveAttendance.updateMany({
        where: { sessionId: id, leftAt: null },
        data: { leftAt: now },
      });
      if (session.roomName) await this.daily.deleteRoom(session.roomName);
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

    // Attendance, as far as the platform can honestly verify it: this student
    // booked the session and asked for the link inside the window it was
    // running. Keyed on the session, so opening the link twice is one
    // attendance.
    await this.gamification.record({
      studentId: student.id,
      type: 'LIVE_ATTENDED',
      key: `LIVE_ATTENDED:${student.id}:${sessionId}`,
      tenantId: s.tenantId,
      entityType: 'liveSession',
      entityId: sessionId,
      meta: { title: s.title },
    });

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

    const token = await this.daily.meetingToken({
      roomName: s.roomName,
      userName: student.user.fullName,
      userId,
      // The student is never an owner: that is what would let them mute and
      // remove the class, and it is decided here rather than asked for.
      isOwner: false,
      endsAtMs: this.closesAt(s),
    });
    await this.markPresent(sessionId, userId, 'STUDENT');
    return {
      session: this.meetingSession(s),
      externalUrl: null,
      meeting: { provider: 'daily' as const, url: s.roomUrl!, token },
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

    // The room name is derived, not random: it makes the Daily dashboard
    // readable and it is unique per session by construction.
    const roomName = `darsly-${id}`.toLowerCase();
    let room;
    try {
      room = await this.daily.createRoom(roomName, this.closesAt(session));
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
    const session = await this.assertOwned(scope, id);
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.liveSession.update({
        where: { id },
        data: { status: 'ENDED', endedAt: now },
      }),
      this.prisma.liveAttendance.updateMany({
        where: { sessionId: id, leftAt: null },
        data: { leftAt: now },
      }),
    ]);
    if (session.roomName) await this.daily.deleteRoom(session.roomName);

    // Tell the room, and tell the class.
    //
    // Deleting the Daily room drops everyone's connection, but that is the
    // video going quiet — it is not an answer to "what happened?". Without
    // this, a student sat looking at a dead meeting, and the listing behind it
    // went on saying "live now, waiting for the teacher to start" until they
    // thought to reload a page they had no reason to reload.
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
    return { id, status: 'ENDED' as const, endedAt: now };
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
    const row = await this.prisma.liveAttendance.findUnique({
      where: { sessionId_userId: { sessionId, userId } },
    });
    if (!row) return { ok: false };
    const now = Date.now();
    const gapSec = Math.floor((now - row.lastSeenAt.getTime()) / 1000);
    const credited = gapSec > 0 && gapSec <= PRESENCE_GRACE_SEC ? gapSec : 0;
    await this.prisma.liveAttendance.update({
      where: { id: row.id },
      data: {
        lastSeenAt: new Date(now),
        leftAt: null,
        durationSeconds: { increment: credited },
      },
    });
    return { ok: true };
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
      select: { id: true, recordingId: true, recordingStatus: true, summaryForStudents: true },
    });
    if (full) full.recordingStatus = await this.refreshRecording(full);
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
    const link = await this.daily.recordingLink(full.recordingId);
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
    recordingId: string | null;
    recordingStatus: LivePipelineStatus;
  }) {
    if (session.recordingStatus !== 'PROCESSING' || !session.recordingId)
      return session.recordingStatus;
    const remote = await this.daily.recording(session.recordingId);
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
        recordingStatus: true,
        recordingId: true,
        recordingDuration: true,
        summaryStatus: true,
        summary: true,
        summaryError: true,
        summaryForStudents: true,
        transcriptStatus: true,
        updatedAt: true,
      },
    });
    const recordingStatus = await this.refreshRecording(s);
    const canSeeSummary = role === 'TEACHER' || s.summaryForStudents;
    // A PROCESSING with nothing behind it is shown as the failure it is, so the
    // page offers "try again" instead of a spinner that never stops.
    let summaryStatus = s.summaryStatus;
    let summaryError = s.summaryError;
    if (summaryStatus === 'PROCESSING' && !(await this.summaryInFlight(s.id, s.updatedAt))) {
      summaryStatus = 'FAILED';
      summaryError = summaryError ?? 'STALLED';
    }
    return {
      id: s.id,
      title: s.title,
      startsAt: s.startsAt,
      durationMin: s.durationMin,
      status: this.effectiveStatus(s),
      role,
      recording: {
        status: recordingStatus,
        durationSeconds: s.recordingDuration,
        // A student is told there is a recording only once it is theirs to see.
        available: recordingStatus === 'READY' && (role === 'TEACHER' || s.summaryForStudents),
      },
      summary: {
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
  }) {
    return {
      id: s.id,
      title: s.title,
      startsAt: s.startsAt,
      durationMin: s.durationMin,
      status: this.effectiveStatus(s),
      endsAt: new Date(this.closesAt(s)),
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
      roomName: string | null;
      roomUrl: string | null;
    },
    actorUserId: string,
  ) {
    if (!s.roomName || !s.roomUrl) {
      throw new BadRequestException({ message: 'لم يبدأ الفصل بعد', code: 'NOT_STARTED' });
    }
    // The name shown in the room comes from the account, not the request: a
    // display name a caller could choose is a display name they could borrow.
    const actor = await this.prisma.user.findUnique({
      where: { id: actorUserId },
      select: { fullName: true },
    });
    const token = await this.daily.meetingToken({
      roomName: s.roomName,
      userName: actor?.fullName ?? 'المدرّس',
      userId: actorUserId,
      isOwner: true,
      endsAtMs: this.closesAt(s),
    });
    await this.markPresent(s.id, actorUserId, 'TEACHER');
    return {
      session: this.meetingSession(s),
      externalUrl: null,
      meeting: {
        provider: 'daily' as const,
        url: s.roomUrl,
        token,
        // What language to listen for. Transcription was starting with no
        // language at all, so the provider assumed English and heard nothing
        // in an Arabic lesson — which is how a class that was taught came to
        // report that nobody spoke in it.
        language: await this.lessonLanguage(s.tenantId),
      },
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
