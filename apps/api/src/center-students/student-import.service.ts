import {
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { AcademyContext } from '../academy/academy-context';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { cleanName, cleanText } from './center-students.service';
import { ImportPreviewDto, ImportRowDto } from './dto';
import { GradeMatcher } from './grade-matcher';
import { parsePhone } from './phone';
import { generateStudentCode } from './student-code';

/** A preview not committed within this window is discarded. */
const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
/** Rows written per transaction. */
const CHUNK = 100;
/** How long one commit may hold the batch before another may take it over. */
const LEASE_MS = 2 * 60 * 1000;

export type RowStatus = 'OK' | 'WARNING' | 'ERROR' | 'DUPLICATE';
export interface RowIssue {
  field: string;
  code: string;
}

/** A row as the server interpreted it — what the preview shows. */
export interface PreviewRow {
  row: number;
  status: RowStatus;
  issues: RowIssue[];
  data: {
    fullName: string;
    studentPhone: string | null;
    guardianName: string | null;
    guardianPhone: string | null;
    school: string | null;
    gradeId: string | null;
    gradeName: string | null;
    groupId: string | null;
    groupName: string | null;
  };
  /** DUPLICATE: the record this row appears to be. */
  existing?: { code: string; fullName: string };
}

/** What is stored for commit: only rows that will be written, already interpreted. */
type StoredRow = PreviewRow['data'] & { row: number; nameKey: string };

export interface ImportResultRow {
  row: number;
  status: 'CREATED' | 'SKIPPED';
  code?: string;
  reason?: string;
}

/**
 * Spreadsheet import onto the register.
 *
 * Preview: the browser sends the sheet's cells as text; the server applies
 * the very rules a desk registration does (the same name key, the same phone
 * normaliser, the same year and group lookup, scoped to this academy),
 * classifies every row, and stores the rows it would write. Nothing is
 * written to the register.
 *
 * Commit names the preview and nothing else. It writes the stored rows in
 * chunks, each row under requestKey `import:<id>:<row>`, so the commit is
 * safe to repeat: a double click, a second tab, a retry after a lost response
 * or a crash half-way all converge on one import. A lease stops two commits
 * running at once; a stale lease (a commit that died) can be taken over and
 * the import resumes where it stopped.
 */
@Injectable()
export class StudentImportService {
  private readonly logger = new Logger(StudentImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async preview(ctx: AcademyContext, dto: ImportPreviewDto) {
    // Abandoned previews hold names and phones; they do not outlive a day.
    await this.prisma.studentImport.deleteMany({
      where: {
        academyId: ctx.academyId,
        status: 'PREVIEWED',
        createdAt: { lt: new Date(Date.now() - PREVIEW_TTL_MS) },
      },
    });

    const input = dto.rows;
    const [grades, groups, nameKeys] = await Promise.all([
      this.prisma.gradeLevel.findMany({
        where: { isActive: true },
        select: { id: true, code: true, nameAr: true, nameEn: true, stage: true },
      }),
      this.prisma.$queryRaw<{ id: string; name: string; key: string }[]>`
        SELECT id, name, academy_student_name_key(name) AS key FROM "Group"
         WHERE "academyId" = ${ctx.academyId} AND "deletedAt" IS NULL AND status = 'ACTIVE'`,
      this.keys(input.flatMap((r) => [r.fullName ?? '', r.group ?? ''])),
    ]);
    const gradeMatcher = new GradeMatcher(grades);
    const groupsByKey = new Map<string, { id: string; name: string }[]>();
    for (const g of groups) groupsByKey.set(g.key, [...(groupsByKey.get(g.key) ?? []), g]);

    const rows: (PreviewRow & { nameKey: string })[] = input.map((r, i) =>
      this.interpret(r, nameKeys[2 * i], nameKeys[2 * i + 1], gradeMatcher, groupsByKey),
    );

    // Duplicates inside the sheet: the same person twice (same name and a shared phone).
    const seen = new Map<string, number>();
    for (const r of rows) {
      if (r.status === 'ERROR') continue;
      for (const p of [r.data.studentPhone, r.data.guardianPhone]) {
        if (!p) continue;
        const k = `${r.nameKey}|${p}`;
        const first = seen.get(k);
        if (first !== undefined && first !== r.row) {
          r.status = 'ERROR';
          r.issues.push({ field: 'row', code: 'DUPLICATE_IN_FILE' });
          break;
        }
        seen.set(k, r.row);
      }
    }

    // Duplicates of learners already on the register: skipped, never merged.
    await this.markRegistered(ctx.academyId, rows);

    const storable: StoredRow[] = rows
      .filter((r) => r.status === 'OK' || r.status === 'WARNING')
      .map((r) => ({ ...r.data, row: r.row, nameKey: r.nameKey }));
    const contentHash = createHash('sha256')
      .update(JSON.stringify(input.map((r) => ({ ...r }))))
      .digest('hex');
    const earlier = await this.prisma.studentImport.findFirst({
      where: { academyId: ctx.academyId, contentHash, status: 'COMMITTED' },
      orderBy: { committedAt: 'desc' },
      select: { committedAt: true },
    });

    const batch = await this.prisma.studentImport.create({
      data: {
        academyId: ctx.academyId,
        contentHash,
        fileName: dto.fileName?.slice(0, 200) ?? null,
        rows: storable as unknown as Prisma.InputJsonValue,
        totalRows: rows.length,
        validRows: storable.length,
        createdByUserId: ctx.userId,
      },
      select: { id: true },
    });

    const counts = { OK: 0, WARNING: 0, ERROR: 0, DUPLICATE: 0 } as Record<RowStatus, number>;
    for (const r of rows) counts[r.status]++;
    return {
      id: batch.id,
      totalRows: rows.length,
      validRows: storable.length,
      counts,
      alreadyImportedAt: earlier?.committedAt ?? null,
      rows: rows.map(({ nameKey: _k, ...r }) => r),
    };
  }

  /** One row read by the same rules as a desk registration. */
  private interpret(
    r: ImportRowDto,
    nameKey: string,
    groupKey: string,
    grades: GradeMatcher,
    groupsByKey: Map<string, { id: string; name: string }[]>,
  ): PreviewRow & { nameKey: string } {
    const issues: RowIssue[] = [];
    const warnings: RowIssue[] = [];
    const fullName = cleanName(r.fullName);
    if (!fullName || !nameKey) issues.push({ field: 'fullName', code: 'NAME_REQUIRED' });

    const phone = (raw: string | undefined, field: string) => {
      const p = parsePhone(raw);
      if (p === 'INVALID') {
        issues.push({ field, code: 'INVALID_PHONE' });
        return null;
      }
      return p;
    };
    const studentPhone = phone(r.studentPhone, 'studentPhone');
    const guardianPhone = phone(r.guardianPhone, 'guardianPhone');

    let gradeId: string | null = null;
    let gradeName: string | null = null;
    if (cleanText(r.grade)) {
      const g = grades.match(r.grade!);
      if (g) {
        gradeId = g.id;
        gradeName = g.nameAr;
      } else issues.push({ field: 'grade', code: 'GRADE_NOT_FOUND' });
    } else warnings.push({ field: 'grade', code: 'GRADE_MISSING' });

    let groupId: string | null = null;
    let groupName: string | null = null;
    if (cleanText(r.group)) {
      const found = groupsByKey.get(groupKey) ?? [];
      if (found.length === 1) {
        groupId = found[0].id;
        groupName = found[0].name;
      } else {
        issues.push({ field: 'group', code: found.length ? 'GROUP_AMBIGUOUS' : 'GROUP_NOT_FOUND' });
      }
    }
    if (!studentPhone && !guardianPhone && !issues.some((i) => i.code === 'INVALID_PHONE')) {
      warnings.push({ field: 'guardianPhone', code: 'NO_PHONE' });
    }

    const status: RowStatus = issues.length ? 'ERROR' : warnings.length ? 'WARNING' : 'OK';
    return {
      row: r.row,
      status,
      issues: [...issues, ...warnings],
      nameKey,
      data: {
        fullName,
        studentPhone,
        guardianName: cleanText(r.guardianName),
        guardianPhone,
        school: cleanText(r.school),
        gradeId,
        gradeName,
        groupId,
        groupName,
      },
    };
  }

  /** Normalised keys for many strings in one round trip (the SQL function is the only normaliser). */
  private async keys(values: string[]): Promise<string[]> {
    if (!values.length) return [];
    const rows = await this.prisma.$queryRaw<{ i: bigint; key: string | null }[]>`
      SELECT i, academy_student_name_key(v) AS key
        FROM unnest(${values}::text[]) WITH ORDINALITY AS t(v, i)`;
    const out = new Array<string>(values.length).fill('');
    for (const r of rows) out[Number(r.i) - 1] = r.key ?? '';
    return out;
  }

  /** Flag rows that match a learner already on the register (same name key and a shared phone). */
  private async markRegistered(
    academyId: string,
    rows: (PreviewRow & { nameKey: string })[],
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    const live = rows.filter((r) => r.status === 'OK' || r.status === 'WARNING');
    const keys = [...new Set(live.map((r) => r.nameKey))];
    if (!keys.length) return;
    const existing = await db.$queryRaw<
      {
        nameNormalized: string;
        studentPhone: string | null;
        guardianPhone: string | null;
        code: string;
        fullName: string;
      }[]
    >`
      SELECT "nameNormalized", "studentPhone", "guardianPhone", code, "fullName"
        FROM "AcademyStudent"
       WHERE "academyId" = ${academyId} AND "nameNormalized" = ANY(${keys}::text[])`;
    const byPhone = new Map<string, { code: string; fullName: string }>();
    for (const e of existing) {
      for (const p of [e.studentPhone, e.guardianPhone]) {
        if (p) byPhone.set(`${e.nameNormalized}|${p}`, { code: e.code, fullName: e.fullName });
      }
    }
    for (const r of live) {
      for (const p of [r.data.studentPhone, r.data.guardianPhone]) {
        const hit = p ? byPhone.get(`${r.nameKey}|${p}`) : undefined;
        if (hit) {
          r.status = 'DUPLICATE';
          r.issues.push({ field: 'row', code: 'ALREADY_REGISTERED' });
          r.existing = hit;
          break;
        }
      }
    }
  }

  /** The batch as the operator last saw it (for polling a commit that is running). */
  async get(ctx: AcademyContext, id: string) {
    const imp = await this.prisma.studentImport.findFirst({
      where: { id, academyId: ctx.academyId },
      select: {
        id: true,
        status: true,
        totalRows: true,
        validRows: true,
        createdCount: true,
        skippedCount: true,
        results: true,
        committedAt: true,
        createdAt: true,
      },
    });
    if (!imp) throw importNotFound();
    return imp;
  }

  async commit(ctx: AcademyContext, id: string) {
    const imp = await this.prisma.studentImport.findFirst({
      where: { id, academyId: ctx.academyId },
      select: { status: true, createdAt: true },
    });
    if (!imp) throw importNotFound();
    if (imp.status === 'COMMITTED') return this.get(ctx, id);
    if (imp.status === 'PREVIEWED' && imp.createdAt.getTime() < Date.now() - PREVIEW_TTL_MS) {
      throw new GoneException({
        message: 'This preview has expired; upload the file again',
        code: 'IMPORT_EXPIRED',
      });
    }

    // Take the batch: from PREVIEWED, or from a commit whose lease ran out.
    const now = new Date();
    const claimed = await this.prisma.studentImport.updateMany({
      where: {
        id,
        academyId: ctx.academyId,
        OR: [{ status: 'PREVIEWED' }, { status: 'COMMITTING', leaseUntil: { lt: now } }],
      },
      data: { status: 'COMMITTING', leaseUntil: new Date(now.getTime() + LEASE_MS) },
    });
    if (claimed.count !== 1) {
      const again = await this.get(ctx, id);
      if (again.status === 'COMMITTED') return again;
      throw new ConflictException({
        message: 'This import is being committed',
        code: 'IMPORT_COMMIT_IN_PROGRESS',
        retryable: true,
      });
    }

    const batch = await this.prisma.studentImport.findUniqueOrThrow({
      where: { id },
      select: { rows: true },
    });
    const rows = (batch.rows ?? []) as unknown as StoredRow[];
    const results: ImportResultRow[] = [];
    try {
      for (let i = 0; i < rows.length; i += CHUNK) {
        results.push(...(await this.writeChunk(ctx, id, rows.slice(i, i + CHUNK))));
        await this.prisma.studentImport.updateMany({
          where: { id, status: 'COMMITTING' },
          data: { leaseUntil: new Date(Date.now() + LEASE_MS) },
        });
      }
    } catch (e) {
      // Let the next attempt take over at once; every chunk already written
      // is recognised by its request keys and not written again.
      await this.prisma.studentImport
        .updateMany({ where: { id, status: 'COMMITTING' }, data: { leaseUntil: new Date(0) } })
        .catch(() => undefined);
      throw e;
    }

    const created = results.filter((r) => r.status === 'CREATED').length;
    await this.prisma.studentImport.updateMany({
      where: { id, status: 'COMMITTING' },
      data: {
        status: 'COMMITTED',
        committedAt: new Date(),
        leaseUntil: null,
        // The names and phones have done their job; only outcomes remain.
        rows: Prisma.DbNull,
        results: results as unknown as Prisma.InputJsonValue,
        createdCount: created,
        skippedCount: results.length - created,
      },
    });
    await this.audit.log({
      actorUserId: ctx.userId,
      action: 'student.import',
      entity: 'StudentImport',
      entityId: id,
      academyId: ctx.academyId,
      meta: { created, skipped: results.length - created },
    });
    return this.get(ctx, id);
  }

  /**
   * One chunk, one transaction, each row at most once. Retried as a whole if
   * a desk registration took one of its fresh codes in the meantime.
   */
  private async writeChunk(
    ctx: AcademyContext,
    importId: string,
    chunk: StoredRow[],
  ): Promise<ImportResultRow[]> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.prisma.$transaction((tx) => this.writeChunkTx(tx, ctx, importId, chunk), {
          timeout: 60_000,
        });
      } catch (e) {
        const isCode =
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002' &&
          JSON.stringify(e.meta?.target ?? '').includes('code');
        if (isCode && attempt < 5) {
          this.logger.warn(`import ${importId}: code collision, retrying chunk (${attempt})`);
          continue;
        }
        throw e;
      }
    }
  }

  private async writeChunkTx(
    tx: Prisma.TransactionClient,
    ctx: AcademyContext,
    importId: string,
    chunk: StoredRow[],
  ): Promise<ImportResultRow[]> {
    const academyId = ctx.academyId;
    // The same per-name locks a desk registration takes, in a fixed order, so
    // a desk registering one of these learners right now is either seen by
    // the duplicate check below or waits for this chunk.
    for (const key of [...new Set(chunk.map((r) => r.nameKey))].sort()) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`academy-student:${academyId}`}), hashtext(${key}))`;
    }

    const keyOf = (r: StoredRow) => `import:${importId}:${r.row}`;
    const done = await tx.academyStudent.findMany({
      where: { academyId, requestKey: { in: chunk.map(keyOf) } },
      select: { requestKey: true, code: true },
    });
    const doneByKey = new Map(done.map((d) => [d.requestKey!, d.code]));

    // Re-check the register now: someone may have been registered since the preview.
    const probe = chunk.map((r) => ({
      row: r.row,
      status: 'OK' as RowStatus,
      issues: [] as RowIssue[],
      nameKey: r.nameKey,
      data: r,
    }));
    await this.markRegistered(academyId, probe as never, tx);
    const liveGroups = new Set(
      (
        await tx.group.findMany({
          where: {
            academyId,
            deletedAt: null,
            status: 'ACTIVE',
            id: { in: chunk.map((r) => r.groupId).filter((g): g is string => !!g) },
          },
          select: { id: true },
        })
      ).map((g) => g.id),
    );

    const results: ImportResultRow[] = [];
    const toCreate: StoredRow[] = [];
    chunk.forEach((r, i) => {
      const prior = doneByKey.get(keyOf(r));
      if (prior) results.push({ row: r.row, status: 'CREATED', code: prior });
      else if (probe[i].status === 'DUPLICATE')
        results.push({ row: r.row, status: 'SKIPPED', reason: 'ALREADY_REGISTERED' });
      else toCreate.push(r);
    });
    if (!toCreate.length) return results;

    const codes = await this.freshCodes(tx, academyId, toCreate.length);
    const made = toCreate.map((r, i) => ({
      r,
      userId: newId(),
      studentId: newId(),
      code: codes[i],
    }));
    await tx.user.createMany({
      data: made.map((m) => ({ id: m.userId, role: Role.STUDENT, fullName: m.r.fullName })),
    });
    await tx.studentProfile.createMany({
      data: made.map((m) => ({
        id: m.studentId,
        userId: m.userId,
        gradeId: m.r.gradeId,
        provisionedByAcademyId: academyId,
      })),
    });
    await tx.academyStudent.createMany({
      data: made.map((m) => ({
        academyId,
        studentId: m.studentId,
        code: m.code,
        fullName: m.r.fullName,
        studentPhone: m.r.studentPhone,
        guardianName: m.r.guardianName,
        guardianPhone: m.r.guardianPhone,
        school: m.r.school,
        gradeId: m.r.gradeId,
        source: 'IMPORT' as const,
        createdByUserId: ctx.userId,
        requestKey: keyOf(m.r),
      })),
    });
    // Seats (C2). Under the groups' own locks — the ones a desk add takes — a
    // row whose group has no seat left still becomes a student, just not a
    // member: the rest of the sheet is not refused for one full group.
    const wanted = [...new Set(made.map((m) => m.r.groupId).filter((g) => g && liveGroups.has(g)))]
      .map((g) => g!)
      .sort();
    const seatsLeft = new Map<string, number>();
    if (wanted.length) {
      const locked = await tx.$queryRaw<{ id: string; capacity: number | null }[]>`
        SELECT id, capacity FROM "Group" WHERE id IN (${Prisma.join(wanted)}) ORDER BY id FOR UPDATE`;
      for (const g of locked) {
        if (g.capacity == null) continue;
        const seated = await tx.groupMembership.count({
          where: { groupId: g.id, deletedAt: null },
        });
        seatsLeft.set(g.id, Math.max(0, g.capacity - seated));
      }
    }
    const full = new Set<number>();
    const memberships = made.filter((m) => {
      if (!m.r.groupId || !liveGroups.has(m.r.groupId)) return false;
      const left = seatsLeft.get(m.r.groupId);
      if (left === undefined) return true;
      if (left <= 0) {
        full.add(m.r.row);
        return false;
      }
      seatsLeft.set(m.r.groupId, left - 1);
      return true;
    });
    if (memberships.length) {
      await tx.groupMembership.createMany({
        data: memberships.map((m) => ({
          groupId: m.r.groupId!,
          studentId: m.studentId,
          academyId,
        })),
        skipDuplicates: true,
      });
    }
    for (const m of made) {
      results.push({
        row: m.r.row,
        status: 'CREATED',
        code: m.code,
        ...(m.r.groupId && !liveGroups.has(m.r.groupId)
          ? { reason: 'GROUP_GONE' }
          : full.has(m.r.row)
            ? { reason: 'GROUP_FULL' }
            : {}),
      });
    }
    return results.sort((a, b) => a.row - b.row);
  }

  /** n codes that are unused in this academy right now (the unique index settles any race). */
  private async freshCodes(tx: Prisma.TransactionClient, academyId: string, n: number) {
    const picked = new Set<string>();
    for (let round = 0; picked.size < n && round < 20; round++) {
      const candidates = new Set<string>();
      while (candidates.size < (n - picked.size) * 2) {
        const c = generateStudentCode();
        if (!picked.has(c)) candidates.add(c);
      }
      const taken = await tx.academyStudent.findMany({
        where: { academyId, code: { in: [...candidates] } },
        select: { code: true },
      });
      const takenSet = new Set(taken.map((t) => t.code));
      for (const c of candidates) {
        if (picked.size >= n) break;
        if (!takenSet.has(c)) picked.add(c);
      }
    }
    if (picked.size < n) throw new Error('could not allocate student codes');
    return [...picked];
  }
}

/** A cuid-shaped id for rows written with createMany (see chat-thread.identity newThreadId). */
function newId(): string {
  return `c${Date.now().toString(36)}${randomBytes(8).toString('hex')}`;
}

function importNotFound() {
  return new NotFoundException({ message: 'Import not found', code: 'IMPORT_NOT_FOUND' });
}
