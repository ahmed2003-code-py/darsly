import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

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

    if (session.capacity != null && session._count.bookings >= session.capacity) {
      throw new BadRequestException({ message: 'Session is full', code: 'SESSION_FULL' });
    }

    await this.prisma.liveBooking.create({ data: { sessionId, studentId: student.id } });

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

  /** Returns the join URL only to a booked student, near/within the session window. */
  async join(userId: string, sessionId: string) {
    const student = await this.studentOf(userId);
    const booking = await this.prisma.liveBooking.findUnique({
      where: { sessionId_studentId: { sessionId, studentId: student.id } },
      include: { session: true },
    });
    if (!booking || booking.session.deletedAt) throw new ForbiddenException('You have not booked this session');
    const s = booking.session;
    const opensAt = s.startsAt.getTime() - 15 * 60_000; // join opens 15 min early
    const closesAt = s.startsAt.getTime() + s.durationMin * 60_000;
    if (Date.now() < opensAt) {
      throw new BadRequestException({ message: 'Session has not opened yet', code: 'NOT_OPEN_YET' });
    }
    if (Date.now() > closesAt) {
      throw new BadRequestException({ message: 'Session has ended', code: 'ENDED' });
    }
    return { joinUrl: s.joinUrl ?? null, title: s.title };
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private studentView(s: any, booked: boolean) {
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

  private async enrolledTenantIds(studentId: string): Promise<string[]> {
    const rows = await this.prisma.enrollment.findMany({
      where: { studentId, status: 'ACTIVE' },
      select: { tenantId: true },
      distinct: ['tenantId'],
    });
    return rows.map((r) => r.tenantId);
  }

  private async assertEnrolledWith(studentId: string, tenantId: string) {
    const active = await this.prisma.enrollment.findFirst({
      where: { studentId, tenantId, status: 'ACTIVE' },
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
