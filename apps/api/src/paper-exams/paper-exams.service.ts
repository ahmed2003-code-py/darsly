import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PaperExam, Prisma } from '@prisma/client';
import { AcademyContext } from '../academy/academy-context';
import { AcademyOpsAccessService } from '../academy-ops/academy-ops-access.service';
import { AuditService } from '../audit/audit.service';
import { dateValue } from '../class-ops/zoned-time';
import { PrismaService } from '../prisma/prisma.service';
import {
  CorrectDto,
  CreateExamDto,
  CreateMakeupDto,
  ExamsQuery,
  GradeSettingsDto,
  SaveResultsDto,
  UpdateExamDto,
} from './dto';
import { GRADE_DEFAULTS, GradesReadService, pctBps } from './grades-read.service';

type Tx = Prisma.TransactionClient;
const PAGE = 30;
const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Paper exams and their grades (Center Operations C6) — the writes.
 *
 * DRAFT: metadata and grades are edited freely (each change is a revision).
 * PUBLISHED: an academic record — its group, date and marks are frozen; a
 * grade changes only by a CORRECTION with a reason (grades.correct). VOID:
 * kept, excluded from academic truth. Only an empty draft is ever deleted.
 *
 * Every write takes the exam row lock first: publishing, saving and
 * correcting the same exam are serialised, and every grade carries a version
 * so a stale editor gets a conflict with the current value — never a silent
 * overwrite.
 */
