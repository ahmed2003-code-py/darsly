import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AcademyStudentStatus, Prisma, Role } from '@prisma/client';
import { AcademyContext } from '../academy/academy-context';
import { GroupsService } from '../academy-ops/groups.service';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { AddToGroupDto, ListStudentsQuery, RegisterStudentDto, UpdateStudentDto } from './dto';
import { displayPhone, parsePhone, phoneField } from './phone';
import { digitsOnly, generateStudentCode, isValidStudentCode } from './student-code';

/** How many fresh codes a registration tries before giving up (a collision is ~1 in 90,000 per existing student). */
const CODE_ATTEMPTS = 8;
const DEFAULT_PAGE_SIZE = 25;
/** The most rows one export writes. */
const EXPORT_MAX = 20_000;

const RECORD_INCLUDE = {
  grade: { select: { id: true, nameAr: true, nameEn: true } },
  student: {
    select: {
      user: { select: { email: true, phone: true, username: true } },
    },
  },
} satisfies Prisma.AcademyStudentInclude;

type RecordRow = Prisma.AcademyStudentGetPayload<{ include: typeof RECORD_INCLUDE }>;

/** One learner on the register, as the desk sees them. */
export interface StudentRecordView {
  id: string;
  studentId: string;
  code: string;
  fullName: string;
  grade: { id: string; nameAr: string; nameEn: string } | null;
  studentPhone: string | null;
  guardianName: string | null;
  guardianPhone: string | null;
  school: string | null;
  status: AcademyStudentStatus;
  source: string;
  joinedAt: Date;
  leftAt: Date | null;
  /** Whether the learner can sign in to Darsly themselves (false for a desk-created record). */
  hasAccount: boolean;
  groups: { id: string; name: string }[];
}

export interface DuplicateCandidate {
  id: string;
  code: string;
  fullName: string;
  status: AcademyStudentStatus;
  grade: string | null;
}

/**
 * The academy's student register (Center Operations C1).
 *
 * Every method takes the AcademyContext the guards resolved and scopes every
 * read and write to `ctx.academyId`: a record, group or grade id from another
 * academy is simply not found (404), never "forbidden", so nothing here
 * confirms that another academy's data exists.
 */
@Injectable()
export class CenterStudentsService {
  private readonly logger = new Logger(CenterStudentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly groups: GroupsService,
  ) {}

  // ── Reading ────────────────────────────────────────────────────────────────

  /**
   * The directory: search by code, phone (the learner's or the guardian's) or
   * name, filtered by status, one page at a time.
   *
   * The query decides the path. Digits that form a valid code are an exact
   * code lookup; an Egyptian mobile number is an exact phone lookup; other
   * digits (a partial number, the start of a code) match code prefixes and
   * phone fragments; anything else is a name, matched word by word on the
   * normalised key (so "احمد محمد" finds "أحمد  مُحمد عبد الله").
   */
  async list(ctx: AcademyContext, query: ListStudentsQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const status = query.status ?? 'ACTIVE';
    const conds: Prisma.Sql[] = [Prisma.sql`s."academyId" = ${ctx.academyId}`];
    if (status !== 'ALL') conds.push(Prisma.sql`s."status" = ${status}::"AcademyStudentStatus"`);

    // Best name match first (exact, then prefix); none for code/phone lookups.
    let rank: Prisma.Sql | null = null;
    const q = (query.q ?? '').trim();
    if (q) {
      const digits = digitsOnly(q);
      if (digits) {
        const phone = parsePhone(digits);
        if (isValidStudentCode(digits)) {
          conds.push(Prisma.sql`s."code" = ${digits}`);
        } else if (phone && phone !== 'INVALID') {
          conds.push(Prisma.sql`(s."studentPhone" = ${phone} OR s."guardianPhone" = ${phone})`);
        } else if (digits.length >= 4) {
          const frag = `%${digits.replace(/^0+/, '')}%`;
          conds.push(
            Prisma.sql`(s."code" LIKE ${`${digits}%`} OR s."studentPhone" LIKE ${frag} OR s."guardianPhone" LIKE ${frag})`,
          );
        } else {
          conds.push(Prisma.sql`s."code" LIKE ${`${digits}%`}`);
        }
      } else {
        const [{ key }] = await this.prisma.$queryRaw<{ key: string | null }[]>`
          SELECT academy_student_name_key(${q}) AS key`;
        const words = (key ?? '').split(' ').filter(Boolean);
        if (!words.length) return { total: 0, page, pageSize, items: [] };
        for (const w of words)
          conds.push(Prisma.sql`s."nameNormalized" LIKE ${`%${likeEscape(w)}%`}`);
        const full = key!;
        rank = Prisma.sql`CASE WHEN s."nameNormalized" = ${full} THEN 0
                               WHEN s."nameNormalized" LIKE ${`${likeEscape(full)}%`} THEN 1
                               ELSE 2 END`;
      }
    }

    const where = Prisma.join(conds, ' AND ');
    const [countRow, idRows] = await Promise.all([
      this.prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM "AcademyStudent" s WHERE ${where}`,
      this.prisma.$queryRaw<{ id: string }[]>`
        SELECT s.id FROM "AcademyStudent" s WHERE ${where}
        ORDER BY ${rank ? Prisma.sql`${rank}, ` : Prisma.empty}s."nameNormalized", s.id
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    ]);
    const items = await this.views(
      ctx.academyId,
      idRows.map((r) => r.id),
    );
    return { total: Number(countRow[0]?.n ?? 0), page, pageSize, items };
  }

