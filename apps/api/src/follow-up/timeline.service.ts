import { Injectable, NotFoundException } from '@nestjs/common';
import { AcademyContext } from '../academy/academy-context';
import { CenterFeesService } from '../center-fees/center-fees.service';
import { ClassScheduleService } from '../class-ops/class-schedule.service';
import { wallClock } from '../class-ops/zoned-time';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { GradesReadService } from '../paper-exams/grades-read.service';
import { PrismaService } from '../prisma/prisma.service';

const LIMIT = 40;
/** A membership that ends and another that starts this close together is one transfer. */
const TRANSFER_WINDOW_MS = 5_000;

interface Event {
  at: Date;
  kind: string;
  ref: string;
  data: Record<string, unknown>;
}

/**
 * Student 360 timeline — a READ MODEL, composed on every request from the
 * domains that own each fact. Nothing here is stored and nothing is copied:
 *
 *   C1  registration, withdrawal/return (its audit trail), group stints
 *   C2  attendance records (and makeup visits)
 *   C3  card issued / revoked
 *   C4  fee events — only through CenterFeesService, and only for a caller
 *       holding fees.view where centerFees is on (never fetched otherwise)
 *   Guardian domain  guardians linked / removed
 *   C5  cases opened / closed, contacts
 *
 * Paged backwards by time: every source is asked for at most LIMIT events
 * before the cursor, the merge keeps the newest LIMIT (plus anything sharing
 * the last instant, so a page boundary never splits one moment).
 */
