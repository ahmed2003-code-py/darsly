import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { LiveAdmissionRequest } from '@prisma/client';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { consumeAdmission, lockSession, seatsTaken } from '../commerce/live-commerce.service';
import { LiveService } from '../live.service';

/** A rejected student may ask again after this long… */
export const ADMISSION_COOLDOWN_MS = 2 * 60_000;
/** …and at most this many times for one class. */
export const ADMISSION_MAX_ATTEMPTS = 3;
/** Purchase states that already hold (or are buying) a seat. */
const HOLDING_PURCHASE = [
  'HELD',
  'PAYMENT_PENDING',
  'CONFIRMED',
  'DELIVERED',
  'NEEDS_REVIEW',
] as const;

type Row = Pick<LiveAdmissionRequest, 'id' | 'status' | 'attempts' | 'requestedAt' | 'decidedAt'>;
const view = (r: Row | null) =>
  r
    ? {
        id: r.id,
        status: r.status,
        attempts: r.attempts,
        requestedAt: r.requestedAt,
        decidedAt: r.decidedAt,
      }
    : null;

/**
 * "طلب الانضمام": a student asks for a seat in a class whose booking capacity
 * is full, and a moderator approves or rejects it.
 *
 * Capacity keeps its one meaning — booking capacity (bookings, confirmed
 * guest seats, live holds). An approval is a one-person exception to it for
 * this session, never an entitlement:
 *  - FREE class: approval books the seat at once, past the full capacity, in
 *    the same locked transaction every seat takes (the request becomes USED);
 *  - PAID class: approval only lets this student START the normal purchase
 *    (hold → pay → verified → seat) past the full check. No payment, no seat.
 * The exception belongs to this student and this class only (one row per
 * pair), is used once, and expires with the class. The configured capacity
 * never changes. No FIFO, no automatic promotion.
 */
@Injectable()
export class LiveAdmissionService {
  private readonly logger = new Logger(LiveAdmissionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
  ) {}

  // ── The student ─────────────────────────────────────────────────────────

  private async studentOf(userId: string) {
    const s = await this.prisma.studentProfile.findUnique({
      where: { userId },
      select: { id: true, user: { select: { fullName: true } } },
    });
    if (!s) {
      throw new ForbiddenException({
        message: 'Only a student can ask to join',
        code: 'ADMISSION_NOT_ELIGIBLE',
      });
    }
    return s;
  }