  async get(ctx: AcademyContext, id: string): Promise<StudentRecordView> {
    const [view] = await this.views(ctx.academyId, [id]);
    if (!view) throw notFound();
    return view;
  }

  /** The register record behind a StudentProfile, for Student 360 (null when the learner is not on it). */
  async forStudent(ctx: AcademyContext, studentId: string): Promise<StudentRecordView | null> {
    const row = await this.prisma.academyStudent.findUnique({
      where: { academyId_studentId: { academyId: ctx.academyId, studentId } },
      select: { id: true },
    });
    if (!row) return null;
    const [view] = await this.views(ctx.academyId, [row.id]);
    return view ?? null;
  }

  /** Records, in the order asked for, each with the learner's groups in this academy. */
  private async views(academyId: string, ids: string[]): Promise<StudentRecordView[]> {
    if (!ids.length) return [];
    const rows = await this.prisma.academyStudent.findMany({
      where: { academyId, id: { in: ids } },
      include: RECORD_INCLUDE,
    });
    const memberships = await this.prisma.groupMembership.findMany({
      where: {
        academyId,
        deletedAt: null,
        studentId: { in: rows.map((r) => r.studentId) },
        group: { deletedAt: null },
      },
      select: { studentId: true, group: { select: { id: true, name: true } } },
      orderBy: { addedAt: 'asc' },
    });
    const groupsOf = new Map<string, { id: string; name: string }[]>();
    for (const m of memberships) {
      const list = groupsOf.get(m.studentId) ?? [];
      list.push(m.group);
      groupsOf.set(m.studentId, list);
    }
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids
      .map((id) => byId.get(id))
      .filter((r): r is RecordRow => !!r)
      .map((r) => toView(r, groupsOf.get(r.studentId) ?? []));
  }

