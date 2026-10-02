import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AcademyContext } from '../academy/academy-context';
import { ClassScheduleService } from '../class-ops/class-schedule.service';
import { localDayBounds } from '../class-ops/zoned-time';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { PrismaService } from '../prisma/prisma.service';

type Db = PrismaService | Prisma.TransactionClient;

/** Group reach: null = every group (the owner); otherwise the assigned groups. */
export type Reach = string[] | null;

export const GRADE_DEFAULTS = { lowGradePercent: 50, guardianGradesVisible: false };
export type GradeSettings = typeof GRADE_DEFAULTS;

export interface ExamStats {
  examId: string;
  /** Rows entered (SCORED + ABSENT + EXCUSED). */
  entered: number;
  scored: number;
  absent: number;
  excused: number;
  /** Hundredths, over SCORED only; null when nothing is scored. */
  average: number | null;
  median: number | null;
  highest: number | null;
  lowest: number | null;
  /** Only when the exam has a pass mark: passed SCORED / all SCORED. */
  passed: number | null;
  /** Basis points (0–10000) of passed / scored; null without a pass mark or scores. */
  passRateBps: number | null;
}

/** Round-half-up percentage in basis points, integer arithmetic only. */
export function pctBps(score: number, max: number): number {
  return Math.floor((score * 20_000 + max) / (2 * max));
}

/**
 * C6 reads — the ONE place that knows the roster rule, the statistics, what an
 * effective result is and what is low. Everything else that shows a grade
 * (the exam screens, Student 360, the C5 signal and timeline, the guardian
 * portal) asks here, so there is one formula for each.
 *
 *  - Roster: who was in the exam's group when it was sat — the linked class's
 *    time span, or the academy-local exam day — from membership HISTORY (raw
 *    SQL: the soft-delete middleware hides ended stints), never today's group.
 *  - Effective result of a learner on a REGULAR exam: a SCORED result of a
 *    PUBLISHED makeup of it, else their own result. The original stays as it
 *    was; nothing is overwritten.
 *  - Statistics: SCORED results only. Absent, excused and ungraded are never 0.
 */
