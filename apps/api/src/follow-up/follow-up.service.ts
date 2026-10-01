import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AcademyContext } from '../academy/academy-context';
import { AuditService } from '../audit/audit.service';
import { ClassScheduleService } from '../class-ops/class-schedule.service';
import { dateValue, localDayBounds } from '../class-ops/zoned-time';
import { PrismaService } from '../prisma/prisma.service';
import { AssignDto, LogContactDto, OpenCaseDto } from './dto';
import { FollowUpSignalsService } from './signals.service';

type Tx = Prisma.TransactionClient;
const PAGE = 50;

/** What a guardian link amounts to: invited (never opened), connected, or removed. */
export type GuardianState = 'INVITED' | 'CONNECTED' | 'REVOKED';
export const guardianState = (status: string, used: number): GuardianState =>
  status !== 'ACTIVE' ? 'REVOKED' : used > 0 ? 'CONNECTED' : 'INVITED';

/**
 * Follow-up cases and contact history — the only truth C5 owns.
 *
 * A case: opened by staff from a signal (verified against the live signal)
 * or by hand, assigned, then closed exactly once. A contact: one attempt to
 * reach the family, append-only. Every write is idempotent by its request
 * key, takes the learner's register-row lock (the lock C1–C4 use), and is
 * audited with ids and enums only — never a note, a name or a phone.
 */
