import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { GamificationConfigService } from '../../gamification/gamification.config.service';
import { GamificationService } from '../../gamification/gamification.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { LiveService } from '../live.service';
import { LiveRtcService } from '../rtc/live-rtc.service';

/** The limits when the rule leaves one empty (the seeded rule sets all three). */
export const LIVE_BONUS_DEFAULTS = { maxPerAward: 10, maxPerStudentEntity: 20, maxPerEntity: 300 };

/** Preset reasons the teacher picks from; anything else is their own words. */
export const LIVE_BONUS_REASONS = ['CORRECT_ANSWER', 'GREAT_PARTICIPATION', 'SOLVED_IT'] as const;
export type LiveBonusReason = (typeof LIVE_BONUS_REASONS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * "مكافأة": points a teacher gives a student during a live class.
 *
 * Paid through the one door the economy has (GamificationService.recordOrThrow),
 * as a LIVE_BONUS event: points × the rule's XP and coins, on the student's
 * StudentGamification, with the event in GamificationEvent. Never money — no
 * Payment, ledger, wallet or earnings row is ever touched here.
 *
 *  - Who: a moderator of this class (LiveService.canModerate), in the room.
 *  - To whom: a student of this class with a StudentProfile who has been in
 *    it. A guest has no gamification profile and is refused
 *    (BONUS_NOT_ELIGIBLE); none is ever made for them.
 *  - How much: 1..maxPerAward points; at most maxPerStudentEntity to one
 *    student and maxPerEntity in total per class — the rule's own limits,
 *    tuned by an admin like every other rule. The caps are checked inside the
 *    award's transaction under a per-class lock, so two teacher tabs cannot
 *    both pass the last point.
 *  - Exactly once per click: the page makes a requestId; the award's
 *    idempotency key is `LIVE_BONUS:{sessionId}:{requestId}`, so a retry or a
 *    double-submit is one award, and two deliberate clicks are two.
 */
@Injectable()
export class LiveBonusService {
  private readonly logger = new Logger(LiveBonusService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
    private readonly rtc: LiveRtcService,
    private readonly gamification: GamificationService,
    private readonly config: GamificationConfigService,
    private readonly realtime: RealtimeService,
  ) {}

  /** The rule and its limits (admin-tunable); null when bonuses are switched off. */
  private async rule() {
    const r = await this.config.rule('LIVE_BONUS');
    if (!r) return null;
    return {
      xp: r.xp,
      coins: r.coins,
      maxPerAward: r.maxPerAward ?? LIVE_BONUS_DEFAULTS.maxPerAward,
      maxPerStudentEntity: r.maxPerStudentEntity ?? LIVE_BONUS_DEFAULTS.maxPerStudentEntity,
      maxPerEntity: r.maxPerEntity ?? LIVE_BONUS_DEFAULTS.maxPerEntity,
    };
  }

  /** Points already given in this class — in total, and to one student. */
  private async given(db: Prisma.TransactionClient | PrismaService, sessionId: string, studentId?: string) {
    const rows = await db.$queryRaw<{ points: bigint | null }[]>`
      SELECT COALESCE(SUM((meta->>'points')::int), 0) AS points
      FROM "GamificationEvent"
      WHERE type = 'LIVE_BONUS' AND "entityId" = ${sessionId}
        ${studentId ? Prisma.sql`AND "studentId" = ${studentId}` : Prisma.empty}`;
    return Number(rows[0]?.points ?? 0);
  }

  async grant(
    actorId: string,
    sessionId: string,
    dto: { studentUserId: string; points: number; reasonKey?: LiveBonusReason; reason?: string; requestId: string },
  ) {
    const g = await this.rtc.gate(actorId, sessionId);
    if (!g.moderator) {
      throw new ForbiddenException({ message: 'Only the class’s teacher can give a bonus', code: 'NOT_A_MODERATOR' });
    }
    if (!UUID.test(dto.requestId ?? '')) {
      throw new BadRequestException({ message: 'Bad request id', code: 'BONUS_INVALID' });
    }
    const rule = await this.rule();
    if (!rule) throw new ConflictException({ message: 'Bonuses are switched off', code: 'BONUS_DISABLED' });
    if (!Number.isInteger(dto.points) || dto.points < 1 || dto.points > rule.maxPerAward) {
      throw new BadRequestException({
        message: `A bonus is 1–${rule.maxPerAward} points`,
        code: 'BONUS_INVALID',
        max: rule.maxPerAward,
      });
    }

    // The student: of this class, a real student profile (never a guest), and here.
    const target = await this.live.assertInSession(dto.studentUserId, sessionId).catch(() => null);
    if (!target || target.role !== 'STUDENT') {
      throw new ForbiddenException({ message: 'Only a student of this class', code: 'BONUS_NOT_ELIGIBLE', reason: 'NOT_A_STUDENT' });
    }
    const student = await this.prisma.studentProfile.findUnique({
      where: { userId: dto.studentUserId },
      select: { id: true },
    });
    if (!student) {
      throw new ForbiddenException({
        message: 'Guests have no points balance',
        code: 'BONUS_NOT_ELIGIBLE',
        reason: 'GUEST',
      });
    }
    const attended = await this.prisma.liveAttendance.findUnique({
      where: { sessionId_userId: { sessionId, userId: dto.studentUserId } },
      select: { id: true },
    });
    if (!attended) {
      throw new ForbiddenException({ message: 'Only a student who is in the class', code: 'BONUS_NOT_ELIGIBLE', reason: 'NOT_PRESENT' });
    }

    const key = `LIVE_BONUS:${sessionId}:${dto.requestId}`;
    // The same click again (a retry): the award it already made.
    const done = await this.prisma.gamificationEvent.findUnique({ where: { idempotencyKey: key }, select: { id: true } });
    if (done) return this.result(sessionId, student.id, rule, { granted: false, duplicate: true });

    const reason = dto.reason?.replace(/\s+/g, ' ').trim().slice(0, 80) || null;
    const outcome = await this.gamification.recordOrThrow({
      studentId: student.id,
      type: 'LIVE_BONUS',
      key,
      tenantId: (await this.prisma.liveSession.findUnique({ where: { id: sessionId }, select: { tenantId: true } }))
        ?.tenantId,
      entityType: 'liveSession',
      entityId: sessionId,
      xpOverride: dto.points * rule.xp,
      coinsOverride: dto.points * rule.coins,
      meta: { points: dto.points, reasonKey: dto.reasonKey ?? null, reason, grantedBy: actorId, requestId: dto.requestId },
      // Inside the award's transaction, under the class's lock: the caps.
      guard: async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`live-bonus:${sessionId}`}))`;
        const classTotal = await this.given(tx, sessionId);
        const studentTotal = await this.given(tx, sessionId, student.id);
        if (studentTotal + dto.points > rule.maxPerStudentEntity) {
          throw new ConflictException({
            message: 'This student has reached the bonus limit for this class',
            code: 'BONUS_STUDENT_CAP',
            remaining: Math.max(0, rule.maxPerStudentEntity - studentTotal),
          });
        }
        if (classTotal + dto.points > rule.maxPerEntity) {
          throw new ConflictException({
            message: 'This class has reached its bonus limit',
            code: 'BONUS_CLASS_CAP',
            remaining: Math.max(0, rule.maxPerEntity - classTotal),
          });
        }
      },
    });
    if (!outcome.awarded) {
      // The unique key collided: a concurrent retry of this same click won.
      return this.result(sessionId, student.id, rule, { granted: false, duplicate: true });
    }
    const out = await this.result(sessionId, student.id, rule, { granted: true, duplicate: false });
    this.realtime.emitToUser(dto.studentUserId, 'live:bonus', {
      sessionId,
      points: dto.points,
      reasonKey: dto.reasonKey ?? null,
      reason,
      total: out.studentTotal,
    });
    this.rtc.changed(sessionId);
    this.logger.log(
      `live.bonus liveSession=${sessionId} actor=${actorId} student=${student.id} points=${dto.points} ` +
        `studentTotal=${out.studentTotal} classTotal=${out.classTotal}`,
    );
    return out;
  }

  private async result(
    sessionId: string,
    studentId: string,
    rule: { maxPerStudentEntity: number; maxPerEntity: number },
    head: { granted: boolean; duplicate: boolean },
  ) {
    const [studentTotal, classTotal] = await Promise.all([
      this.given(this.prisma, sessionId, studentId),
      this.given(this.prisma, sessionId),
    ]);
    return {
      ...head,
      studentTotal,
      classTotal,
      studentRemaining: Math.max(0, rule.maxPerStudentEntity - studentTotal),
      classRemaining: Math.max(0, rule.maxPerEntity - classTotal),
    };
  }

  /** The class's bonuses, newest first — for its teacher's record. */
  async history(sessionId: string) {
    const rows = await this.prisma.gamificationEvent.findMany({
      where: { type: 'LIVE_BONUS', entityId: sessionId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        createdAt: true,
        meta: true,
        student: { select: { userId: true, user: { select: { fullName: true } } } },
      },
    });
    const granters = [...new Set(rows.map((r) => (r.meta as { grantedBy?: string }).grantedBy).filter(Boolean))] as string[];
    const names = new Map(
      (await this.prisma.user.findMany({ where: { id: { in: granters } }, select: { id: true, fullName: true } })).map(
        (u) => [u.id, u.fullName],
      ),
    );
    return rows.map((r) => {
      const m = r.meta as { points?: number; reasonKey?: string | null; reason?: string | null; grantedBy?: string };
      return {
        id: r.id,
        at: r.createdAt,
        studentUserId: r.student.userId,
        studentName: r.student.user.fullName,
        points: m.points ?? 0,
        reasonKey: m.reasonKey ?? null,
        reason: m.reason ?? null,
        grantedByName: (m.grantedBy && names.get(m.grantedBy)) || null,
      };
    });
  }

}