@Injectable()
export class PaperExamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly read: GradesReadService,
    private readonly access: AcademyOpsAccessService,
    private readonly audit: AuditService,
  ) {}

  // ── Exams ──────────────────────────────────────────────────────────────

  /** Groups the caller may create exams for (all for the owner, assigned ones otherwise). */
  async groups(ctx: AcademyContext) {
    const reach = await this.read.reach(ctx);
    return this.prisma.group.findMany({
      where: {
        academyId: ctx.academyId,
        status: 'ACTIVE',
        ...(reach ? { id: { in: reach } } : {}),
      },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
  }

  async list(ctx: AcademyContext, q: ExamsQuery) {
    const reach = await this.read.reach(ctx);
    const page = q.page ?? 1;
    const where: Prisma.PaperExamWhereInput = {
      academyId: ctx.academyId,
      ...(reach ? { groupId: { in: reach } } : {}),
      ...(q.groupId ? { groupId: q.groupId } : {}),
      ...(q.status ? { status: q.status } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.paperExam.count({ where }),
      this.prisma.paperExam.findMany({
        where,
        orderBy: [{ examDate: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * PAGE,
        take: PAGE,
        include: { group: { select: { name: true } } },
      }),
    ]);
    const stats = await this.read.stats(rows.map((r) => r.id));
    return {
      total,
      page,
      pageSize: PAGE,
      items: rows.map((e) => ({
        ...this.view(e),
        groupName: e.group.name,
        stats: stats.get(e.id) ?? null,
      })),
    };
  }

  async create(ctx: AcademyContext, dto: CreateExamDto) {
    await this.access.assertGroupAccess(ctx, dto.groupId);
    if (dto.passScore != null && dto.passScore > dto.maxScore)
      throw new BadRequestException({
        message: 'The pass mark is above the maximum',
        code: 'PASS_ABOVE_MAX',
        field: 'passScore',
      });
    await this.assertLinks(ctx, dto.groupId, dto.groupSessionId, dto.subjectId);
    const prior = await this.prisma.paperExam.findUnique({
      where: { academyId_requestKey: { academyId: ctx.academyId, requestKey: dto.requestKey } },
    });
    if (prior)
      return this.replay(prior, { groupId: dto.groupId, title: dto.title.trim(), kind: 'REGULAR' });
    let exam: PaperExam;
    try {
      exam = await this.prisma.paperExam.create({
        data: {
          academyId: ctx.academyId,
          groupId: dto.groupId,
          groupSessionId: dto.groupSessionId ?? null,
          subjectId: dto.subjectId ?? null,
          title: dto.title.trim(),
          note: dto.note?.trim() || null,
          examDate: dateValue(dto.examDate),
          maxScore: dto.maxScore,
          passScore: dto.passScore ?? null,
          createdBy: ctx.userId,
          requestKey: dto.requestKey,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const won = await this.prisma.paperExam.findUniqueOrThrow({
          where: { academyId_requestKey: { academyId: ctx.academyId, requestKey: dto.requestKey } },
        });
        return this.replay(won, { groupId: dto.groupId, title: dto.title.trim(), kind: 'REGULAR' });
      }
      throw e;
    }
    await this.log(ctx, 'paper.exam.create', exam.id, { groupId: exam.groupId, kind: exam.kind });
    return { created: true, exam: this.view(exam) };
  }

  /** A later sitting of a PUBLISHED regular exam for learners who missed it. */
  async createMakeup(ctx: AcademyContext, originalId: string, dto: CreateMakeupDto) {
    const original = await this.read.examIn(ctx, originalId);
    if (original.kind !== 'REGULAR' || original.status !== 'PUBLISHED')
      throw new ConflictException({
        message: 'Only a published regular exam has makeups',
        code: 'MAKEUP_NOT_POSSIBLE',
      });
    await this.assertLinks(ctx, original.groupId, dto.groupSessionId, null);
    const prior = await this.prisma.paperExam.findUnique({
      where: { academyId_requestKey: { academyId: ctx.academyId, requestKey: dto.requestKey } },
    });
    const title = dto.title?.trim() || original.title;
    if (prior) return this.replay(prior, { groupId: original.groupId, title, kind: 'MAKEUP' });
    const exam = await this.prisma.paperExam.create({
      data: {
        academyId: ctx.academyId,
        groupId: original.groupId,
        groupSessionId: dto.groupSessionId ?? null,
        subjectId: original.subjectId,
        title,
        examDate: dateValue(dto.examDate),
        maxScore: original.maxScore,
        passScore: original.passScore,
        kind: 'MAKEUP',
        makeupOfExamId: original.id,
        createdBy: ctx.userId,
        requestKey: dto.requestKey,
      },
    });
    await this.log(ctx, 'paper.exam.create', exam.id, {
      groupId: exam.groupId,
      kind: 'MAKEUP',
      makeupOfExamId: original.id,
    });
    return { created: true, exam: this.view(exam) };
  }

  async update(ctx: AcademyContext, id: string, dto: UpdateExamDto) {
    await this.read.examIn(ctx, id);
    const exam = await this.prisma.$transaction(async (tx) => {
      const e = await this.lock(tx, ctx, id);
      if (e.status === 'VOID') throw this.err('EXAM_VOID', 'This exam was voided');
      const frozen: (keyof UpdateExamDto)[] = [
        'examDate',
        'maxScore',
        'passScore',
        'groupSessionId',
        'subjectId',
      ];
      if (e.status === 'PUBLISHED' && frozen.some((k) => dto[k] !== undefined))
        throw this.err(
          'EXAM_PUBLISHED',
          'A published exam keeps its date and marks — correct grades instead',
        );
      const results = await tx.paperExamResult.count({ where: { examId: id } });
      if (results && (dto.examDate !== undefined || dto.groupSessionId !== undefined))
        throw this.err(
          'ROSTER_LOCKED',
          'Grades were entered for this date — clear them before moving the exam',
        );
      if (e.kind === 'MAKEUP' && (dto.maxScore !== undefined || dto.passScore !== undefined))
        throw this.err('MAKEUP_MARKS_FIXED', "A makeup keeps its original exam's marks");
      const max = dto.maxScore ?? e.maxScore;
      const pass = dto.passScore === undefined ? e.passScore : dto.passScore;
      if (pass != null && pass > max)
        throw new BadRequestException({
          message: 'The pass mark is above the maximum',
          code: 'PASS_ABOVE_MAX',
          field: 'passScore',
        });
      if (dto.maxScore !== undefined) {
        const top = await tx.paperExamResult.aggregate({
          where: { examId: id },
          _max: { score: true },
        });
        if ((top._max.score ?? 0) > dto.maxScore)
          throw new BadRequestException({
            message: 'A grade already entered is above that maximum',
            code: 'MAX_BELOW_GRADE',
            field: 'maxScore',
          });
      }
      await this.assertLinks(
        ctx,
        e.groupId,
        dto.groupSessionId ?? undefined,
        dto.subjectId ?? undefined,
      );
      return tx.paperExam.update({
        where: { id },
        data: {
          ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
          ...(dto.note !== undefined ? { note: dto.note?.trim() || null } : {}),
          ...(dto.examDate !== undefined ? { examDate: dateValue(dto.examDate) } : {}),
          ...(dto.maxScore !== undefined ? { maxScore: dto.maxScore } : {}),
          ...(dto.passScore !== undefined ? { passScore: dto.passScore } : {}),
          ...(dto.groupSessionId !== undefined ? { groupSessionId: dto.groupSessionId } : {}),
          ...(dto.subjectId !== undefined ? { subjectId: dto.subjectId } : {}),
          version: { increment: 1 },
        },
      });
    });
    await this.log(ctx, 'paper.exam.update', id, { fields: Object.keys(dto) });
    return this.view(exam);
  }

  /** Only an empty draft disappears; anything else is voided instead. */
  async remove(ctx: AcademyContext, id: string) {
    await this.read.examIn(ctx, id);
    await this.prisma.$transaction(async (tx) => {
      const e = await this.lock(tx, ctx, id);
      if (e.status !== 'DRAFT')
        throw this.err('EXAM_NOT_DRAFT', 'Only a draft can be deleted — void it instead');
      if (await tx.paperExamResult.count({ where: { examId: id } }))
        throw this.err('EXAM_HAS_RESULTS', 'This exam has grades — clear them or void it');
      if (await tx.paperExam.count({ where: { makeupOfExamId: id } }))
        throw this.err('EXAM_HAS_MAKEUPS', 'This exam has makeups');
      // Grades were entered and cleared: that history stays — void it instead.
      if (await tx.paperExamRevision.count({ where: { examId: id } }))
        throw this.err('EXAM_HAS_HISTORY', 'This exam has grade history — void it instead');
      await tx.paperExam.delete({ where: { id } });
    });
    await this.log(ctx, 'paper.exam.delete', id, {});
    return { deleted: true };
  }

  // ── The grade sheet ────────────────────────────────────────────────────

  /**
   * The exam with its statistics and one row per learner who belongs on it:
   * a DRAFT regular exam lists its historical roster plus any guests; a
   * published one lists exactly its result rows (the frozen roster); a makeup
   * lists the learners who missed the original (and have no makeup elsewhere)
   * plus those already entered.
   */
  async sheet(ctx: AcademyContext, id: string) {
    const exam = await this.read.examIn(ctx, id);
    const [results, expected, stats, group, original, makeups, corrected] = await Promise.all([
      this.prisma.paperExamResult.findMany({ where: { examId: id } }),
      this.expectedFor(exam),
      this.read.stats([id]),
      this.prisma.group.findUnique({ where: { id: exam.groupId }, select: { name: true } }),
      exam.makeupOfExamId
        ? this.prisma.paperExam.findUnique({
            where: { id: exam.makeupOfExamId },
            select: { id: true, title: true, examDate: true },
          })
        : null,
      this.prisma.paperExam.findMany({
        where: { makeupOfExamId: id },
        orderBy: { examDate: 'asc' },
        select: { id: true, title: true, examDate: true, status: true },
      }),
      this.prisma.paperExamRevision.findMany({
        where: { examId: id, kind: 'CORRECTION' },
        distinct: ['academyStudentId'],
        select: { academyStudentId: true },
      }),
    ]);
    const byLearner = new Map(results.map((r) => [r.academyStudentId, r]));
    const ids = [...new Set([...expected, ...results.map((r) => r.academyStudentId)])];
    const learners = ids.length
      ? await this.prisma.academyStudent.findMany({
          where: { academyId: ctx.academyId, id: { in: ids } },
          select: { id: true, code: true, fullName: true, status: true },
        })
      : [];
    const expectedSet = new Set(expected);
    const correctedSet = new Set(corrected.map((c) => c.academyStudentId));
    const rows = learners
      .map((l) => {
        const r = byLearner.get(l.id);
        return {
          academyStudentId: l.id,
          code: l.code,
          fullName: l.fullName,
          learnerStatus: l.status,
          expected: expectedSet.has(l.id),
          result: r
            ? {
                status: r.status,
                score: r.score,
                pctBps: r.score == null ? null : pctBps(r.score, exam.maxScore),
                passed:
                  r.score == null || exam.passScore == null ? null : r.score >= exam.passScore,
                guest: r.guest,
                version: r.version,
                corrected: correctedSet.has(l.id),
              }
            : null,
        };
      })
      .sort((a, b) => a.fullName.localeCompare(b.fullName, 'ar'));
    const graded = rows.filter((r) => r.result).length;
    return {
      exam: {
        ...this.view(exam),
        groupName: group?.name ?? '',
        makeupOf: original ? { ...original, examDate: day(original.examDate) } : null,
        makeups: makeups.map((m) => ({ ...m, examDate: day(m.examDate) })),
      },
      stats: stats.get(id) ?? null,
      progress: { graded, total: exam.status === 'DRAFT' ? rows.length : graded },
      rows,
    };
  }

  /** Who belongs on the sheet before publication (see sheet()). */
  private async expectedFor(
    exam: PaperExam,
    db: Tx | PrismaService = this.prisma,
  ): Promise<string[]> {
    if (exam.status !== 'DRAFT') return [];
    if (exam.kind === 'REGULAR') return this.read.roster(exam, db);
    return this.makeupCandidates(exam, db);
  }

  /**
   * Learners ABSENT or EXCUSED in the original, minus those already holding an
   * effective makeup in another non-void makeup of it.
   */
  private async makeupCandidates(exam: PaperExam, db: Tx | PrismaService) {
    const rows = await db.$queryRaw<{ id: string }[]>`
      SELECT r."academyStudentId" AS id
      FROM "PaperExamResult" r
      WHERE r."examId" = ${exam.makeupOfExamId} AND r.status IN ('ABSENT', 'EXCUSED')
        AND NOT EXISTS (
          SELECT 1 FROM "PaperExamResult" o
          WHERE o."makeupKey" = r."examId" AND o."academyStudentId" = r."academyStudentId"
            AND o."examId" <> ${exam.id})`;
    return rows.map((r) => r.id);
  }

  // ── Saving draft grades ────────────────────────────────────────────────

  async saveResults(ctx: AcademyContext, id: string, dto: SaveResultsDto) {
    await this.read.examIn(ctx, id);
    const seen = new Set<string>();
    for (const r of dto.rows) {
      if (seen.has(r.academyStudentId))
        throw new BadRequestException({
          message: 'A learner appears twice',
          code: 'ROWS_DUPLICATE',
        });
      seen.add(r.academyStudentId);
    }
    let outcome: { replayed: boolean; saved: number; conflicts: unknown[] };
    try {
      outcome = await this.prisma.$transaction(async (tx) => {
        const exam = await this.lock(tx, ctx, id);
        // A retry or a double click of the same save: answer, change nothing.
        const done = await tx.paperExamRevision.findFirst({
          where: { examId: id, batchKey: dto.requestKey },
          select: { id: true },
        });
        if (done) return { replayed: true, saved: 0, conflicts: [] };
        if (exam.status !== 'DRAFT')
          throw this.err(
            exam.status === 'VOID' ? 'EXAM_VOID' : 'EXAM_PUBLISHED',
            'Grades of a published exam change only by correction',
          );
        const allowed = new Set(await this.expectedFor(exam, tx));
        const ids = dto.rows.map((r) => r.academyStudentId);
        const [learners, current] = await Promise.all([
          tx.academyStudent.findMany({
            where: { academyId: ctx.academyId, id: { in: ids } },
            select: { id: true, status: true },
          }),
          tx.paperExamResult.findMany({ where: { examId: id, academyStudentId: { in: ids } } }),
        ]);
        const known = new Map(learners.map((l) => [l.id, l]));
        const now = new Map(current.map((r) => [r.academyStudentId, r]));
        const invalid: { academyStudentId: string; code: string }[] = [];
        for (const r of dto.rows) {
          const l = known.get(r.academyStudentId);
          if (!l) invalid.push({ academyStudentId: r.academyStudentId, code: 'STUDENT_NOT_FOUND' });
          else if (r.status === 'SCORED' && (r.score ?? -1) > exam.maxScore)
            invalid.push({ academyStudentId: r.academyStudentId, code: 'MARKS_ABOVE_MAX' });
          else if (
            !allowed.has(r.academyStudentId) &&
            !now.get(r.academyStudentId)?.guest &&
            !now.has(r.academyStudentId)
          ) {
            if (exam.kind === 'MAKEUP')
              invalid.push({ academyStudentId: r.academyStudentId, code: 'NOT_MAKEUP_CANDIDATE' });
            else if (!r.guest)
              invalid.push({ academyStudentId: r.academyStudentId, code: 'NOT_ON_ROSTER' });
            else if (l.status !== 'ACTIVE')
              invalid.push({ academyStudentId: r.academyStudentId, code: 'STUDENT_WITHDRAWN' });
          }
        }
        if (invalid.length)
          throw new BadRequestException({
            message: 'Some rows cannot be saved',
            code: 'ROWS_INVALID',
            invalid,
          });
        const conflicts: {
          academyStudentId: string;
          current: { status: string; score: number | null; version: number } | null;
        }[] = [];
        let saved = 0;
        for (const r of dto.rows) {
          const cur = now.get(r.academyStudentId) ?? null;
          if ((cur?.version ?? null) !== (r.version ?? null)) {
            conflicts.push({
              academyStudentId: r.academyStudentId,
              current: cur ? { status: cur.status, score: cur.score, version: cur.version } : null,
            });
            continue;
          }
          const score = r.status === 'SCORED' ? r.score! : null;
          if (r.status === null) {
            if (!cur) continue;
            await tx.paperExamResult.delete({ where: { id: cur.id } });
          } else if (!cur) {
            await tx.paperExamResult.create({
              data: {
                academyId: ctx.academyId,
                examId: id,
                academyStudentId: r.academyStudentId,
                status: r.status,
                score,
                guest: !allowed.has(r.academyStudentId),
                enteredBy: ctx.userId,
              },
            });
          } else if (cur.status === r.status && cur.score === score) {
            continue;
          } else {
            await tx.paperExamResult.update({
              where: { id: cur.id },
              data: {
                status: r.status,
                score,
                enteredBy: ctx.userId,
                enteredAt: new Date(),
                version: { increment: 1 },
              },
            });
          }
          await tx.paperExamRevision.create({
            data: {
              academyId: ctx.academyId,
              examId: id,
              academyStudentId: r.academyStudentId,
              kind: r.status === null ? 'CLEAR' : 'ENTRY',
              fromStatus: cur?.status ?? null,
              fromScore: cur?.score ?? null,
              toStatus: r.status,
              toScore: score,
              actorUserId: ctx.userId,
              batchKey: dto.requestKey,
            },
          });
          saved++;
        }
        return { replayed: false, saved, conflicts };
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
        throw this.err(
          'MAKEUP_ALREADY_TAKEN',
          'A learner already has a makeup result for this exam',
        );
      throw e;
    }
    if (outcome.saved)
      await this.log(ctx, 'paper.results.save', id, {
        saved: outcome.saved,
        conflicts: outcome.conflicts.length,
      });
    return { ...outcome, sheet: await this.sheet(ctx, id) };
  }

  // ── Publication, correction, void ──────────────────────────────────────

  /**
   * Atomically, under the exam lock: rebuild the historical roster, require an
   * explicit result (SCORED / ABSENT / EXCUSED) for every expected learner and
   * nothing illegal, then DRAFT → PUBLISHED. The result rows are the frozen roster.
   */
  async publish(ctx: AcademyContext, id: string) {
    await this.read.examIn(ctx, id);
    const exam = await this.prisma.$transaction(async (tx) => {
      const e = await this.lock(tx, ctx, id);
      if (e.status === 'PUBLISHED') return e;
      if (e.status !== 'DRAFT') throw this.err('EXAM_VOID', 'This exam was voided');
      const rows = await tx.paperExamResult.findMany({
        where: { examId: id },
        select: { academyStudentId: true, guest: true },
      });
      if (!rows.length) throw this.err('EXAM_EMPTY', 'Enter at least one result before publishing');
      if (e.kind === 'REGULAR') {
        const roster = new Set(await this.read.roster(e, tx));
        const have = new Set(rows.map((r) => r.academyStudentId));
        const missing = [...roster].filter((x) => !have.has(x));
        if (missing.length)
          throw new ConflictException({
            message: 'Some learners have no result yet',
            code: 'ROSTER_INCOMPLETE',
            missing: missing.length,
            learners: missing,
          });
        const illegal = rows.filter((r) => !r.guest && !roster.has(r.academyStudentId));
        if (illegal.length)
          throw new ConflictException({
            message: 'Some results are not on the roster',
            code: 'ROSTER_MISMATCH',
            learners: illegal.map((r) => r.academyStudentId),
          });
      } else {
        const original = await tx.paperExam.findUniqueOrThrow({
          where: { id: e.makeupOfExamId! },
          select: { status: true },
        });
        if (original.status !== 'PUBLISHED')
          throw this.err('MAKEUP_NOT_POSSIBLE', 'The original exam is no longer published');
      }
      return tx.paperExam.update({
        where: { id },
        data: {
          status: 'PUBLISHED',
          publishedAt: new Date(),
          publishedBy: ctx.userId,
          version: { increment: 1 },
        },
      });
    });
    await this.log(ctx, 'paper.exam.publish', id, { kind: exam.kind });
    return this.view(exam);
  }

  /** A published grade, corrected: version-checked, reasoned, recorded. */
  async correct(ctx: AcademyContext, id: string, academyStudentId: string, dto: CorrectDto) {
    await this.read.examIn(ctx, id);
    let res;
    try {
      res = await this.prisma.$transaction(async (tx) => {
        const e = await this.lock(tx, ctx, id);
        if (e.status === 'DRAFT')
          throw this.err('EXAM_NOT_PUBLISHED', 'Edit draft grades on the sheet');
        if (e.status === 'VOID') throw this.err('EXAM_VOID', 'This exam was voided');
        const cur = await tx.paperExamResult.findUnique({
          where: { examId_academyStudentId: { examId: id, academyStudentId } },
        });
        if (!cur || cur.academyId !== ctx.academyId)
          throw new NotFoundException({
            message: 'No result for this learner',
            code: 'RESULT_NOT_FOUND',
          });
        if (cur.version !== dto.version)
          throw new ConflictException({
            message: 'Someone changed this grade first',
            code: 'VERSION_CONFLICT',
            current: { status: cur.status, score: cur.score, version: cur.version },
          });
        const score = dto.status === 'SCORED' ? dto.score! : null;
        if (score != null && score > e.maxScore)
          throw new BadRequestException({
            message: 'The score is above the maximum',
            code: 'MARKS_ABOVE_MAX',
            field: 'score',
          });
        if (cur.status === dto.status && cur.score === score)
          throw this.err('NO_CHANGE', 'That is already the grade');
        const updated = await tx.paperExamResult.update({
          where: { id: cur.id },
          data: { status: dto.status, score, version: { increment: 1 } },
        });
        await tx.paperExamRevision.create({
          data: {
            academyId: ctx.academyId,
            examId: id,
            academyStudentId,
            kind: 'CORRECTION',
            fromStatus: cur.status,
            fromScore: cur.score,
            toStatus: dto.status,
            toScore: score,
            reason: dto.reason.trim(),
            actorUserId: ctx.userId,
          },
        });
        return updated;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
        throw this.err(
          'MAKEUP_ALREADY_TAKEN',
          'This learner already has a makeup result for that exam',
        );
      throw e;
    }
    // Never the reason — ids and statuses only.
    await this.log(ctx, 'paper.result.correct', id, { academyStudentId, toStatus: res.status });
    return { status: res.status, score: res.score, version: res.version };
  }

  async voidExam(ctx: AcademyContext, id: string, reason: string) {
    await this.read.examIn(ctx, id);
    const exam = await this.prisma.$transaction(async (tx) => {
      const e = await this.lock(tx, ctx, id);
      if (e.status === 'VOID') return e;
      if (await tx.paperExam.count({ where: { makeupOfExamId: id, status: { not: 'VOID' } } }))
        throw this.err('EXAM_HAS_MAKEUPS', 'Void its makeups first');
      return tx.paperExam.update({
        where: { id },
        data: {
          status: 'VOID',
          voidedAt: new Date(),
          voidedBy: ctx.userId,
          voidReason: reason.trim(),
          version: { increment: 1 },
        },
      });
    });
    await this.log(ctx, 'paper.exam.void', id, {});
    return this.view(exam);
  }

  // ── Export, settings ───────────────────────────────────────────────────

  async exportCsv(ctx: AcademyContext, id: string) {
    const s = await this.sheet(ctx, id);
    // A cell a spreadsheet would run as a formula is defused with a leading quote.
    const cell = (v: string) => {
      let t = v;
      if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
      return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    // Hundredths as text with integer arithmetic only: 2650 → "26.50".
    const fixed2 = (h: number) => `${Math.trunc(h / 100)}.${String(h % 100).padStart(2, '0')}`;
    const marks = (h: number | null) => (h == null ? '' : fixed2(h));
    const lines = [
      ['code', 'name', 'status', 'score', 'max', 'percent', 'passed'].join(','),
      ...s.rows.map((r) =>
        [
          r.code,
          r.fullName,
          r.result?.status ?? 'UNGRADED',
          marks(r.result?.score ?? null),
          marks(s.exam.maxScore),
          r.result?.pctBps == null ? '' : fixed2(r.result.pctBps),
          r.result?.passed == null ? '' : r.result.passed ? 'yes' : 'no',
        ]
          .map(cell)
          .join(','),
      ),
    ];
    await this.log(ctx, 'paper.exam.export', id, { rows: s.rows.length });
    return { filename: `exam-${s.exam.examDate}.csv`, csv: '﻿' + lines.join('\r\n') + '\r\n' };
  }

  async getSettings(academyId: string) {
    return this.read.settings(academyId);
  }

  async updateSettings(ctx: AcademyContext, dto: GradeSettingsDto) {
    const before = await this.read.settings(ctx.academyId);
    const data = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined));
    await this.prisma.academyGradeSettings.upsert({
      where: { academyId: ctx.academyId },
      create: {
        academyId: ctx.academyId,
        ...GRADE_DEFAULTS,
        ...before,
        ...data,
        updatedBy: ctx.userId,
      },
      update: { ...data, updatedBy: ctx.userId },
    });
    const after = await this.read.settings(ctx.academyId);
    await this.log(ctx, 'paper.settings.update', ctx.academyId, { before, after });
    return after;
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async lock(tx: Tx, ctx: AcademyContext, id: string): Promise<PaperExam> {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "PaperExam" WHERE id = ${id} AND "academyId" = ${ctx.academyId} FOR UPDATE`;
    if (!row) throw new NotFoundException({ message: 'Exam not found', code: 'EXAM_NOT_FOUND' });
    return tx.paperExam.findUniqueOrThrow({ where: { id } });
  }

  private async assertLinks(
    ctx: AcademyContext,
    groupId: string,
    groupSessionId?: string | null,
    subjectId?: string | null,
  ) {
    if (groupSessionId) {
      const gs = await this.prisma.groupSession.findFirst({
        where: { id: groupSessionId, academyId: ctx.academyId, groupId },
        select: { id: true },
      });
      if (!gs)
        throw new NotFoundException({
          message: 'Class not found',
          code: 'SESSION_NOT_FOUND',
          field: 'groupSessionId',
        });
    }
    if (subjectId) {
      const s = await this.prisma.academySubject.findFirst({
        where: { id: subjectId, academyId: ctx.academyId },
        select: { id: true },
      });
      if (!s)
        throw new NotFoundException({
          message: 'Subject not found',
          code: 'SUBJECT_NOT_FOUND',
          field: 'subjectId',
        });
    }
  }

  private replay(
    prior: PaperExam,
    want: { groupId: string; title: string; kind: 'REGULAR' | 'MAKEUP' },
  ) {
    if (prior.groupId !== want.groupId || prior.title !== want.title || prior.kind !== want.kind)
      throw this.err('EXAM_KEY_REUSED', 'This request key was already used for something else');
    return { created: false, exam: this.view(prior) };
  }

  private err(code: string, message: string) {
    return new ConflictException({ message, code });
  }

  private log(
    ctx: AcademyContext,
    action: string,
    entityId: string,
    meta: Record<string, unknown>,
  ) {
    return this.audit.log({
      actorUserId: ctx.userId,
      action,
      entity: 'PaperExam',
      entityId,
      academyId: ctx.academyId,
      meta,
    });
  }

  view(e: PaperExam) {
    return {
      id: e.id,
      groupId: e.groupId,
      groupSessionId: e.groupSessionId,
      subjectId: e.subjectId,
      title: e.title,
      note: e.note,
      examDate: day(e.examDate),
      maxScore: e.maxScore,
      passScore: e.passScore,
      kind: e.kind,
      makeupOfExamId: e.makeupOfExamId,
      status: e.status,
      publishedAt: e.publishedAt?.toISOString() ?? null,
      voidedAt: e.voidedAt?.toISOString() ?? null,
      voidReason: e.voidReason,
      version: e.version,
    };
  }
}