@Injectable()
export class TimelineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fees: CenterFeesService,
    private readonly flags: FeatureFlagsService,
    private readonly schedule: ClassScheduleService,
    private readonly grades: GradesReadService,
  ) {}

  async forStudent(ctx: AcademyContext, academyStudentId: string, beforeIso?: string) {
    const s = await this.prisma.academyStudent.findFirst({
      where: { id: academyStudentId, academyId: ctx.academyId },
      select: { id: true, studentId: true, createdAt: true, source: true },
    });
    if (!s)
      throw new NotFoundException({ message: 'Student not found', code: 'STUDENT_NOT_FOUND' });
    const parsed = beforeIso ? new Date(beforeIso) : null;
    const before = parsed && !isNaN(parsed.getTime()) ? parsed : new Date(Date.now() + 60_000);
    const showFees =
      ctx.can('fees.view') && (await this.flags.isEnabled(ctx.academyId, 'centerFees'));
    // C6 grade events: only for grades.view, only in reachable groups — never fetched otherwise.
    const gradeReach = ctx.can('grades.view') ? await this.grades.reach(ctx) : undefined;
    const clock = await this.schedule.academyClock(ctx.academyId);
    const a = ctx.academyId;
    const lt = { lt: before };

    const [
      audit,
      stints,
      attendance,
      cards,
      links,
      cases,
      closed,
      contacts,
      feeEvents,
      gradeEvents,
    ] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: {
          academyId: a,
          entity: 'AcademyStudent',
          entityId: s.id,
          action: { in: ['student.withdraw', 'student.reactivate'] },
          createdAt: lt,
        },
        orderBy: { createdAt: 'desc' },
        take: LIMIT,
        select: { id: true, action: true, createdAt: true },
      }),
      this.prisma.groupMembership.findMany({
        where: { academyId: a, studentId: s.studentId, OR: [{ addedAt: lt }, { deletedAt: lt }] },
        orderBy: { addedAt: 'desc' },
        take: LIMIT * 2,
        select: {
          id: true,
          addedAt: true,
          deletedAt: true,
          group: { select: { id: true, name: true } },
        },
      }),
      this.prisma.attendanceRecord.findMany({
        where: { academyId: a, studentId: s.studentId, deletedAt: null, markedAt: lt },
        orderBy: { markedAt: 'desc' },
        take: LIMIT,
        select: {
          id: true,
          status: true,
          method: true,
          markedAt: true,
          checkedInAt: true,
          homeGroupId: true,
          session: { select: { date: true, group: { select: { name: true } } } },
        },
      }),
      this.prisma.academyStudentCard.findMany({
        where: {
          academyId: a,
          academyStudentId: s.id,
          OR: [{ issuedAt: lt }, { revokedAt: lt }],
        },
        orderBy: { issuedAt: 'desc' },
        take: LIMIT,
        select: { id: true, issuedAt: true, revokedAt: true, revokeReason: true },
      }),
      this.prisma.guardianLink.findMany({
        where: {
          academyId: a,
          studentId: s.studentId,
          OR: [{ createdAt: lt }, { revokedAt: lt }],
        },
        orderBy: { createdAt: 'desc' },
        take: LIMIT,
        select: {
          id: true,
          relationship: true,
          createdAt: true,
          revokedAt: true,
          guardian: { select: { user: { select: { fullName: true } } } },
        },
      }),
      this.prisma.studentFollowUp.findMany({
        where: { academyId: a, academyStudentId: s.id, openedAt: lt },
        orderBy: { openedAt: 'desc' },
        take: LIMIT,
        select: { id: true, reason: true, openedAt: true, note: true },
      }),
      this.prisma.studentFollowUp.findMany({
        where: { academyId: a, academyStudentId: s.id, closedAt: lt },
        orderBy: { closedAt: 'desc' },
        take: LIMIT,
        select: { id: true, reason: true, status: true, closedAt: true, closeReason: true },
      }),
      this.prisma.studentContact.findMany({
        where: { academyId: a, academyStudentId: s.id, contactedAt: lt },
        orderBy: { contactedAt: 'desc' },
        take: LIMIT,
        select: {
          id: true,
          channel: true,
          outcome: true,
          party: true,
          note: true,
          contactedAt: true,
        },
      }),
      showFees ? this.fees.timelineEvents(a, s.id, before, LIMIT) : Promise.resolve([]),
      gradeReach !== undefined
        ? this.grades.timelineEvents(a, s.id, before, LIMIT, gradeReach)
        : Promise.resolve([]),
    ]);

    const events: Event[] = [];
    if (s.createdAt < before)
      events.push({ at: s.createdAt, kind: 'REGISTERED', ref: s.id, data: { source: s.source } });
    for (const x of audit)
      events.push({
        at: x.createdAt,
        kind: x.action === 'student.withdraw' ? 'WITHDRAWN' : 'REACTIVATED',
        ref: x.id,
        data: {},
      });

    // Group stints → joined / left, a near-simultaneous left+joined being one transfer.
    const ends = stints.filter((m) => m.deletedAt && m.deletedAt < before);
    const used = new Set<string>();
    for (const end of ends) {
      const next = stints.find(
        (m) =>
          m.id !== end.id &&
          !used.has(m.id) &&
          Math.abs(m.addedAt.getTime() - end.deletedAt!.getTime()) <= TRANSFER_WINDOW_MS,
      );
      if (next) {
        used.add(next.id);
        events.push({
          at: next.addedAt,
          kind: 'TRANSFERRED',
          ref: next.id,
          data: { from: end.group.name, to: next.group.name },
        });
      } else
        events.push({
          at: end.deletedAt!,
          kind: 'LEFT_GROUP',
          ref: end.id,
          data: { group: end.group.name },
        });
    }
    for (const m of stints)
      if (!used.has(m.id) && m.addedAt < before)
        events.push({
          at: m.addedAt,
          kind: 'JOINED_GROUP',
          ref: m.id,
          data: { group: m.group.name },
        });

    for (const r of attendance)
      events.push({
        at: r.checkedInAt ?? r.markedAt,
        kind: 'ATTENDANCE',
        ref: r.id,
        data: {
          status: r.status,
          method: r.method,
          makeup: !!r.homeGroupId,
          group: r.session.group.name,
          date: r.session.date.toISOString().slice(0, 10),
        },
      });
    for (const c of cards) {
      if (c.issuedAt < before)
        events.push({ at: c.issuedAt, kind: 'CARD_ISSUED', ref: c.id, data: {} });
      if (c.revokedAt && c.revokedAt < before)
        events.push({
          at: c.revokedAt,
          kind: 'CARD_REVOKED',
          ref: c.id,
          data: { reason: c.revokeReason },
        });
    }
    for (const l of links) {
      if (l.createdAt < before)
        events.push({
          at: l.createdAt,
          kind: 'GUARDIAN_LINKED',
          ref: l.id,
          data: { name: l.guardian.user.fullName, relationship: l.relationship },
        });
      if (l.revokedAt && l.revokedAt < before)
        events.push({
          at: l.revokedAt,
          kind: 'GUARDIAN_REMOVED',
          ref: l.id,
          data: { name: l.guardian.user.fullName, relationship: l.relationship },
        });
    }
    for (const c of cases)
      events.push({
        at: c.openedAt,
        kind: 'CASE_OPENED',
        ref: c.id,
        data: { reason: c.reason, note: c.note },
      });
    for (const c of closed)
      events.push({
        at: c.closedAt!,
        kind: c.status === 'RESOLVED' ? 'CASE_RESOLVED' : 'CASE_DISMISSED',
        ref: c.id,
        data: { reason: c.reason, closeReason: c.closeReason },
      });
    for (const c of contacts)
      events.push({
        at: c.contactedAt,
        kind: 'CONTACT',
        ref: c.id,
        data: { channel: c.channel, outcome: c.outcome, party: c.party, note: c.note },
      });
    for (const f of feeEvents) events.push(f);
    for (const g of gradeEvents) events.push(g);

    events.sort((x, y) => y.at.getTime() - x.at.getTime() || x.ref.localeCompare(y.ref));
    let page = events.slice(0, LIMIT);
    if (events.length > LIMIT) {
      const edge = page[page.length - 1].at.getTime();
      page = events.filter((e, i) => i < LIMIT || e.at.getTime() === edge);
    }
    const last = page[page.length - 1];
    return {
      timezone: clock.timezone,
      fees: showFees,
      items: page.map((e) => ({
        at: e.at.toISOString(),
        localDate: wallClock(e.at, clock.timezone).date,
        kind: e.kind,
        ref: e.ref,
        data: e.data,
      })),
      // A full page may have more behind it (any one source can be at its limit).
      nextBefore: page.length >= LIMIT && last ? last.at.toISOString() : null,
    };
  }
}