@Injectable()
export class GradesReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly schedule: ClassScheduleService,
    private readonly flags: FeatureFlagsService,
  ) {}

  // ── Reach ──────────────────────────────────────────────────────────────

  async reach(ctx: AcademyContext): Promise<Reach> {
    if (ctx.role === 'OWNER' || ctx.isPlatformAdmin) return null;
    const rows = await this.prisma.groupAssignment.findMany({
      where: { userId: ctx.userId, academyId: ctx.academyId },
      select: { groupId: true },
    });
    return rows.map((r) => r.groupId);
  }

  /** The exam, if it is this academy's (404 otherwise) and its group is reachable (403 otherwise). */
  async examIn(ctx: AcademyContext, examId: string, db: Db = this.prisma) {
    const exam = await db.paperExam.findFirst({ where: { id: examId, academyId: ctx.academyId } });
    if (!exam) throw new NotFoundException({ message: 'Exam not found', code: 'EXAM_NOT_FOUND' });
    const reach = await this.reach(ctx);
    if (reach && !reach.includes(exam.groupId))
      throw new ForbiddenException({
        message: 'You are not assigned to this group',
        code: 'GROUP_NOT_ASSIGNED',
      });
    return exam;
  }

  async settings(academyId: string): Promise<GradeSettings> {
    const row = await this.prisma.academyGradeSettings.findUnique({ where: { academyId } });
    return row
      ? { lowGradePercent: row.lowGradePercent, guardianGradesVisible: row.guardianGradesVisible }
      : { ...GRADE_DEFAULTS };
  }

  // ── Roster ─────────────────────────────────────────────────────────────

  /**
   * Learners expected at a REGULAR exam: in its group at some moment of the
   * linked class (or of the academy-local exam day), and not withdrawn before
   * it began. Reproducible for any past exam — membership history only.
   */
  async roster(
    exam: { academyId: string; groupId: string; examDate: Date; groupSessionId: string | null },
    db: Db = this.prisma,
  ): Promise<string[]> {
    let start: Date;
    let end: Date;
    if (exam.groupSessionId) {
      const gs = await db.groupSession.findUniqueOrThrow({
        where: { id: exam.groupSessionId },
        select: { startAt: true, endAt: true },
      });
      start = gs.startAt;
      end = gs.endAt;
    } else {
      const clock = await this.schedule.academyClock(exam.academyId);
      ({ start, end } = localDayBounds(exam.examDate.toISOString().slice(0, 10), clock.timezone));
    }
    const rows = await db.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT s.id
      FROM "GroupMembership" m
      JOIN "AcademyStudent" s ON s."academyId" = m."academyId" AND s."studentId" = m."studentId"
      WHERE m."groupId" = ${exam.groupId} AND m."academyId" = ${exam.academyId}
        AND m."addedAt" < (${end.toISOString()}::timestamptz AT TIME ZONE 'UTC')
        AND (m."deletedAt" IS NULL OR m."deletedAt" > (${start.toISOString()}::timestamptz AT TIME ZONE 'UTC'))
        AND (s.status = 'ACTIVE' OR s."leftAt" > (${start.toISOString()}::timestamptz AT TIME ZONE 'UTC'))`;
    return rows.map((r) => r.id);
  }

  // ── Statistics (the single implementation) ─────────────────────────────

  async stats(examIds: string[], db: Db = this.prisma): Promise<Map<string, ExamStats>> {
    if (!examIds.length) return new Map();
    const rows = await db.$queryRaw<
      {
        examId: string;
        entered: number;
        scored: number;
        absent: number;
        excused: number;
        average: number | null;
        median: number | null;
        highest: number | null;
        lowest: number | null;
        passed: number | null;
      }[]
    >`
      SELECT e.id AS "examId",
             count(r.id)::int AS entered,
             count(r.id) FILTER (WHERE r.status = 'SCORED')::int AS scored,
             count(r.id) FILTER (WHERE r.status = 'ABSENT')::int AS absent,
             count(r.id) FILTER (WHERE r.status = 'EXCUSED')::int AS excused,
             round(avg(r.score) FILTER (WHERE r.status = 'SCORED'))::int AS average,
             round((percentile_cont(0.5) WITHIN GROUP (ORDER BY r.score)
                    FILTER (WHERE r.status = 'SCORED'))::numeric)::int AS median,
             max(r.score) FILTER (WHERE r.status = 'SCORED')::int AS highest,
             min(r.score) FILTER (WHERE r.status = 'SCORED')::int AS lowest,
             CASE WHEN e."passScore" IS NULL THEN NULL
                  ELSE (count(r.id) FILTER (WHERE r.status = 'SCORED' AND r.score >= e."passScore"))::int END AS passed
      FROM "PaperExam" e
      LEFT JOIN "PaperExamResult" r ON r."examId" = e.id
      WHERE e.id = ANY(${examIds}::text[])
      GROUP BY e.id, e."passScore"`;
    return new Map(
      rows.map((r) => [
        r.examId,
        {
          ...r,
          passRateBps:
            r.passed == null || !r.scored
              ? null
              : Math.floor((r.passed * 20_000 + r.scored) / (2 * r.scored)),
        },
      ]),
    );
  }

  // ── One learner ────────────────────────────────────────────────────────

  /**
   * A learner's published academic history, oldest first: every PUBLISHED
   * exam (regular and makeup) they have a result on, in groups the caller
   * reaches, with whether it was corrected and how a makeup relates.
   */
  async history(academyId: string, academyStudentId: string, reach: Reach) {
    const rows = await this.prisma.$queryRaw<
      {
        examId: string;
        title: string;
        examDate: Date;
        groupId: string;
        groupName: string;
        kind: 'REGULAR' | 'MAKEUP';
        makeupOfExamId: string | null;
        maxScore: number;
        passScore: number | null;
        status: 'SCORED' | 'ABSENT' | 'EXCUSED';
        score: number | null;
        guest: boolean;
        corrected: boolean;
        publishedAt: Date;
      }[]
    >`
      SELECT e.id AS "examId", e.title, e."examDate", e."groupId", g.name AS "groupName", e.kind,
             e."makeupOfExamId", e."maxScore", e."passScore", r.status, r.score, r.guest,
             EXISTS (SELECT 1 FROM "PaperExamRevision" v WHERE v."examId" = e.id
                       AND v."academyStudentId" = r."academyStudentId" AND v.kind = 'CORRECTION') AS corrected,
             e."publishedAt"
      FROM "PaperExamResult" r
      JOIN "PaperExam" e ON e.id = r."examId"
      JOIN "Group" g ON g.id = e."groupId"
      WHERE r."academyId" = ${academyId} AND r."academyStudentId" = ${academyStudentId}
        AND e.status = 'PUBLISHED'
        ${reach ? Prisma.sql`AND e."groupId" = ANY(${reach}::text[])` : Prisma.empty}
      ORDER BY e."examDate", e."publishedAt"`;
    return rows.map((r) => ({
      ...r,
      examDate: r.examDate.toISOString().slice(0, 10),
      publishedAt: r.publishedAt.toISOString(),
      pctBps: r.score == null ? null : pctBps(r.score, r.maxScore),
      passed: r.score == null || r.passScore == null ? null : r.score >= r.passScore,
    }));
  }

  /**
   * LOW_GRADE (derived for C5; never stored): on a PUBLISHED regular exam since
   * `since`, a learner's EFFECTIVE result is SCORED and below the exam's pass
   * mark — or, without one, below the academy's lowGradePercent (exact integer
   * comparison). Absent / excused never count; drafts and void exams never
   * count; a correction or a makeup changes it by itself. One query.
   */
  async lowGrades(academyId: string, since: string, reach: Reach, academyStudentId?: string) {
    if (!(await this.flags.isEnabled(academyId, 'paperExams'))) return [];
    const { lowGradePercent } = await this.settings(academyId);
    const rows = await this.prisma.$queryRaw<
      {
        academyStudentId: string;
        examId: string;
        groupId: string;
        groupName: string;
        examDate: Date;
        score: number;
        max: number;
      }[]
    >`
      WITH eff AS (
        SELECT o.id AS "examId", o."groupId", o."examDate", r."academyStudentId",
               COALESCE(mk.score, CASE WHEN r.status = 'SCORED' THEN r.score END) AS score,
               COALESCE(mk.max, o."maxScore") AS max,
               CASE WHEN mk.score IS NOT NULL THEN mk.pass ELSE o."passScore" END AS pass
        FROM "PaperExam" o
        JOIN "PaperExamResult" r ON r."examId" = o.id
        LEFT JOIN LATERAL (
          SELECT mr.score, me."maxScore" AS max, me."passScore" AS pass
          FROM "PaperExamResult" mr JOIN "PaperExam" me ON me.id = mr."examId"
          WHERE mr."makeupKey" = o.id AND mr."academyStudentId" = r."academyStudentId" AND me.status = 'PUBLISHED'
        ) mk ON true
        WHERE o."academyId" = ${academyId} AND o.kind = 'REGULAR' AND o.status = 'PUBLISHED'
          AND o."examDate" >= ${since}::date
          ${reach ? Prisma.sql`AND o."groupId" = ANY(${reach}::text[])` : Prisma.empty}
          ${academyStudentId ? Prisma.sql`AND r."academyStudentId" = ${academyStudentId}` : Prisma.empty}
      )
      SELECT eff."academyStudentId", eff."examId", eff."groupId", g.name AS "groupName", eff."examDate",
             eff.score, eff.max
      FROM eff
      JOIN "AcademyStudent" s ON s.id = eff."academyStudentId" AND s.status = 'ACTIVE'
      JOIN "Group" g ON g.id = eff."groupId"
      WHERE eff.score IS NOT NULL
        AND ((eff.pass IS NOT NULL AND eff.score < eff.pass)
          OR (eff.pass IS NULL AND eff.score::bigint * 100 < ${lowGradePercent}::bigint * eff.max))`;
    return rows.map((r) => ({
      academyStudentId: r.academyStudentId,
      examId: r.examId,
      groupId: r.groupId,
      groupName: r.groupName,
      examDate: r.examDate.toISOString().slice(0, 10),
      pctBps: pctBps(r.score, r.max),
    }));
  }

  /**
   * Grade events for the C5 timeline of a caller who holds grades.view: a
   * result published, a published result corrected. Never a reason, never who.
   */
  async timelineEvents(
    academyId: string,
    academyStudentId: string,
    before: Date,
    limit: number,
    reach: Reach,
  ) {
    if (!(await this.flags.isEnabled(academyId, 'paperExams'))) return [];
    const scope = reach ? Prisma.sql`AND e."groupId" = ANY(${reach}::text[])` : Prisma.empty;
    const [published, corrected] = await Promise.all([
      this.prisma.$queryRaw<
        {
          id: string;
          title: string;
          publishedAt: Date;
          status: string;
          score: number | null;
          maxScore: number;
          kind: string;
        }[]
      >`
        SELECT r.id, e.title, e."publishedAt", r.status, r.score, e."maxScore", e.kind
        FROM "PaperExamResult" r JOIN "PaperExam" e ON e.id = r."examId"
        WHERE r."academyId" = ${academyId} AND r."academyStudentId" = ${academyStudentId}
          AND e.status = 'PUBLISHED' AND e."publishedAt" < (${before.toISOString()}::timestamptz AT TIME ZONE 'UTC') ${scope}
        ORDER BY e."publishedAt" DESC LIMIT ${limit}`,
      this.prisma.$queryRaw<
        {
          id: string;
          title: string;
          at: Date;
          toStatus: string;
          toScore: number | null;
          maxScore: number;
        }[]
      >`
        SELECT v.id, e.title, v.at, v."toStatus", v."toScore", e."maxScore"
        FROM "PaperExamRevision" v JOIN "PaperExam" e ON e.id = v."examId"
        WHERE v."academyId" = ${academyId} AND v."academyStudentId" = ${academyStudentId}
          AND v.kind = 'CORRECTION' AND e.status = 'PUBLISHED' AND v.at < (${before.toISOString()}::timestamptz AT TIME ZONE 'UTC') ${scope}
        ORDER BY v.at DESC LIMIT ${limit}`,
    ]);
    return [
      ...published.map((p) => ({
        at: p.publishedAt,
        kind: 'GRADE_PUBLISHED' as const,
        ref: p.id,
        data: {
          title: p.title,
          status: p.status,
          score: p.score,
          maxScore: p.maxScore,
          makeup: p.kind === 'MAKEUP',
        },
      })),
      ...corrected.map((c) => ({
        at: c.at,
        kind: 'GRADE_CORRECTED' as const,
        ref: c.id,
        data: { title: c.title, status: c.toStatus, score: c.toScore, maxScore: c.maxScore },
      })),
    ];
  }

  /**
   * What a guardian may see (C6, Gate 5): nothing unless the academy has paper
   * exams on AND chose to show guardians grades. Then only PUBLISHED, non-void
   * results: title, date, score / max, percentage, pass/fail when the exam has
   * a pass mark, and how a makeup relates. Never drafts, notes, correction
   * reasons, revisions, who, other learners or ranks.
   */
  async guardianView(academyId: string, academyStudentId: string) {
    if (!(await this.flags.isEnabled(academyId, 'paperExams'))) return null;
    if (!(await this.settings(academyId)).guardianGradesVisible) return null;
    const rows = await this.history(academyId, academyStudentId, null);
    return rows.map((r) => ({
      examId: r.examId,
      title: r.title,
      examDate: r.examDate,
      kind: r.kind,
      makeupOfExamId: r.makeupOfExamId,
      status: r.status,
      score: r.score,
      maxScore: r.maxScore,
      pctBps: r.pctBps,
      passed: r.passed,
    }));
  }
}
