import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AcademyContext } from '../academy/academy-context';
import { INACTIVITY_DAYS } from '../analytics/analytics.constants';
import { PrismaService } from '../prisma/prisma.service';

/** Consecutive-absence records required to flag a student. Deliberately a
 *  plain count of real records, not a score. */
const REPEATED_ABSENCE_STREAK = 3;
/** Days without any attendance session before a group is flagged as not
 *  having attendance taken. */
const STALE_ATTENDANCE_DAYS = 14;

/**
 * Deterministic, rule-based operational surface — every item here is counted
 * from real rows, nothing inferred or scored. Non-OWNER staff only see
 * students/groups within groups they're assigned to, same resource scope as
 * the rest of academy-ops.
 */
@Injectable()
export class NeedsAttentionService {
  constructor(private readonly prisma: PrismaService) {}

  private async scopedGroupIds(ctx: AcademyContext): Promise<string[] | null> {
    if (ctx.role === 'OWNER') return null; // null = academy-wide, no filter
    const rows = await this.prisma.groupAssignment.findMany({ where: { userId: ctx.userId }, select: { groupId: true } });
    return rows.map((r) => r.groupId);
  }

  async overview(ctx: AcademyContext) {
    const scopedGroups = await this.scopedGroupIds(ctx);
    if (scopedGroups && scopedGroups.length === 0) {
      return { repeatedAbsences: [], inactiveStudents: [], staleGroups: [] };
    }
    const [repeatedAbsences, inactiveStudents, staleGroups] = await Promise.all([
      this.repeatedAbsences(ctx.academyId, scopedGroups),
      this.inactiveStudents(ctx.academyId, scopedGroups),
      this.staleGroups(ctx.academyId, scopedGroups),
    ]);
    return { repeatedAbsences, inactiveStudents, staleGroups };
  }

  /** Students whose most recent REPEATED_ABSENCE_STREAK attendance records —
   *  across any group in scope — are every one of them ABSENT. */
  private async repeatedAbsences(academyId: string, scopedGroups: string[] | null) {
    const rows = await this.prisma.$queryRaw<
      { studentId: string; fullName: string; groupId: string; groupName: string; streak: bigint }[]
    >`
      WITH ranked AS (
        SELECT
          r."studentId", r.status, s."groupId", s.date,
          ROW_NUMBER() OVER (PARTITION BY r."studentId", s."groupId" ORDER BY s.date DESC) AS rn
        FROM "AttendanceRecord" r
        JOIN "AttendanceSession" s ON s.id = r."sessionId"
        WHERE r."academyId" = ${academyId} AND r."deletedAt" IS NULL AND s."deletedAt" IS NULL
          ${scopedGroups ? Prisma.sql`AND s."groupId" = ANY(${scopedGroups}::text[])` : Prisma.sql``}
      )
      SELECT ranked."studentId", u."fullName", ranked."groupId", g.name AS "groupName",
        COUNT(*) FILTER (WHERE ranked.status = 'ABSENT') AS streak
      FROM ranked
      JOIN "StudentProfile" sp ON sp.id = ranked."studentId" AND sp."deletedAt" IS NULL
      JOIN "User" u ON u.id = sp."userId" AND u."deletedAt" IS NULL
      JOIN "Group" g ON g.id = ranked."groupId" AND g."deletedAt" IS NULL
      WHERE ranked.rn <= ${REPEATED_ABSENCE_STREAK}
      GROUP BY ranked."studentId", u."fullName", ranked."groupId", g.name
      HAVING COUNT(*) = ${REPEATED_ABSENCE_STREAK} AND COUNT(*) FILTER (WHERE ranked.status = 'ABSENT') = ${REPEATED_ABSENCE_STREAK}
    `;
    return rows.map((r) => ({ studentId: r.studentId, fullName: r.fullName, groupId: r.groupId, groupName: r.groupName, streak: Number(r.streak) }));
  }

  /** Actively-enrolled students with no gamification activity in
   *  INACTIVITY_DAYS days (or none ever recorded). */
  private async inactiveStudents(academyId: string, scopedGroups: string[] | null) {
    const rows = await this.prisma.$queryRaw<{ studentId: string; fullName: string; lastActivity: Date | null }[]>`
      SELECT sp.id AS "studentId", u."fullName", MAX(ge."createdAt") AS "lastActivity"
      FROM "StudentProfile" sp
      JOIN "User" u ON u.id = sp."userId" AND u."deletedAt" IS NULL
      JOIN "Enrollment" e ON e."studentId" = sp.id AND e."tenantId" = ${academyId} AND e.status = 'ACTIVE' AND e."deletedAt" IS NULL
      ${scopedGroups ? Prisma.sql`JOIN "GroupMembership" gm ON gm."studentId" = sp.id AND gm."groupId" = ANY(${scopedGroups}::text[]) AND gm."deletedAt" IS NULL` : Prisma.sql``}
      LEFT JOIN "GamificationEvent" ge ON ge."studentId" = sp.id AND ge."tenantId" = ${academyId}
      WHERE sp."deletedAt" IS NULL
      GROUP BY sp.id, u."fullName"
      HAVING MAX(ge."createdAt") IS NULL OR MAX(ge."createdAt") < NOW() - (${INACTIVITY_DAYS}::int * INTERVAL '1 day')
    `;
    return rows.map((r) => ({ studentId: r.studentId, fullName: r.fullName, lastActivityAt: r.lastActivity }));
  }

  /** Groups (in scope) with no attendance session in STALE_ATTENDANCE_DAYS
   *  days, or none ever taken. */
  private async staleGroups(academyId: string, scopedGroups: string[] | null) {
    const rows = await this.prisma.$queryRaw<{ groupId: string; name: string; lastSession: Date | null }[]>`
      SELECT g.id AS "groupId", g.name, MAX(s.date) AS "lastSession"
      FROM "Group" g
      LEFT JOIN "AttendanceSession" s ON s."groupId" = g.id AND s."deletedAt" IS NULL
      WHERE g."academyId" = ${academyId} AND g."deletedAt" IS NULL AND g.status = 'ACTIVE'
        ${scopedGroups ? Prisma.sql`AND g.id = ANY(${scopedGroups}::text[])` : Prisma.sql``}
      GROUP BY g.id, g.name
      HAVING MAX(s.date) IS NULL OR MAX(s.date) < NOW() - (${STALE_ATTENDANCE_DAYS}::int * INTERVAL '1 day')
    `;
    return rows.map((r) => ({ groupId: r.groupId, name: r.name, lastSessionAt: r.lastSession }));
  }
}