  /**
   * The directory as CSV (UTF-8 with a BOM, so Excel shows Arabic). Every
   * cell is text a person typed, so anything that could start a spreadsheet
   * formula is neutralised; phones are written as "010 1234 5678", which
   * Excel keeps as text instead of dropping the leading zero.
   */
  async exportCsv(ctx: AcademyContext, status: 'ACTIVE' | 'WITHDRAWN' | 'ALL' = 'ALL') {
    const rows = await this.prisma.academyStudent.findMany({
      where: { academyId: ctx.academyId, ...(status === 'ALL' ? {} : { status }) },
      include: RECORD_INCLUDE,
      orderBy: [{ nameNormalized: 'asc' }, { id: 'asc' }],
      take: EXPORT_MAX,
    });
    const memberships = await this.prisma.groupMembership.findMany({
      where: { academyId: ctx.academyId, deletedAt: null, group: { deletedAt: null } },
      select: { studentId: true, group: { select: { name: true } } },
    });
    const groupsOf = new Map<string, string[]>();
    for (const m of memberships) {
      groupsOf.set(m.studentId, [...(groupsOf.get(m.studentId) ?? []), m.group.name]);
    }
    const header = [
      'الكود',
      'الاسم',
      'الصف الدراسي',
      'تليفون الطالب',
      'اسم ولي الأمر',
      'تليفون ولي الأمر',
      'المدرسة',
      'الحالة',
      'المجموعات',
    ];
    const lines = [header.map(csvCell).join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.code,
          r.fullName,
          r.grade?.nameAr ?? '',
          displayPhone(r.studentPhone),
          r.guardianName ?? '',
          displayPhone(r.guardianPhone),
          r.school ?? '',
          r.status === 'ACTIVE' ? 'نشط' : 'منسحب',
          (groupsOf.get(r.studentId) ?? []).join(' / '),
        ]
          .map(csvCell)
          .join(','),
      );
    }
    await this.audit.log({
      actorUserId: ctx.userId,
      action: 'student.export',
      entity: 'AcademyStudent',
      academyId: ctx.academyId,
      meta: { status, rows: rows.length },
    });
    return { csv: '﻿' + lines.join('\r\n') + '\r\n', rows: rows.length };
  }

  // ── Writing ────────────────────────────────────────────────────────────────

  /**
   * Register a learner who walked in: a StudentProfile with no way to sign in
   * (a "shell" — a STUDENT user with no email, phone, username or password),
   * the academy's record of them, and optionally their first group — all in
   * one transaction, so a failure anywhere leaves nothing behind.
   *
   * Retry-safe: `requestKey` is stored on the record, so the same action
   * arriving twice (double click, network retry, a response lost after the
   * commit) returns the first learner instead of creating a second one — and
   * when two copies race, the unique index lets exactly one of them commit.
   */
  async register(ctx: AcademyContext, dto: RegisterStudentDto) {
    const requestKey = `desk:${dto.requestKey}`;
    const replay = await this.replayOf(ctx.academyId, requestKey);
    if (replay) return replay;

    const input = await this.cleanInput(ctx.academyId, dto);
    const group = dto.groupId ? await this.activeGroup(ctx.academyId, dto.groupId) : null;

    for (let attempt = 1; attempt <= CODE_ATTEMPTS; attempt++) {
      try {
        const { record, duplicatesOverridden } = await this.prisma.$transaction(async (tx) => {
          const overridden = await this.guardDuplicates(
            tx,
            ctx.academyId,
            input,
            !!dto.confirmDuplicate,
          );
          const user = await tx.user.create({
            data: {
              role: Role.STUDENT,
              fullName: input.fullName,
              studentProfile: {
                create: { gradeId: input.gradeId, provisionedByAcademyId: ctx.academyId },
              },
            },
            select: { studentProfile: { select: { id: true } } },
          });
          const studentId = user.studentProfile!.id;
          const record = await tx.academyStudent.create({
            data: {
              academyId: ctx.academyId,
              studentId,
              code: generateStudentCode(),
              ...input,
              source: 'DESK',
              createdByUserId: ctx.userId,
              requestKey,
            },
            select: { id: true, studentId: true, code: true },
          });
          if (group) await this.groups.writeMemberships(tx, ctx.academyId, group.id, [studentId]);
          return { record, duplicatesOverridden: overridden };
        });

        await this.audit.log({
          actorUserId: ctx.userId,
          action: 'student.register',
          entity: 'AcademyStudent',
          entityId: record.id,
          academyId: ctx.academyId,
          meta: { studentId: record.studentId, code: record.code, groupId: group?.id ?? null },
        });
        if (duplicatesOverridden.length) {
          await this.audit.log({
            actorUserId: ctx.userId,
            action: 'student.duplicate.override',
            entity: 'AcademyStudent',
            entityId: record.id,
            academyId: ctx.academyId,
            meta: { candidates: duplicatesOverridden },
          });
        }
        return { created: true, student: await this.get(ctx, record.id) };
      } catch (e) {
        const target = uniqueTarget(e);
        if (target?.includes('requestKey')) {
          // The same action committed first, from a concurrent copy.
          const first = await this.replayOf(ctx.academyId, requestKey);
          if (first) return first;
        }
        if (target?.includes('code')) {
          this.logger.warn(
            `student code collision in academy=${ctx.academyId}, attempt ${attempt}`,
          );
          continue;
        }
        throw e;
      }
    }
    throw new InternalServerErrorException({
      message: 'Could not allocate a student code',
      code: 'STUDENT_CODE_UNAVAILABLE',
    });
  }

  /** Edit what the academy records about a learner. */
  async update(ctx: AcademyContext, id: string, dto: UpdateStudentDto) {
    const current = await this.prisma.academyStudent.findFirst({
      where: { id, academyId: ctx.academyId },
      select: { id: true, studentId: true },
    });
    if (!current) throw notFound();

    const data: Prisma.AcademyStudentUpdateInput = {};
    const changed: string[] = [];
    if (dto.fullName !== undefined) {
      const fullName = cleanName(dto.fullName);
      if (!fullName) throw fieldError('fullName', 'NAME_REQUIRED', 'A name is required');
      data.fullName = fullName;
      changed.push('fullName');
    }
    if (dto.gradeId !== undefined) {
      const gradeId = dto.gradeId ? await this.gradeOrThrow(dto.gradeId) : null;
      data.grade = gradeId ? { connect: { id: gradeId } } : { disconnect: true };
      changed.push('gradeId');
    }
    for (const f of ['studentPhone', 'guardianPhone'] as const) {
      if (dto[f] !== undefined) {
        data[f] = phoneField(dto[f], f);
        changed.push(f);
      }
    }
    for (const f of ['guardianName', 'school'] as const) {
      if (dto[f] !== undefined) {
        data[f] = cleanText(dto[f]);
        changed.push(f);
      }
    }
    if (!changed.length) return this.get(ctx, id);

    await this.prisma.$transaction(async (tx) => {
      await tx.academyStudent.update({ where: { id }, data });
      // A learner this academy created (and who has not taken the account
      // over) is only known by what this academy says: keep the profile —
      // which lists, groups and attendance display — in step. An online
      // learner's own profile is theirs and is never touched from here.
      const shell = await tx.studentProfile.findFirst({
        where: {
          id: current.studentId,
          provisionedByAcademyId: ctx.academyId,
          user: { email: null, phone: null, username: null, passwordHash: null },
        },
        select: { id: true, userId: true },
      });
      if (shell) {
        if (data.fullName !== undefined) {
          await tx.user.update({
            where: { id: shell.userId },
            data: { fullName: data.fullName as string },
          });
        }
        if (dto.gradeId !== undefined) {
          await tx.studentProfile.update({
            where: { id: shell.id },
            data: { gradeId: dto.gradeId || null },
          });
        }
      }
    });
    await this.audit.log({
      actorUserId: ctx.userId,
      action: 'student.update',
      entity: 'AcademyStudent',
      entityId: id,
      academyId: ctx.academyId,
      // Which fields changed — never their values (names and phones are personal).
      meta: { fields: changed },
    });
    return this.get(ctx, id);
  }

  /**
   * The learner left. Not a delete: the record, its code, attendance, grades,
   * payments, guardian links, chats and online courses all stay. What ends is
   * their place in this academy's groups (the same removal a teacher makes
   * from the group page), because a class roster lists who is still coming.
   * Reactivating brings the record back; group places are given back by hand.
   *
   * Converges: withdrawing a withdrawn learner changes nothing and says so.
   * The row lock orders it against a concurrent reactivate or group add.
   */
  async withdraw(ctx: AcademyContext, id: string) {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const row = await this.lock(tx, ctx.academyId, id);
      if (row.status === 'WITHDRAWN')
        return { changed: false, studentId: row.studentId, groupIds: [] };
      await tx.academyStudent.update({
        where: { id },
        data: { status: 'WITHDRAWN', leftAt: new Date() },
      });
      const groupIds = await this.groups.endMemberships(tx, ctx.academyId, row.studentId);
      return { changed: true, studentId: row.studentId, groupIds };
    });
    if (outcome.changed) {
      await this.groups.leaveGroupChats(outcome.groupIds, outcome.studentId);
      await this.audit.log({
        actorUserId: ctx.userId,
        action: 'student.withdraw',
        entity: 'AcademyStudent',
        entityId: id,
        academyId: ctx.academyId,
        meta: { studentId: outcome.studentId, endedGroupIds: outcome.groupIds },
      });
    }
    return { changed: outcome.changed, student: await this.get(ctx, id) };
  }

  async reactivate(ctx: AcademyContext, id: string) {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const row = await this.lock(tx, ctx.academyId, id);
      if (row.status === 'ACTIVE') return { changed: false, studentId: row.studentId };
      await tx.academyStudent.update({ where: { id }, data: { status: 'ACTIVE', leftAt: null } });
      return { changed: true, studentId: row.studentId };
    });
    if (outcome.changed) {
      await this.audit.log({
        actorUserId: ctx.userId,
        action: 'student.reactivate',
        entity: 'AcademyStudent',
        entityId: id,
        academyId: ctx.academyId,
        meta: { studentId: outcome.studentId },
      });
    }
    return { changed: outcome.changed, student: await this.get(ctx, id) };
  }

  /**
   * Put a register learner into one of the academy's groups — the desk's
   * half of enrolment. Add only (taking someone out of a group stays with
   * group.manage on the group page). Idempotent: already a member → nothing
   * changes and `added` is false; the unique (group, learner) pair settles a
   * double click.
   */
  async addToGroup(ctx: AcademyContext, id: string, dto: AddToGroupDto) {
    const group = await this.activeGroup(ctx.academyId, dto.groupId);
    const outcome = await this.prisma.$transaction(async (tx) => {
      const row = await this.lock(tx, ctx.academyId, id);
      if (row.status !== 'ACTIVE') {
        throw new ConflictException({
          message: 'This student has withdrawn; reactivate them first',
          code: 'STUDENT_WITHDRAWN',
        });
      }
      const added = await this.groups.writeMemberships(tx, ctx.academyId, group.id, [
        row.studentId,
      ]);
      return { added: added.length > 0, studentId: row.studentId };
    });
    if (outcome.added) {
      await this.audit.log({
        actorUserId: ctx.userId,
        action: 'student.group.add',
        entity: 'AcademyStudent',
        entityId: id,
        academyId: ctx.academyId,
        meta: { studentId: outcome.studentId, groupId: group.id },
      });
    }
    return { added: outcome.added, student: await this.get(ctx, id) };
  }

  // ── Shared with the import ─────────────────────────────────────────────────

  /**
   * Records in this academy that look like the same person: the same
   * normalised name with the same guardian or learner phone. Advisory only —
   * siblings share a guardian's phone and differ by name; two learners may
   * share a name and differ by phone. Nothing is ever merged from this.
   */
  async duplicatesOf(
    db: Prisma.TransactionClient | PrismaService,
    academyId: string,
    input: { fullName: string; studentPhone: string | null; guardianPhone: string | null },
  ): Promise<DuplicateCandidate[]> {
    const phones = [input.studentPhone, input.guardianPhone].filter((p): p is string => !!p);
    if (!phones.length) return [];
    const rows = await db.$queryRaw<
      {
        id: string;
        code: string;
        fullName: string;
        status: AcademyStudentStatus;
        grade: string | null;
      }[]
    >`
      SELECT s.id, s.code, s."fullName", s.status, g."nameAr" AS grade
        FROM "AcademyStudent" s
        LEFT JOIN "GradeLevel" g ON g.id = s."gradeId"
       WHERE s."academyId" = ${academyId}
         AND s."nameNormalized" = academy_student_name_key(${input.fullName})
         AND (s."guardianPhone" = ANY(${phones}::text[]) OR s."studentPhone" = ANY(${phones}::text[]))
       ORDER BY s."createdAt"
       LIMIT 5`;
    return rows;
  }

  /**
   * Serialise registrations of one name in one academy, then check for a
   * possible duplicate — inside the caller's transaction, so two desks
   * registering the same child at the same moment cannot both pass the check.
   * Returns the candidates the operator chose to override (for the audit).
   */
  async guardDuplicates(
    tx: Prisma.TransactionClient,
    academyId: string,
    input: { fullName: string; studentPhone: string | null; guardianPhone: string | null },
    confirmed: boolean,
  ): Promise<string[]> {
    // (executeRaw: the lock function returns void, which a typed query cannot read)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`academy-student:${academyId}`}), hashtext(academy_student_name_key(${input.fullName})))`;
    const candidates = await this.duplicatesOf(tx, academyId, input);
    if (candidates.length && !confirmed) {
      throw new ConflictException({
        message: 'A student with this name and phone is already registered',
        code: 'STUDENT_POSSIBLE_DUPLICATE',
        candidates,
      });
    }
    return candidates.map((c) => c.id);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async replayOf(academyId: string, requestKey: string) {
    const prior = await this.prisma.academyStudent.findUnique({
      where: { academyId_requestKey: { academyId, requestKey } },
      select: { id: true },
    });
    if (!prior) return null;
    const [view] = await this.views(academyId, [prior.id]);
    return view ? { created: false, student: view } : null;
  }

  private async cleanInput(academyId: string, dto: RegisterStudentDto) {
    const fullName = cleanName(dto.fullName);
    if (!fullName) throw fieldError('fullName', 'NAME_REQUIRED', 'A name is required');
    return {
      fullName,
      gradeId: dto.gradeId ? await this.gradeOrThrow(dto.gradeId) : null,
      studentPhone: phoneField(dto.studentPhone, 'studentPhone'),
      guardianName: cleanText(dto.guardianName),
      guardianPhone: phoneField(dto.guardianPhone, 'guardianPhone'),
      school: cleanText(dto.school),
    };
  }

  private async gradeOrThrow(gradeId: string) {
    const g = await this.prisma.gradeLevel.findFirst({
      where: { id: gradeId, isActive: true },
      select: { id: true },
    });
    if (!g) throw fieldError('gradeId', 'GRADE_NOT_FOUND', 'Unknown school year');
    return g.id;
  }

  /** A live group of THIS academy — any other id is "not found". */
  async activeGroup(academyId: string, groupId: string) {
    const g = await this.prisma.group.findFirst({
      where: { id: groupId, academyId, deletedAt: null, status: 'ACTIVE' },
      select: { id: true, name: true },
    });
    if (!g) throw new NotFoundException({ message: 'Group not found', code: 'GROUP_NOT_FOUND' });
    return g;
  }

  /** The record, locked FOR UPDATE for this transaction; 404 outside this academy. */
  private async lock(tx: Prisma.TransactionClient, academyId: string, id: string) {
    const rows = await tx.$queryRaw<{ studentId: string; status: AcademyStudentStatus }[]>`
      SELECT "studentId", status FROM "AcademyStudent"
       WHERE id = ${id} AND "academyId" = ${academyId}
       FOR UPDATE`;
    if (!rows.length) throw notFound();
    return rows[0];
  }
}