@Injectable()
export class FollowUpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly signals: FollowUpSignalsService,
    private readonly schedule: ClassScheduleService,
    private readonly audit: AuditService,
  ) {}

  // ── Cases ──────────────────────────────────────────────────────────────

  async open(ctx: AcademyContext, dto: OpenCaseDto) {
    if (dto.reason === 'MANUAL' && dto.signalKey !== undefined)
      throw new BadRequestException({
        message: 'A case opened by hand is not about a signal',
        code: 'SIGNAL_KEY_NOT_ALLOWED',
        field: 'signalKey',
      });
    const s = await this.learner(ctx, dto.academyStudentId);
    const signalKey = dto.reason === 'MANUAL' ? null : dto.signalKey!;
    if (signalKey) {
      const { signals } = await this.signals.compute(ctx.academyId, { academyStudentId: s.id });
      if (!signals.some((x) => x.reason === dto.reason && x.signalKey === signalKey))
        throw new ConflictException({
          message: 'This signal is not (or no longer) raised for this learner',
          code: 'SIGNAL_NOT_FOUND',
        });
    }
    if (dto.assignedToUserId) await this.assertAssignee(ctx, dto.assignedToUserId);
    const same = (c: { academyStudentId: string; reason: string; signalKey: string | null }) =>
      c.academyStudentId === s.id && c.reason === dto.reason && c.signalKey === signalKey;
    const find = (tx: Tx | PrismaService) =>
      Promise.all([
        tx.studentFollowUp.findUnique({
          where: { academyId_requestKey: { academyId: ctx.academyId, requestKey: dto.requestKey } },
        }),
        signalKey
          ? tx.studentFollowUp.findFirst({
              where: { academyStudentId: s.id, reason: dto.reason, signalKey, status: 'OPEN' },
            })
          : null,
      ]);
    const settle = ([byKey, openSame]: Awaited<ReturnType<typeof find>>) => {
      if (byKey) {
        if (!same(byKey))
          throw new ConflictException({
            message: 'This request key was already used for something else',
            code: 'IDEMPOTENCY_KEY_REUSED',
          });
        return byKey;
      }
      return openSame;
    };
    let created = false;
    let row;
    try {
      row = await this.prisma.$transaction(async (tx) => {
        await this.lockStudent(tx, ctx.academyId, s.id);
        const prior = settle(await find(tx));
        if (prior) return prior;
        created = true;
        return tx.studentFollowUp.create({
          data: {
            academyId: ctx.academyId,
            academyStudentId: s.id,
            reason: dto.reason,
            signalKey,
            note: dto.note?.trim() || null,
            assignedToUserId: dto.assignedToUserId ?? null,
            dueOn: dto.dueOn ? dateValue(dto.dueOn) : null,
            openedBy: ctx.userId,
            requestKey: dto.requestKey,
          },
        });
      });
    } catch (e) {
      // Two opens of the same thing on two connections: one row won — answer with it.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        created = false;
        row = settle(await find(this.prisma));
        if (!row) throw e;
      } else throw e;
    }
    if (created)
      await this.audit.log({
        actorUserId: ctx.userId,
        action: 'followup.case.open',
        entity: 'StudentFollowUp',
        entityId: row.id,
        academyId: ctx.academyId,
        meta: { academyStudentId: s.id, reason: dto.reason, assigned: !!dto.assignedToUserId },
      });
    return { created, case: await this.caseView(ctx, row.id) };
  }

  async assign(ctx: AcademyContext, id: string, dto: AssignDto) {
    await this.caseIn(ctx, id);
    if (dto.assignedToUserId) await this.assertAssignee(ctx, dto.assignedToUserId);
    const res = await this.prisma.studentFollowUp.updateMany({
      where: { id, academyId: ctx.academyId, status: 'OPEN' },
      data: {
        assignedToUserId: dto.assignedToUserId,
        ...(dto.dueOn !== undefined ? { dueOn: dto.dueOn ? dateValue(dto.dueOn) : null } : {}),
      },
    });
    if (!res.count) throw this.closedError((await this.caseIn(ctx, id)).status);
    await this.audit.log({
      actorUserId: ctx.userId,
      action: 'followup.case.assign',
      entity: 'StudentFollowUp',
      entityId: id,
      academyId: ctx.academyId,
      meta: { assignedToUserId: dto.assignedToUserId },
    });
    return this.caseView(ctx, id);
  }

  /**
   * Close a case once. A compare-and-set on OPEN: of two people closing it at
   * the same moment exactly one succeeds; the other is told it is already
   * closed (or, if they asked for the very same thing, gets it unchanged).
   */
  async close(ctx: AcademyContext, id: string, status: 'RESOLVED' | 'DISMISSED', reason: string) {
    await this.caseIn(ctx, id);
    const res = await this.prisma.studentFollowUp.updateMany({
      where: { id, academyId: ctx.academyId, status: 'OPEN' },
      data: { status, closedAt: new Date(), closedBy: ctx.userId, closeReason: reason.trim() },
    });
    if (!res.count) {
      const now = await this.caseIn(ctx, id);
      if (now.status === status) return { changed: false, case: await this.caseView(ctx, id) };
      throw this.closedError(now.status);
    }
    await this.audit.log({
      actorUserId: ctx.userId,
      action: status === 'RESOLVED' ? 'followup.case.resolve' : 'followup.case.dismiss',
      entity: 'StudentFollowUp',
      entityId: id,
      academyId: ctx.academyId,
      meta: {},
    });
    return { changed: true, case: await this.caseView(ctx, id) };
  }

  async cases(
    ctx: AcademyContext,
    q: { status?: 'OPEN' | 'RESOLVED' | 'DISMISSED'; mine?: boolean; page?: number },
  ) {
    const page = q.page ?? 1;
    const where: Prisma.StudentFollowUpWhereInput = {
      academyId: ctx.academyId,
      status: q.status ?? 'OPEN',
      ...(q.mine ? { assignedToUserId: ctx.userId } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.studentFollowUp.count({ where }),
      this.prisma.studentFollowUp.findMany({
        where,
        orderBy: [{ openedAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * PAGE,
        take: PAGE,
        include: { academyStudent: { select: { id: true, fullName: true, code: true } } },
      }),
    ]);
    const names = await this.names(
      rows.flatMap((r) => [r.openedBy, r.assignedToUserId, r.closedBy]),
    );
    return { total, page, pageSize: PAGE, items: rows.map((r) => this.view(r, names)) };
  }

  // ── Contacts ───────────────────────────────────────────────────────────

  async logContact(ctx: AcademyContext, academyStudentId: string, dto: LogContactDto) {
    const s = await this.learner(ctx, academyStudentId);
    const payload = {
      channel: dto.channel,
      outcome: dto.outcome,
      party: dto.party,
      guardianLinkId: dto.party === 'GUARDIAN_LINK' ? dto.guardianLinkId! : null,
      followUpId: dto.followUpId ?? null,
      note: dto.note?.trim() || null,
    };
    if (dto.party !== 'GUARDIAN_LINK' && dto.guardianLinkId !== undefined)
      throw new BadRequestException({
        message: 'A guardian is named only when the guardian was contacted',
        code: 'CONTACT_PARTY_MISMATCH',
        field: 'guardianLinkId',
      });
    let created = false;
    const row = await this.prisma.$transaction(async (tx) => {
      await this.lockStudent(tx, ctx.academyId, s.id);
      const prior = await tx.studentContact.findUnique({
        where: { academyId_requestKey: { academyId: ctx.academyId, requestKey: dto.requestKey } },
      });
      if (prior) {
        const same =
          prior.academyStudentId === s.id &&
          (Object.keys(payload) as (keyof typeof payload)[]).every((k) => prior[k] === payload[k]);
        if (!same)
          throw new ConflictException({
            message: 'This request key was already used for something else',
            code: 'IDEMPOTENCY_KEY_REUSED',
          });
        return prior;
      }
      if (payload.guardianLinkId) {
        const link = await tx.guardianLink.findFirst({
          where: {
            id: payload.guardianLinkId,
            academyId: ctx.academyId,
            studentId: s.studentId,
            status: 'ACTIVE',
          },
          select: { id: true },
        });
        if (!link)
          throw new NotFoundException({
            message: 'That guardian is not linked to this learner',
            code: 'CONTACT_GUARDIAN_NOT_FOUND',
            field: 'guardianLinkId',
          });
      }
      if (payload.followUpId) {
        const c = await tx.studentFollowUp.findFirst({
          where: { id: payload.followUpId, academyId: ctx.academyId, academyStudentId: s.id },
          select: { status: true },
        });
        if (!c) throw new NotFoundException({ message: 'Case not found', code: 'CASE_NOT_FOUND' });
        if (c.status !== 'OPEN') throw this.closedError(c.status);
      }
      created = true;
      return tx.studentContact.create({
        data: {
          academyId: ctx.academyId,
          academyStudentId: s.id,
          ...payload,
          contactedBy: ctx.userId,
          requestKey: dto.requestKey,
        },
      });
    });
    if (created)
      await this.audit.log({
        actorUserId: ctx.userId,
        action: 'followup.contact.log',
        entity: 'StudentContact',
        entityId: row.id,
        academyId: ctx.academyId,
        // Never the note, a name or a phone.
        meta: {
          academyStudentId: s.id,
          channel: row.channel,
          outcome: row.outcome,
          party: row.party,
          followUpId: row.followUpId,
        },
      });
    const names = await this.names([row.contactedBy]);
    return { created, contact: this.contactView(row, names) };
  }

  /** Everyone contacted today (academy local day), newest first. */
  async contactsToday(ctx: AcademyContext, pageNo = 1) {
    const clock = await this.schedule.academyClock(ctx.academyId);
    const { start } = localDayBounds(clock.today, clock.timezone);
    const where = { academyId: ctx.academyId, contactedAt: { gte: start } };
    const [total, rows] = await Promise.all([
      this.prisma.studentContact.count({ where }),
      this.prisma.studentContact.findMany({
        where,
        orderBy: [{ contactedAt: 'desc' }, { id: 'asc' }],
        skip: (pageNo - 1) * PAGE,
        take: PAGE,
        include: { academyStudent: { select: { id: true, fullName: true, code: true } } },
      }),
    ]);
    const names = await this.names(rows.map((r) => r.contactedBy));
    return {
      today: clock.today,
      timezone: clock.timezone,
      total,
      page: pageNo,
      pageSize: PAGE,
      items: rows.map((r) => ({ ...this.contactView(r, names), student: r.academyStudent })),
    };
  }

  // ── One learner ────────────────────────────────────────────────────────

  /**
   * Student 360 → Follow-up: the learner, their cases and contacts, and who
   * can be reached — guardians (with their state) and the register's contact,
   * which is only a contact: it signs no one in and proves nothing.
   */
  async student(ctx: AcademyContext, academyStudentId: string) {
    const s = await this.learner(ctx, academyStudentId);
    const [cases, contacts, rec, links, clock] = await Promise.all([
      this.prisma.studentFollowUp.findMany({
        where: { academyId: ctx.academyId, academyStudentId: s.id },
        orderBy: { openedAt: 'desc' },
        take: 50,
      }),
      this.prisma.studentContact.findMany({
        where: { academyId: ctx.academyId, academyStudentId: s.id },
        orderBy: { contactedAt: 'desc' },
        take: 50,
      }),
      this.prisma.academyStudent.findUniqueOrThrow({
        where: { id: s.id },
        select: { studentPhone: true, guardianName: true, guardianPhone: true },
      }),
      this.prisma.guardianLink.findMany({
        where: { academyId: ctx.academyId, studentId: s.studentId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          relationship: true,
          status: true,
          guardian: { select: { user: { select: { fullName: true, phone: true } } } },
          tokens: { select: { useCount: true } },
        },
      }),
      this.schedule.academyClock(ctx.academyId),
    ]);
    const names = await this.names([
      ...cases.flatMap((c) => [c.openedBy, c.assignedToUserId, c.closedBy]),
      ...contacts.map((c) => c.contactedBy),
    ]);
    const guardians = links.map((l) => ({
      linkId: l.id,
      name: l.guardian.user.fullName,
      phone: l.guardian.user.phone,
      relationship: l.relationship,
      state: guardianState(
        l.status,
        l.tokens.reduce((t, x) => t + x.useCount, 0),
      ),
    }));
    const invited = rec.guardianPhone
      ? guardians.find((g) => g.phone === rec.guardianPhone && g.state !== 'REVOKED')
      : undefined;
    return {
      timezone: clock.timezone,
      student: { id: s.id, fullName: s.fullName, code: s.code, status: s.status },
      parties: {
        guardians,
        registerContact: rec.guardianPhone
          ? {
              name: rec.guardianName,
              phone: rec.guardianPhone,
              // A contact, not a guardian: only an explicit invitation makes one.
              invitedAs: invited?.linkId ?? null,
            }
          : null,
        studentPhone: rec.studentPhone,
      },
      cases: cases.map((c) => this.view(c, names)),
      contacts: contacts.map((c) => this.contactView(c, names)),
    };
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async learner(ctx: AcademyContext, academyStudentId: string) {
    const s = await this.prisma.academyStudent.findFirst({
      where: { id: academyStudentId, academyId: ctx.academyId },
      select: { id: true, fullName: true, code: true, status: true, studentId: true },
    });
    if (!s)
      throw new NotFoundException({ message: 'Student not found', code: 'STUDENT_NOT_FOUND' });
    return s;
  }

  private async lockStudent(tx: Tx, academyId: string, academyStudentId: string) {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "AcademyStudent" WHERE id = ${academyStudentId} AND "academyId" = ${academyId} FOR UPDATE`;
    if (!row)
      throw new NotFoundException({ message: 'Student not found', code: 'STUDENT_NOT_FOUND' });
  }

  private async caseIn(ctx: AcademyContext, id: string) {
    const c = await this.prisma.studentFollowUp.findFirst({
      where: { id, academyId: ctx.academyId },
    });
    if (!c) throw new NotFoundException({ message: 'Case not found', code: 'CASE_NOT_FOUND' });
    return c;
  }

  private async caseView(ctx: AcademyContext, id: string) {
    const c = await this.prisma.studentFollowUp.findFirstOrThrow({
      where: { id, academyId: ctx.academyId },
      include: { academyStudent: { select: { id: true, fullName: true, code: true } } },
    });
    return this.view(c, await this.names([c.openedBy, c.assignedToUserId, c.closedBy]));
  }

  private closedError(status: string) {
    return new ConflictException({
      message: 'This case is already closed',
      code: 'CASE_ALREADY_CLOSED',
      status,
    });
  }

  /** Someone who can work follow-up here: the owner, or a member granted followup.*. */
  private async assertAssignee(ctx: AcademyContext, userId: string) {
    const m = await this.prisma.academyMembership.findFirst({
      where: { academyId: ctx.academyId, userId, status: 'ACTIVE', deletedAt: null },
      select: { role: true, permissions: true },
    });
    const perms = Array.isArray(m?.permissions) ? (m.permissions as string[]) : [];
    if (
      !m ||
      !(m.role === 'OWNER' || perms.includes('followup.view') || perms.includes('followup.manage'))
    )
      throw new BadRequestException({
        message: 'That person cannot work on follow-up here',
        code: 'ASSIGNEE_INVALID',
        field: 'assignedToUserId',
      });
  }

  private async names(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    if (!unique.length) return new Map<string, string>();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, fullName: true },
    });
    return new Map(users.map((u) => [u.id, u.fullName]));
  }

  private view(
    c: {
      id: string;
      academyStudentId: string;
      reason: string;
      signalKey: string | null;
      note: string | null;
      status: string;
      assignedToUserId: string | null;
      dueOn: Date | null;
      openedBy: string;
      openedAt: Date;
      closedAt: Date | null;
      closedBy: string | null;
      closeReason: string | null;
      academyStudent?: { id: string; fullName: string; code: string };
    },
    names: Map<string, string>,
  ) {
    return {
      id: c.id,
      academyStudentId: c.academyStudentId,
      student: c.academyStudent ?? null,
      reason: c.reason,
      signalKey: c.signalKey,
      note: c.note,
      status: c.status,
      assignedTo: c.assignedToUserId
        ? { id: c.assignedToUserId, name: names.get(c.assignedToUserId) ?? '' }
        : null,
      dueOn: c.dueOn ? c.dueOn.toISOString().slice(0, 10) : null,
      openedBy: names.get(c.openedBy) ?? '',
      openedAt: c.openedAt.toISOString(),
      closedAt: c.closedAt?.toISOString() ?? null,
      closedBy: c.closedBy ? (names.get(c.closedBy) ?? '') : null,
      closeReason: c.closeReason,
    };
  }

  private contactView(
    c: {
      id: string;
      followUpId: string | null;
      party: string;
      guardianLinkId: string | null;
      channel: string;
      outcome: string;
      note: string | null;
      contactedAt: Date;
      contactedBy: string;
    },
    names: Map<string, string>,
  ) {
    return {
      id: c.id,
      followUpId: c.followUpId,
      party: c.party,
      guardianLinkId: c.guardianLinkId,
      channel: c.channel,
      outcome: c.outcome,
      note: c.note,
      contactedAt: c.contactedAt.toISOString(),
      contactedBy: names.get(c.contactedBy) ?? '',
    };
  }
}