  private async sessionFor(sessionId: string) {
    const s = await this.prisma.liveSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        title: true,
        status: true,
        startsAt: true,
        durationMin: true,
        capacity: true,
        accessMode: true,
        groupId: true,
        academyId: true,
        tenantId: true,
        deletedAt: true,
        cancelledAt: true,
        teacherUserId: true,
        teacher: { select: { userId: true } },
      },
    });
    if (!s || s.deletedAt) throw new NotFoundException('Session not found');
    return s;
  }

  private over(s: {
    status: string;
    startsAt: Date;
    durationMin: number;
    cancelledAt: Date | null;
  }) {
    return (
      !!s.cancelledAt ||
      s.status === 'ENDED' ||
      Date.now() >= s.startsAt.getTime() + s.durationMin * 60_000
    );
  }

  /** My request for this class (null when I never asked). */
  async mine(userId: string, sessionId: string) {
    const student = await this.studentOf(userId);
    const r = await this.prisma.liveAdmissionRequest.findUnique({
      where: { sessionId_userId: { sessionId, userId } },
    });
    if (r && r.studentId !== student.id) return null;
    return view(r);
  }

  /**
   * Ask. Only an eligible student with no seat and no purchase in progress,
   * for a class that has not ended and is actually full. Asking again while
   * a request is open answers with it; after a rejection, again only after a
   * short wait and a few times at most.
   */
  async request(userId: string, sessionId: string) {
    const student = await this.studentOf(userId);
    const s = await this.sessionFor(sessionId);
    if (this.over(s))
      throw new ConflictException({ message: 'This session has ended', code: 'SESSION_ENDED' });
    // The class's own audience: a group's class stays its group's.
    if (s.groupId) await this.live.assertAudience(student.id, s);
    const r = await this.prisma.$transaction(async (tx) => {
      const locked = await lockSession(tx, sessionId);
      if (!locked) throw new NotFoundException('Session not found');
      const booked = await tx.liveBooking.findUnique({
        where: { sessionId_studentId: { sessionId, studentId: student.id } },
        select: { id: true },
      });
      if (booked)
        throw new ConflictException({ message: 'You already have a seat', code: 'ALREADY_BOOKED' });
      const buying = await tx.livePurchase.findFirst({
        where: { sessionId, studentId: student.id, status: { in: [...HOLDING_PURCHASE] } },
        select: { id: true },
      });
      if (buying)
        throw new ConflictException({
          message: 'You are already buying a seat',
          code: 'ALREADY_HOLDING',
        });
      const existing = await tx.liveAdmissionRequest.findUnique({
        where: { sessionId_userId: { sessionId, userId } },
      });
      // An open request (or an approval not yet used) is the answer.
      if (existing && (existing.status === 'PENDING' || existing.status === 'APPROVED')) {
        return { row: existing, fresh: false };
      }
      if (
        locked.capacity == null ||
        (await seatsTaken(tx, sessionId, new Date())) < locked.capacity
      ) {
        throw new ConflictException({ message: 'There is a seat — book it', code: 'NOT_FULL' });
      }
      if (existing) {
        if (existing.status === 'EXPIRED')
          throw new ConflictException({ message: 'This session has ended', code: 'SESSION_ENDED' });
        if (existing.status === 'USED')
          throw new ConflictException({
            message: 'You already have a seat',
            code: 'ALREADY_BOOKED',
          });
        if (existing.attempts >= ADMISSION_MAX_ATTEMPTS)
          throw new ConflictException({
            message: 'You have asked the most times you can for this class',
            code: 'ADMISSION_LIMIT',
          });
        const wait =
          (existing.decidedAt ?? existing.requestedAt).getTime() +
          ADMISSION_COOLDOWN_MS -
          Date.now();
        if (existing.status === 'REJECTED' && wait > 0) {
          throw new HttpException(
            {
              message: 'Wait a moment before asking again',
              code: 'ADMISSION_COOLDOWN',
              retryAfterSeconds: Math.ceil(wait / 1000),
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        const row = await tx.liveAdmissionRequest.update({
          where: { id: existing.id },
          data: {
            status: 'PENDING',
            attempts: { increment: 1 },
            requestedAt: new Date(),
            decidedAt: null,
            decidedBy: null,
          },
        });
        return { row, fresh: true };
      }
      const row = await tx.liveAdmissionRequest.create({
        data: { sessionId, userId, studentId: student.id, status: 'PENDING' },
      });
      return { row, fresh: true };
    });
    if (r.fresh) {
      // The teacher is told wherever they are: in the class (its state), on
      // the class's page, and by a notification.
      const teacherUserId = s.teacherUserId ?? s.teacher.userId;
      this.realtime.emitToUser(teacherUserId, 'live:admissions', { sessionId });
      this.realtime.emitToLive(sessionId, 'live:rtc-state', { sessionId });
      await this.notifications
        .create({
          userId: teacherUserId,
          type: 'LIVE_SESSION_REMINDER',
          title: 'طلب انضمام لحصة مكتملة',
          body: `${student.user.fullName} يطلب الانضمام إلى «${s.title}».`,
          meta: { sessionId, admission: r.row.id },
        })
        .catch(() => undefined);
      this.logger.log(
        `live.admission.requested liveSession=${sessionId} student=${student.id} attempt=${r.row.attempts}`,
      );
    }
    return view(r.row);
  }

  /** Withdraw my request (pending, or approved and not yet used). */
  async cancel(userId: string, sessionId: string) {
    await this.studentOf(userId);
    await this.prisma.liveAdmissionRequest.updateMany({
      where: { sessionId, userId, status: { in: ['PENDING', 'APPROVED'] } },
      data: { status: 'CANCELLED', decidedAt: new Date() },
    });
    this.realtime.emitToLive(sessionId, 'live:rtc-state', { sessionId });
    return this.mine(userId, sessionId);
  }

  // ── The class's moderators ───────────────────────────────────────────────

  /** Open requests and approvals, with the capacity they are exceptions to. */
  async list(sessionId: string) {
    const s = await this.sessionFor(sessionId);
    const [rows, taken, exceptions] = await Promise.all([
      this.prisma.liveAdmissionRequest.findMany({
        where: { sessionId, status: { in: ['PENDING', 'APPROVED'] } },
        orderBy: { requestedAt: 'asc' },
      }),
      seatsTaken(this.prisma, sessionId, new Date()),
      this.prisma.liveAdmissionRequest.count({ where: { sessionId, status: 'USED' } }),
    ]);
    const names = new Map(
      (
        await this.prisma.user.findMany({
          where: { id: { in: rows.map((r) => r.userId) } },
          select: { id: true, fullName: true },
        })
      ).map((u) => [u.id, u.fullName]),
    );
    return {
      capacity: s.capacity,
      seatsTaken: taken,
      exceptions,
      accessMode: s.accessMode,
      requests: rows.map((r) => ({
        ...view(r)!,
        userId: r.userId,
        name: names.get(r.userId) ?? '',
      })),
    };
  }

  /**
   * Approve or reject — once. Two tabs deciding the same request: the first
   * decides, the second is told what was decided. Serialised with every seat
   * change by the session's row lock.
   */
  async decide(
    actorId: string,
    sessionId: string,
    requestId: string,
    decision: 'APPROVE' | 'REJECT',
  ) {
    await this.live.assertModerator(actorId, sessionId);
    const s = await this.sessionFor(sessionId);
    const out = await this.prisma.$transaction(async (tx) => {
      await lockSession(tx, sessionId);
      const r = await tx.liveAdmissionRequest.findFirst({ where: { id: requestId, sessionId } });
      if (!r) throw new NotFoundException('Request not found');
      if (r.status !== 'PENDING') return { row: r, changed: false };
      const now = new Date();
      if (this.over(s)) {
        const row = await tx.liveAdmissionRequest.update({
          where: { id: r.id },
          data: { status: 'EXPIRED', decidedAt: now },
        });
        return { row, changed: true };
      }
      if (decision === 'REJECT') {
        const row = await tx.liveAdmissionRequest.update({
          where: { id: r.id },
          data: { status: 'REJECTED', decidedAt: now, decidedBy: actorId },
        });
        return { row, changed: true };
      }
      // Got in the ordinary way meanwhile (a seat opened): nothing to except.
      const booked = await tx.liveBooking.findUnique({
        where: { sessionId_studentId: { sessionId, studentId: r.studentId } },
        select: { id: true },
      });
      if (booked) {
        const row = await tx.liveAdmissionRequest.update({
          where: { id: r.id },
          data: { status: 'CANCELLED', decidedAt: now },
        });
        return { row, changed: true };
      }
      await tx.liveAdmissionRequest.update({
        where: { id: r.id },
        data: { status: 'APPROVED', decidedAt: now, decidedBy: actorId },
      });
      if (s.accessMode === 'FREE') {
        // A free class: the seat itself, past the full capacity, now.
        const booking = await tx.liveBooking.create({
          data: { sessionId, studentId: r.studentId },
        });
        await consumeAdmission(tx, sessionId, r.studentId, { bookingId: booking.id });
      }
      // A paid class: the approval only opens the ordinary purchase for them.
      const row = await tx.liveAdmissionRequest.findUniqueOrThrow({ where: { id: r.id } });
      return { row, changed: true };
    });
    if (out.changed) {
      this.realtime.emitToUser(out.row.userId, 'live:admission', {
        sessionId,
        status: out.row.status,
      });
      this.realtime.emitToLive(sessionId, 'live:rtc-state', { sessionId });
      if (
        out.row.status === 'USED' ||
        out.row.status === 'APPROVED' ||
        out.row.status === 'REJECTED'
      ) {
        await this.notifications
          .create({
            userId: out.row.userId,
            type: 'LIVE_SESSION_REMINDER',
            title:
              out.row.status === 'REJECTED'
                ? 'لم يوافق المدرس على طلب الانضمام'
                : out.row.status === 'USED'
                  ? 'تمت الموافقة — لك مقعد في الحصة'
                  : 'تمت الموافقة — أكمل الحجز',
            body: `«${s.title}»`,
            meta: { sessionId, admission: out.row.id },
          })
          .catch(() => undefined);
      }
      this.logger.log(
        `live.admission.${decision.toLowerCase()} liveSession=${sessionId} actor=${actorId} request=${out.row.id} → ${out.row.status}`,
      );
    }
    return { ...view(out.row)!, alreadyDecided: !out.changed };
  }
}