function toView(r: RecordRow, groups: { id: string; name: string }[]): StudentRecordView {
  const u = r.student.user;
  return {
    id: r.id,
    studentId: r.studentId,
    code: r.code,
    fullName: r.fullName,
    grade: r.grade,
    studentPhone: r.studentPhone,
    guardianName: r.guardianName,
    guardianPhone: r.guardianPhone,
    school: r.school,
    status: r.status,
    source: r.source,
    joinedAt: r.joinedAt,
    leftAt: r.leftAt,
    hasAccount: !!(u.email || u.phone || u.username),
    groups,
  };
}

/** Trim and collapse inner whitespace; the display spelling is otherwise kept as typed. */
export function cleanName(raw: string | null | undefined): string {
  return (raw ?? '').replace(/[\s ]+/g, ' ').trim();
}

export function cleanText(raw: string | null | undefined): string | null {
  const s = cleanName(raw);
  return s || null;
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** CSV cell: quoted, with formula-leading characters neutralised. */
export function csvCell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return `"${safe.replace(/"/g, '""')}"`;
}

function uniqueTarget(e: unknown): string[] | null {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    const t = (e.meta as { target?: unknown } | undefined)?.target;
    return Array.isArray(t) ? (t as string[]) : typeof t === 'string' ? [t] : [];
  }
  return null;
}

function notFound() {
  return new NotFoundException({ message: 'Student not found', code: 'STUDENT_NOT_FOUND' });
}

function fieldError(field: string, code: string, message: string) {
  return new BadRequestException({ message, code, field });
}
