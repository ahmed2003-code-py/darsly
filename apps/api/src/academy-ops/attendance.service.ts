import { BadRequestException, Injectable } from '@nestjs/common';
import { AcademyContext } from '../academy/academy-context';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { AcademyOpsAccessService } from './academy-ops-access.service';
import { MarkAttendanceDto } from './dto/academy-ops.dto';

@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AcademyOpsAccessService,
    private readonly audit: AuditService,
  ) {}

  /** Every member of the group, merged with that date's records if a session
   *  already exists — so the teacher always sees the full roster to mark,
   *  never just whoever happens to have a record yet. */
  async sessionFor(ctx: AcademyContext, groupId: string, date: string) {
    await this.access.assertGroupAccess(ctx, groupId);
    const [members, session] = await Promise.all([
      this.prisma.groupMembership.findMany({
        where: { groupId, deletedAt: null },
        select: { student: { select: { id: true, user: { select: { fullName: true, avatarUrl: true } } } } },
      }),
      this.prisma.attendanceSession.findUnique({
        where: { groupId_date: { groupId, date: new Date(date) } },
        include: { records: { select: { studentId: true, status: true } } },
      }),
    ]);
    const statusByStudent = new Map((session?.records ?? []).map((r) => [r.studentId, r.status]));
    return {
      sessionId: session?.id ?? null,
      date,
      students: members.map((m) => ({
        studentId: m.student.id,
        fullName: m.student.user.fullName,
        avatarUrl: m.student.user.avatarUrl,
        status: statusByStudent.get(m.student.id) ?? null,
      })),
    };
  }

  /** Creates the session on first mark for a date, upserts every record —
   *  editing an already-taken date's attendance is the same call, not a
   *  separate endpoint. */
  async mark(ctx: AcademyContext, groupId: string, dto: MarkAttendanceDto) {
    await this.access.assertGroupAccess(ctx, groupId);

    // Every record must be a genuine member of THIS group — never a bare
    // studentId that happens to belong to someone else's roster.
    const memberIds = new Set(
      (await this.prisma.groupMembership.findMany({ where: { groupId, deletedAt: null }, select: { studentId: true } }))
        .map((m) => m.studentId),
    );
    const invalid = dto.records.filter((r) => !memberIds.has(r.studentId));
    if (invalid.length) {
      throw new BadRequestException({
        message: 'Some records are for students not in this group',
        code: 'NOT_GROUP_MEMBERS',
        invalid: invalid.map((r) => r.studentId),
      });
    }

    const date = new Date(dto.date);
    const session = await this.prisma.attendanceSession.upsert({
      where: { groupId_date: { groupId, date } },
      create: { groupId, academyId: ctx.academyId, date, createdBy: ctx.userId },
      update: {},
    });

    await this.prisma.$transaction(
      dto.records.map((r) =>
        this.prisma.attendanceRecord.upsert({
          where: { sessionId_studentId: { sessionId: session.id, studentId: r.studentId } },
          create: { sessionId: session.id, studentId: r.studentId, status: r.status, academyId: ctx.academyId, markedBy: ctx.userId },
          update: { status: r.status, markedBy: ctx.userId },
        }),
      ),
    );

    await this.audit.log({
      actorUserId: ctx.userId, action: 'attendance.mark', entity: 'AttendanceSession', entityId: session.id, academyId: ctx.academyId,
      meta: { groupId, date: dto.date, count: dto.records.length },
    });

    return this.sessionFor(ctx, groupId, dto.date);
  }

  /** A student's attendance history within this academy. Non-OWNER callers
   *  only see records from groups they're assigned to — the same
   *  resource-level scope as everything else here, applied indirectly since
   *  the request is keyed by student rather than by group. */
  async studentHistory(ctx: AcademyContext, studentId: string) {
    const assignedGroupIds =
      ctx.role === 'OWNER'
        ? null
        : (await this.prisma.groupAssignment.findMany({ where: { userId: ctx.userId }, select: { groupId: true } })).map((a) => a.groupId);

    const records = await this.prisma.attendanceRecord.findMany({
      where: {
        studentId,
        academyId: ctx.academyId,
        ...(assignedGroupIds ? { session: { groupId: { in: assignedGroupIds } } } : {}),
      },
      orderBy: { session: { date: 'desc' } },
      take: 200,
      select: { status: true, markedAt: true, session: { select: { date: true, group: { select: { id: true, name: true } } } } },
    });
    return records.map((r) => ({ date: r.session.date, group: r.session.group, status: r.status, markedAt: r.markedAt }));
  }
}
