import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { LiveSessionStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { GamificationService } from '../gamification/gamification.service';
import { DailyService } from './daily.service';

/** How long before the scheduled time the doors open. */
export const JOIN_OPENS_MIN = 15;
/**
 * How long a silence may last before it counts as absence rather than a
 * stutter. Comfortably longer than the heartbeat interval, so one dropped
 * request does not cost a student the minutes they were actually sitting there.
 */
export const PRESENCE_GRACE_SEC = 90;

export interface UpsertLiveDto {
  title: string;
  description?: string;
  startsAt: string;
  durationMin?: number;
  capacity?: number | null;
  courseId?: string | null;
  joinUrl?: string | null;
}

@Injectable()
export class LiveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly gamification: GamificationService,
    private readonly daily: DailyService,
  ) {}

  // ── Teacher ────────────────────────────────────────────────────────────────

  async create(tenantId: string, dto: UpsertLiveDto) {
    const session = await this.prisma.liveSession.create({
      data: {
        tenantId,
        title: dto.title.trim(),
        description: dto.description ?? '',
        startsAt: new Date(dto.startsAt),
        durationMin: dto.durationMin ?? 60,
        capacity: dto.capacity ?? null,
        courseId: dto.courseId ?? null,
        joinUrl: dto.joinUrl ?? null,
      },
    });
    await this.announceToStudents(tenantId, session.id, session.title, session.startsAt);
    return session;
  }

  async update(tenantId: string, id: string, dto: Partial<UpsertLiveDto>) {
    await this.assertOwned(tenantId, id);
    return this.prisma.liveSession.update({
      where: { id },
      data: {
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

  async remove(tenantId: string, id: string) {
    await this.assertOwned(tenantId, id);
    await this.prisma.liveSession.delete({ where: { id } }); // soft delete via middleware
    return { id, deleted: true };
  }

  async listForTeacher(tenantId: string) {
    const sessions = await this.prisma.liveSession.findMany({
      where: { tenantId },
      orderBy: { startsAt: 'asc' },
      include: { _count: { select: { bookings: true } } },
    });
    return sessions.map((s) => ({ ...s, bookedCount: s._count.bookings }));
  }

  async bookingsFor(tenantId: string, id: string) {
    await this.assertOwned(tenantId, id);
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

  /** Upcoming sessions from teachers the student is actively enrolled with. */
  async upcomingForStudent(userId: string) {
    const student = await this.studentOf(userId);
    const tenantIds = await this.enrolledTenantIds(student.id);
    if (!tenantIds.length) return [];

    const sessions = await this.prisma.liveSession.findMany({
      where: { tenantId: { in: tenantIds }, startsAt: { gte: new Date(Date.now() - 2 * 3600_000) } },
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
    await this.assertEnrolledWith(student.id, session.tenantId);

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
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2034' && attempt < 3) {
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

  async cancel(userId: string, sessionId: string) {
    const student = await this.studentOf(userId);
    await this.prisma.liveBooking.deleteMany({ where: { sessionId, studentId: student.id } });
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
    if (!booking || booking.session.deletedAt) throw new ForbiddenException('You have not booked this session');
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
      if (s.joinUrl) return { session: this.meetingSession(s), externalUrl: s.joinUrl, meeting: null, participant: { role: 'STUDENT' as const } };
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
   * One live session per academy at a time. Note this is deliberately *not*
   * `maxConcurrentSessions`, which despite the name governs how many devices a
   * student may be signed in from — borrowing it here would tie a teacher's
   * classroom to an anti-account-sharing setting that has nothing to do with it.
   */
  async start(tenantId: string, id: string, actorUserId: string) {
    const session = await this.assertOwned(tenantId, id);
    if (session.status === 'ENDED' || this.pastWindow(session)) {
      throw new BadRequestException({ message: 'انتهت هذه الجلسة', code: 'ENDED' });
    }
    if (Date.now() < session.startsAt.getTime() - JOIN_OPENS_MIN * 60_000) {
      throw new BadRequestException({
        message: `يمكن بدء الفصل قبل الموعد بـ${JOIN_OPENS_MIN} دقيقة`,
        code: 'TOO_EARLY',
      });
    }

    // Already running: starting twice is the same room, not a second one. This
    // is the refresh case and the two-tabs case, and both should just work.
    if (session.status === 'LIVE' && session.roomName) {
      return this.teacherEntry(session, actorUserId);
    }

    // Claim the "one live session" slot and the LIVE status in one statement,
    // so two taps a millisecond apart cannot both win it.
    const claimed = await this.prisma.liveSession.updateMany({
      where: { id, tenantId, status: { not: 'LIVE' }, deletedAt: null },
      data: { status: 'LIVE', startedAt: new Date() },
    });
    if (claimed.count === 0) {
      const fresh = await this.assertOwned(tenantId, id);
      return this.teacherEntry(fresh, actorUserId);
    }
    const otherLive = await this.prisma.liveSession.count({
      where: { tenantId, status: 'LIVE', id: { not: id }, deletedAt: null },
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
    await this.announceStart(tenantId, updated);
    return this.teacherEntry(updated, actorUserId);
  }

  /** The teacher walks back into a class they already started. */
  async teacherJoin(tenantId: string, id: string, actorUserId: string) {
    const session = await this.assertOwned(tenantId, id);
    if (session.status !== 'LIVE' || !session.roomName) {
      throw new BadRequestException({ message: 'لم يبدأ الفصل بعد', code: 'NOT_STARTED' });
    }
    if (this.pastWindow(session)) {
      throw new BadRequestException({ message: 'انتهت هذه الجلسة', code: 'ENDED' });
    }
    return this.teacherEntry(session, actorUserId);
  }

  /** The teacher closes the classroom. Everyone still inside is checked out. */
  async end(tenantId: string, id: string) {
    const session = await this.assertOwned(tenantId, id);
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

  /** Who actually turned up, for the teacher's own session. */
  async attendanceFor(tenantId: string, id: string) {
    await this.assertOwned(tenantId, id);
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
    s: { id: string; title: string; startsAt: Date; durationMin: number; status: LiveSessionStatus; roomName: string | null; roomUrl: string | null },
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
      meeting: { provider: 'daily' as const, url: s.roomUrl, token },
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

  private async announceStart(tenantId: string, s: { id: string; title: string }) {
    const booked = await this.prisma.liveBooking.findMany({
      where: { sessionId: s.id },
      select: { student: { select: { userId: true } } },
    });
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

  private async assertOwned(tenantId: string, id: string) {
    const s = await this.prisma.liveSession.findFirst({ where: { id, tenantId } });
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

  private async enrolledTenantIds(studentId: string): Promise<string[]> {
    const rows = await this.prisma.enrollment.findMany({
      where: { studentId, ...this.activeEnrollmentWhere() },
      select: { tenantId: true },
      distinct: ['tenantId'],
    });
    return rows.map((r) => r.tenantId);
  }

  private async assertEnrolledWith(studentId: string, tenantId: string) {
    const active = await this.prisma.enrollment.findFirst({
      where: { studentId, tenantId, ...this.activeEnrollmentWhere() },
      select: { id: true },
    });
    if (!active) throw new ForbiddenException('You must be enrolled with this teacher to book');
  }

  private async announceToStudents(tenantId: string, sessionId: string, title: string, startsAt: Date) {
    const students = await this.prisma.enrollment.findMany({
      where: { tenantId, status: 'ACTIVE' },
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
