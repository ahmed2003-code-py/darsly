import { ForbiddenException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'crypto';
import { JwtPayload, Role } from '@darsly/shared-types';
import { AcademyContext } from '../academy/academy-context';
import { AcademyService } from '../academy/academy.service';
import { AcademyMembershipGuard } from '../academy/guards/academy-membership.guard';
import { PermissionGuard } from '../academy/guards/permission.guard';
import { AcademyOpsAccessService } from '../academy-ops/academy-ops-access.service';
import { AuditService } from '../audit/audit.service';
import { CenterFeesService } from '../center-fees/center-fees.service';
import { generateStudentCode } from '../center-students/student-code';
import { ClassAttendanceService } from '../class-ops/class-attendance.service';
import { ClassScheduleService } from '../class-ops/class-schedule.service';
import { addDays } from '../class-ops/zoned-time';
import { VALIDATION_PIPE_OPTIONS } from '../common/errors/validation-exception.factory';
import { databaseReady } from '../common/testing/db-available';
import { FeatureFlagGuard } from '../feature-flags/guards/feature-flag.guard';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { FollowUpService } from '../follow-up/follow-up.service';
import { FollowUpSettingsService } from '../follow-up/settings.service';
import { FollowUpSignalsService } from '../follow-up/signals.service';
import { TimelineService } from '../follow-up/timeline.service';
import { PrismaService } from '../prisma/prisma.service';
import { CorrectDto, CreateExamDto, SaveResultsDto } from './dto';
import { GradesReadService } from './grades-read.service';
import { PaperExamsController } from './paper-exams.controller';
import { PaperExamsService } from './paper-exams.service';

/**
 * Center Operations C6 against a real PostgreSQL: the historical roster, the
 * difference between 0 / absent / excused / ungraded, fixed-point marks,
 * drafts, atomic publication, corrections and their history, makeups and the
 * effective result, the one statistics implementation, the LOW_GRADE signal
 * C5 derives from it, guardians, teacher reach, tenancy, and the database
 * rules behind them. Exams sit on fixed past dates so nothing depends on the
 * hour the suite runs.
 */
process.env.JWT_ACCESS_SECRET ??= 'test-secret-for-signed-links-0123456789';
const prisma = new PrismaService();
let ready = false;
const academy = new AcademyService(prisma);
const audit = new AuditService(prisma);
const flags = new FeatureFlagsService(prisma);
const access = new AcademyOpsAccessService(prisma);
const schedule = new ClassScheduleService(prisma, access, audit, academy);
const classes = new ClassAttendanceService(prisma, access, audit, schedule);
const fees = new CenterFeesService(prisma, schedule, audit);
const read = new GradesReadService(prisma, schedule, flags);
const exams = new PaperExamsService(prisma, read, access, audit);
const fuSettings = new FollowUpSettingsService(prisma, audit);
const signals = new FollowUpSignalsService(prisma, schedule, fees, flags, fuSettings, read);
const followUp = new FollowUpService(prisma, signals, schedule, audit);
const timeline = new TimelineService(prisma, fees, flags, schedule, read);

const PLATFORM = [
  'Payment',
  'PaymentEvent',
  'LedgerTransaction',
  'LedgerEntry',
  'WalletTransaction',
  'PayoutRequest',
  'LivePurchase',
  'CommercialTerms',
];
const ONLINE = [
  'Quiz',
  'QuizQuestion',
  'QuizAttempt',
  'Assignment',
  'AssignmentSubmission',
  'Challenge',
  'ChallengeAttempt',
  'PaperImport',
];
const hashOf = async (tables: string[]) => {
  const out: Record<string, unknown> = {};
  for (const t of tables)
    out[t] = (
      await prisma.$queryRawUnsafe<{ n: number; h: string }[]>(
        `SELECT count(*)::int n, md5(coalesce(string_agg(t::text,'|' ORDER BY id),'')) h FROM "${t}" t`,
      )
    )[0];
  return out;
};
let before: Record<string, unknown>;

beforeAll(async () => {
  await prisma.onModuleInit().catch(() => undefined);
  ready = await databaseReady(prisma, ['paperExam', 'paperExamResult', 'academyStudent']);
  if (ready) before = await hashOf([...PLATFORM, ...ONLINE]);
});
afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
});
const guard = () => ready;
const jwt = (sub: string, role: Role) => ({ sub, role, sessionId: 's' }) as JwtPayload;
const ctxOf = async (userId: string, role: Role, academyId: string): Promise<AcademyContext> =>
  (await academy.buildContext(userId, academyId, role))!;
const key = () => randomUUID().replace(/-/g, '');
const M = (marks: number) => Math.round(marks * 100);
const DAY = '2026-03-10';

function middayZone() {
  const off = ((12 - new Date().getUTCHours() + 36) % 24) - 12;
  return off === 0 ? 'Etc/UTC' : `Etc/GMT${off > 0 ? '-' : '+'}${Math.abs(off)}`;
}
async function refusal(p: Promise<unknown>) {
  try {
    await p;
    return 'NO REFUSAL';
  } catch (e: any) {
    return e?.response?.code ?? e?.code ?? e?.message;
  }
}

async function makeCenter(k: string, tag: string) {
  const owner = await prisma.user.create({
    data: { role: 'STAFF', fullName: `Owner ${tag} ${k}`, email: `c6-${tag}-o-${k}@it.test` },
  });
  const acad = await prisma.academy.create({
    data: {
      slug: `c6-${tag}-${k}`,
      name: `C6 ${tag} ${k}`,
      ownerUserId: owner.id,
      kind: 'CENTER',
      timezone: middayZone(),
    },
  });
  await prisma.academyMembership.create({
    data: { userId: owner.id, academyId: acad.id, role: 'OWNER', status: 'ACTIVE' },
  });
  for (const f of [
    'studentRegistry',
    'classOperations',
    'receptionDesk',
    'centerFees',
    'studentFollowUp',
    'paperExams',
  ] as const)
    await flags.setFlag(acad.id, f, true, owner.id);
  const gA = await prisma.group.create({ data: { academyId: acad.id, name: `A ${tag}` } });
  const gB = await prisma.group.create({ data: { academyId: acad.id, name: `B ${tag}` } });
  return { acad, ownerId: owner.id, gA, gB };
}

async function world() {
  const k = randomUUID().slice(0, 8);
  const A = await makeCenter(k, 'a');
  const B = await makeCenter(k, 'b');
  const member = async (
    tag: string,
    role: 'TEACHER' | 'ASSISTANT',
    permissions: string[],
    groupId?: string,
  ) => {
    const u = await prisma.user.create({
      data: {
        role: role === 'TEACHER' ? 'TEACHER' : 'STAFF',
        fullName: `${tag} ${k}`,
        email: `c6-${tag}-${k}@it.test`,
      },
    });
    if (role === 'TEACHER')
      await prisma.teacherProfile.create({
        data: { userId: u.id, slug: `c6-${tag}-${k}`, status: 'APPROVED' },
      });
    await prisma.academyMembership.create({
      data: {
        userId: u.id,
        academyId: A.acad.id,
        role,
        status: 'ACTIVE',
        courseScope: 'ALL',
        permissions,
      },
    });
    if (groupId)
      await prisma.groupAssignment.create({
        data: { groupId, userId: u.id, role, academyId: A.acad.id },
      });
    return u.id;
  };
  const teacherId = await member('t', 'TEACHER', [], A.gA.id);
  const teacher2Id = await member('t2', 'TEACHER', [], A.gB.id);
  const assistantId = await member('as', 'ASSISTANT', ['grades.view', 'grades.manage'], A.gA.id);
  const receptionId = await member('r', 'ASSISTANT', [
    'student.view',
    'student.directory',
    'student.register',
    'desk.checkin',
    'card.manage',
    'fees.view',
    'fees.collect',
    'guardian.manage',
    'followup.view',
    'followup.manage',
  ]);
  return {
    k,
    A,
    B,
    teacherId,
    teacher2Id,
    assistantId,
    receptionId,
    owner: await ctxOf(A.ownerId, Role.STAFF, A.acad.id),
    ownerB: await ctxOf(B.ownerId, Role.STAFF, B.acad.id),
    teacher: await ctxOf(teacherId, Role.TEACHER, A.acad.id),
    teacher2: await ctxOf(teacher2Id, Role.TEACHER, A.acad.id),
    assistant: await ctxOf(assistantId, Role.STAFF, A.acad.id),
    reception: await ctxOf(receptionId, Role.STAFF, A.acad.id),
  };
}
type World = Awaited<ReturnType<typeof world>>;

async function student(
  academyId: string,
  name: string,
  opts: { status?: 'ACTIVE' | 'WITHDRAWN'; leftAt?: Date } = {},
) {
  const u = await prisma.user.create({ data: { role: 'STUDENT', fullName: name } });
  const sp = await prisma.studentProfile.create({ data: { userId: u.id } });
  const rec = await prisma.academyStudent.create({
    data: {
      academyId,
      studentId: sp.id,
      code: generateStudentCode(),
      fullName: name,
      source: 'DESK',
      status: opts.status ?? 'ACTIVE',
      leftAt: opts.leftAt ?? null,
    },
  });
  return { id: rec.id, studentId: sp.id, name };
}
type L = Awaited<ReturnType<typeof student>>;
const stint = (w: World, groupId: string, s: L, addedAt: string, deletedAt?: string) =>
  prisma.groupMembership.create({
    data: {
      academyId: w.A.acad.id,
      groupId,
      studentId: s.studentId,
      addedAt: new Date(addedAt),
      deletedAt: deletedAt ? new Date(deletedAt) : null,
    },
  });
/** A learner in group A since January (before every exam here). */
async function member(w: World, name: string, groupId = w.A.gA.id) {
  const s = await student(w.A.acad.id, name);
  await stint(w, groupId, s, '2026-01-05T09:00:00Z');
  return s;
}
const exam = async (w: World, over: Partial<CreateExamDto> = {}, ctx = w.owner) =>
  (
    await exams.create(ctx, {
      requestKey: key(),
      groupId: w.A.gA.id,
      title: 'فيزياء الفصل التالت',
      examDate: DAY,
      maxScore: M(30),
      ...over,
    })
  ).exam;
const save = (
  w: World,
  id: string,
  rows: SaveResultsDto['rows'],
  ctx = w.owner,
  requestKey = key(),
) => exams.saveResults(ctx, id, { requestKey, rows });
const versionOf = async (examId: string, s: L) =>
  (
    await prisma.paperExamResult.findUniqueOrThrow({
      where: { examId_academyStudentId: { examId, academyStudentId: s.id } },
    })
  ).version;

// ───────────────────────────────────────────────────────────────────────────
describe('C6 — the database keeps the rules', () => {
  it('revisions append-only; published history never deleted or re-dated; score within the maximum; one academy', async () => {
    if (!guard()) return;
    const w = await world();
    const a = await member(w, 'قواعد');
    const e = await exam(w);
    await save(w, e.id, [{ academyStudentId: a.id, status: 'SCORED', score: M(26) }]);
    const rev = await prisma.paperExamRevision.findFirstOrThrow({ where: { examId: e.id } });
    await expect(
      prisma.paperExamRevision.update({ where: { id: rev.id }, data: { toScore: 1 } }),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.paperExamRevision.delete({ where: { id: rev.id } })).rejects.toThrow(
      /append-only/,
    );
    await expect(
      prisma.paperExamResult.updateMany({ where: { examId: e.id }, data: { score: M(31) } }),
    ).rejects.toThrow(/above the maximum/);
    await expect(
      prisma.paperExamResult.updateMany({ where: { examId: e.id }, data: { status: 'ABSENT' } }),
    ).rejects.toThrow(/shape/);
    await exams.publish(w.owner, e.id);
    await expect(prisma.paperExamResult.deleteMany({ where: { examId: e.id } })).rejects.toThrow(
      /never deleted/,
    );
    await expect(prisma.paperExam.delete({ where: { id: e.id } })).rejects.toThrow(/empty draft/);
    await expect(
      prisma.paperExam.update({ where: { id: e.id }, data: { examDate: new Date('2026-03-11') } }),
    ).rejects.toThrow(/keeps its group, date and marks/);
    await expect(
      prisma.paperExam.update({
        where: { id: e.id },
        data: { status: 'DRAFT', publishedAt: null, publishedBy: null },
      }),
    ).rejects.toThrow(/illegal|published_whole/);
    const other = await student(w.B.acad.id, 'غريب');
    await expect(
      prisma.paperExamResult.create({
        data: {
          academyId: w.A.acad.id,
          examId: e.id,
          academyStudentId: other.id,
          status: 'ABSENT',
          enteredBy: w.A.ownerId,
        },
      }),
    ).rejects.toThrow(/crosses academies/);
    await exams.voidExam(w.owner, e.id, 'اتعمل بالغلط');
    await expect(
      prisma.paperExam.update({ where: { id: e.id }, data: { title: 'x' } }),
    ).rejects.toThrow(/void exam is history/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C6 — roster and results', () => {
  it("historical roster: members on the exam date — not today's group; transfer, withdrawal and late joiners", async () => {
    if (!guard()) return;
    const w = await world();
    const stays = await member(w, 'موجود');
    const movedAfter = await student(w.A.acad.id, 'اتنقل بعدين');
    await stint(w, w.A.gA.id, movedAfter, '2026-01-05T09:00:00Z', '2026-04-01T09:00:00Z');
    await stint(w, w.A.gB.id, movedAfter, '2026-04-01T09:00:00Z');
    const leftAfter = await student(w.A.acad.id, 'انسحب بعدين', {
      status: 'WITHDRAWN',
      leftAt: new Date('2026-04-02T09:00:00Z'),
    });
    await stint(w, w.A.gA.id, leftAfter, '2026-01-05T09:00:00Z', '2026-04-02T09:00:00Z');
    const leftBefore = await student(w.A.acad.id, 'انسحب قبلها', {
      status: 'WITHDRAWN',
      leftAt: new Date('2026-02-01T09:00:00Z'),
    });
    await stint(w, w.A.gA.id, leftBefore, '2026-01-05T09:00:00Z', '2026-02-01T09:00:00Z');
    const joinedAfter = await student(w.A.acad.id, 'دخل بعدها');
    await stint(w, w.A.gA.id, joinedAfter, '2026-03-20T09:00:00Z');
    const shell = await member(w, 'طالب من غير حساب'); // a desk-registered learner with no account
    const e = await exam(w);
    const roster = new Set((await exams.sheet(w.owner, e.id)).rows.map((r) => r.academyStudentId));
    expect(roster).toEqual(new Set([stays.id, movedAfter.id, leftAfter.id, shell.id]));
    expect(
      await refusal(
        save(w, e.id, [{ academyStudentId: joinedAfter.id, status: 'SCORED', score: M(10) }]),
      ),
    ).toBe('ROWS_INVALID');
    // A late joiner can be added on purpose, as a guest.
    await save(w, e.id, [
      { academyStudentId: joinedAfter.id, status: 'SCORED', score: M(10), guest: true },
    ]);
    expect(
      (
        await prisma.paperExamResult.findFirstOrThrow({
          where: { examId: e.id, academyStudentId: joinedAfter.id },
        })
      ).guest,
    ).toBe(true);
    // A withdrawn learner cannot be added as a guest.
    expect(
      await refusal(
        save(w, e.id, [{ academyStudentId: leftBefore.id, status: 'ABSENT', guest: true }]),
      ),
    ).toBe('ROWS_INVALID');
  });

  it('0 is a score, ABSENT and EXCUSED are not, no row is ungraded; hundredths are exact; above the maximum is refused', async () => {
    if (!guard()) return;
    const w = await world();
    const [zero, absent, excused, half, quarter, ungraded] = await Promise.all(
      ['صفر', 'غايب', 'بعذر', 'نص', 'ربع', 'لسه'].map((n) => member(w, n)),
    );
    const e = await exam(w, { passScore: M(15) });
    await save(w, e.id, [
      { academyStudentId: zero.id, status: 'SCORED', score: 0 },
      { academyStudentId: absent.id, status: 'ABSENT' },
      { academyStudentId: excused.id, status: 'EXCUSED' },
      { academyStudentId: half.id, status: 'SCORED', score: 2650 },
      { academyStudentId: quarter.id, status: 'SCORED', score: 2625 },
    ]);
    const sheet = await exams.sheet(w.owner, e.id);
    const row = (s: L) => sheet.rows.find((r) => r.academyStudentId === s.id)!.result;
    expect(row(zero)).toMatchObject({ status: 'SCORED', score: 0, pctBps: 0, passed: false });
    expect(row(absent)).toMatchObject({ status: 'ABSENT', score: null, passed: null });
    expect(row(excused)).toMatchObject({ status: 'EXCUSED', score: null });
    expect(row(half)).toMatchObject({ score: 2650, pctBps: 8833, passed: true });
    expect(row(quarter)).toMatchObject({ score: 2625, pctBps: 8750 });
    expect(row(ungraded)).toBeNull();
    expect(sheet.stats).toMatchObject({
      entered: 5,
      scored: 3,
      absent: 1,
      excused: 1,
      highest: 2650,
      lowest: 0,
      passed: 2,
      passRateBps: 6667,
    });
    expect(sheet.stats!.average).toBe(Math.round((0 + 2650 + 2625) / 3));
    expect(sheet.stats!.median).toBe(2625);
    expect(
      await refusal(
        save(w, e.id, [{ academyStudentId: ungraded.id, status: 'SCORED', score: M(30) + 1 }]),
      ),
    ).toBe('ROWS_INVALID');
  });

  it('bulk save: a retry or double click is one save; a stale editor gets a conflict with the current value', async () => {
    if (!guard()) return;
    const w = await world();
    const a = await member(w, 'محمود');
    const b = await member(w, 'سارة');
    const e = await exam(w);
    const rk = key();
    const twice = await Promise.all([
      save(w, e.id, [{ academyStudentId: a.id, status: 'SCORED', score: M(20) }], w.owner, rk),
      save(w, e.id, [{ academyStudentId: a.id, status: 'SCORED', score: M(20) }], w.owner, rk),
    ]);
    expect(twice.map((t) => t.replayed).sort()).toEqual([false, true]);
    expect(await prisma.paperExamRevision.count({ where: { examId: e.id } })).toBe(1);
    // Two graders both think b has no grade yet: one wins, the other is told the truth.
    const race = await Promise.all([
      save(w, e.id, [{ academyStudentId: b.id, status: 'SCORED', score: M(18) }], w.owner),
      save(w, e.id, [{ academyStudentId: b.id, status: 'SCORED', score: M(19) }], w.teacher),
    ]);
    const conflicts = race.flatMap((r) => r.conflicts as any[]);
    expect(conflicts).toHaveLength(1);
    const stored = await prisma.paperExamResult.findUniqueOrThrow({
      where: { examId_academyStudentId: { examId: e.id, academyStudentId: b.id } },
    });
    expect(conflicts[0].current).toEqual({ status: 'SCORED', score: stored.score, version: 1 });
    // Editing with the version you saw works; with an old one it conflicts.
    await save(w, e.id, [{ academyStudentId: b.id, status: 'ABSENT', version: 1 }]);
    const stale = await save(w, e.id, [
      { academyStudentId: b.id, status: 'SCORED', score: M(5), version: 1 },
    ]);
    expect(stale.conflicts).toEqual([
      { academyStudentId: b.id, current: { status: 'ABSENT', score: null, version: 2 } },
    ]);
    // Clearing a draft grade is recorded too.
    await save(w, e.id, [{ academyStudentId: b.id, status: null, version: 2 }]);
    expect(
      (
        await prisma.paperExamRevision.findMany({
          where: { examId: e.id, academyStudentId: b.id },
          orderBy: { at: 'asc' },
        })
      ).map((r) => r.kind),
    ).toEqual(['ENTRY', 'ENTRY', 'CLEAR']);
  });

  it('publish refuses a result for someone who was not in the group that day (unless added as a guest)', async () => {
    if (!guard()) return;
    const w = await world();
    const a = await member(w, 'في المجموعة');
    const outsider = await student(w.A.acad.id, 'من بره');
    const e = await exam(w);
    await save(w, e.id, [{ academyStudentId: a.id, status: 'SCORED', score: M(20) }]);
    // Forced past the API (the API refuses it): the publication check still holds.
    const forced = await prisma.paperExamResult.create({
      data: {
        academyId: w.A.acad.id,
        examId: e.id,
        academyStudentId: outsider.id,
        status: 'ABSENT',
        guest: false,
        enteredBy: w.A.ownerId,
      },
    });
    expect(await refusal(exams.publish(w.owner, e.id))).toBe('ROSTER_MISMATCH');
    await prisma.paperExamResult.update({ where: { id: forced.id }, data: { guest: true } });
    expect((await exams.publish(w.owner, e.id)).status).toBe('PUBLISHED');
  });

  it('publish is atomic: refused while anyone is ungraded; races with a save; then frozen', async () => {
    if (!guard()) return;
    const w = await world();
    const a = await member(w, 'أ');
    const b = await member(w, 'ب');
    const e = await exam(w);
    await save(w, e.id, [{ academyStudentId: a.id, status: 'SCORED', score: M(12) }]);
    expect(await refusal(exams.publish(w.owner, e.id))).toBe('ROSTER_INCOMPLETE');
    const outcome = await Promise.allSettled([
      save(w, e.id, [{ academyStudentId: b.id, status: 'ABSENT' }]),
      exams.publish(w.owner, e.id),
    ]);
    const after = await prisma.paperExam.findUniqueOrThrow({ where: { id: e.id } });
    const rows = await prisma.paperExamResult.count({ where: { examId: e.id } });
    // Either the save landed first (and publication then succeeded), or publication
    // was refused for the missing learner — never published with a hole.
    if (after.status === 'PUBLISHED') expect(rows).toBe(2);
    else {
      expect(outcome[1].status).toBe('rejected');
      await exams.publish(w.owner, e.id);
    }
    expect(
      await refusal(
        save(w, e.id, [{ academyStudentId: a.id, status: 'SCORED', score: M(13), version: 1 }]),
      ),
    ).toBe('EXAM_PUBLISHED');
    expect(await refusal(exams.update(w.owner, e.id, { maxScore: M(40) }))).toBe('EXAM_PUBLISHED');
    expect((await exams.update(w.owner, e.id, { title: 'فيزياء — الفصل التالت' })).title).toBe(
      'فيزياء — الفصل التالت',
    );
    expect((await exams.publish(w.owner, e.id)).status).toBe('PUBLISHED'); // twice: unchanged
    expect(await refusal(exams.remove(w.owner, e.id))).toBe('EXAM_NOT_DRAFT');
  });

  it('corrections: reason, old value kept, version-checked, one of two racing corrections wins; void is final', async () => {
    if (!guard()) return;
    const w = await world();
    const mona = await member(w, 'منى');
    const e = await exam(w);
    await save(w, e.id, [{ academyStudentId: mona.id, status: 'SCORED', score: M(9) }]);
    await exams.publish(w.owner, e.id);
    const v = await versionOf(e.id, mona);
    const race = await Promise.allSettled([
      exams.correct(w.owner, e.id, mona.id, {
        version: v,
        status: 'SCORED',
        score: M(19),
        reason: 'اتكتبت غلط',
      }),
      exams.correct(w.owner, e.id, mona.id, {
        version: v,
        status: 'SCORED',
        score: M(20),
        reason: 'تصحيح تاني',
      }),
    ]);
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (race.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.response.code,
    ).toBe('VERSION_CONFLICT');
    const rev = await prisma.paperExamRevision.findFirstOrThrow({
      where: { examId: e.id, kind: 'CORRECTION' },
    });
    expect(rev).toMatchObject({
      fromStatus: 'SCORED',
      fromScore: M(9),
      toStatus: 'SCORED',
      actorUserId: w.A.ownerId,
    });
    expect(rev.reason).toMatch(/غلط|تاني/);
    const log = await prisma.auditLog.findMany({
      where: { academyId: w.A.acad.id, action: 'paper.result.correct' },
    });
    expect(JSON.stringify(log.map((l) => l.meta))).not.toMatch(/غلط|تاني/);
    expect(
      await refusal(
        exams.correct(w.owner, e.id, mona.id, {
          version: v + 1,
          status: 'SCORED',
          score: M(31),
          reason: 'كتير',
        }),
      ),
    ).toBe('MARKS_ABOVE_MAX');
    const vv = await versionOf(e.id, mona);
    const vr = await Promise.allSettled([
      exams.voidExam(w.owner, e.id, 'امتحان اتلغى'),
      exams.correct(w.owner, e.id, mona.id, { version: vv, status: 'ABSENT', reason: 'غاب فعلاً' }),
    ]);
    const final = await prisma.paperExam.findUniqueOrThrow({ where: { id: e.id } });
    expect(final.status).toBe('VOID');
    if (vr[1].status === 'rejected')
      expect((vr[1] as PromiseRejectedResult).reason.response.code).toBe('EXAM_VOID');
    expect(
      await refusal(
        exams.correct(w.owner, e.id, mona.id, {
          version: await versionOf(e.id, mona),
          status: 'EXCUSED',
          reason: 'بعد الإلغاء',
        }),
      ),
    ).toBe('EXAM_VOID');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C6 — makeups', () => {
  it('several learners share one sitting; one effective makeup per learner; the original absence stays', async () => {
    if (!guard()) return;
    const w = await world();
    const [omar, nour, here, other] = await Promise.all(
      ['عمر', 'نور', 'حضر', 'من امتحان تاني'].map((n) => member(w, n)),
    );
    const e = await exam(w, { passScore: M(15) });
    await save(w, e.id, [
      { academyStudentId: omar.id, status: 'ABSENT' },
      { academyStudentId: nour.id, status: 'EXCUSED' },
      { academyStudentId: here.id, status: 'SCORED', score: M(22) },
      { academyStudentId: other.id, status: 'SCORED', score: M(20) },
    ]);
    expect(
      await refusal(
        exams.createMakeup(w.owner, e.id, { requestKey: key(), examDate: '2026-03-17' }),
      ),
    ).toBe('MAKEUP_NOT_POSSIBLE'); // still a draft
    await exams.publish(w.owner, e.id);
    const m1 = (
      await exams.createMakeup(w.owner, e.id, { requestKey: key(), examDate: '2026-03-17' })
    ).exam;
    expect(m1).toMatchObject({
      kind: 'MAKEUP',
      makeupOfExamId: e.id,
      maxScore: M(30),
      passScore: M(15),
    });
    expect(
      new Set((await exams.sheet(w.owner, m1.id)).rows.map((r) => r.academyStudentId)),
    ).toEqual(new Set([omar.id, nour.id]));
    await save(w, m1.id, [
      { academyStudentId: omar.id, status: 'SCORED', score: M(24) },
      { academyStudentId: nour.id, status: 'SCORED', score: M(10) },
    ]);
    expect(
      await refusal(save(w, m1.id, [{ academyStudentId: here.id, status: 'SCORED', score: M(5) }])),
    ).toBe('ROWS_INVALID');
    expect(
      await refusal(
        exams.createMakeup(w.owner, m1.id, { requestKey: key(), examDate: '2026-03-20' }),
      ),
    ).toBe('MAKEUP_NOT_POSSIBLE'); // makeup of a makeup
    const m2 = (
      await exams.createMakeup(w.owner, e.id, { requestKey: key(), examDate: '2026-03-18' })
    ).exam;
    expect((await exams.sheet(w.owner, m2.id)).rows).toEqual([]); // both already hold a makeup in m1
    // Even forced at the database, a second effective makeup for Omar is impossible.
    await expect(
      prisma.paperExamResult.create({
        data: {
          academyId: w.A.acad.id,
          examId: m2.id,
          academyStudentId: omar.id,
          status: 'SCORED',
          score: M(5),
          enteredBy: w.A.ownerId,
        },
      }),
    ).rejects.toThrow(/one_effective_makeup|Unique/);
    await exams.publish(w.owner, m1.id);
    expect(
      (
        await prisma.paperExamResult.findFirstOrThrow({
          where: { examId: e.id, academyStudentId: omar.id },
        })
      ).status,
    ).toBe('ABSENT');
    expect((await exams.sheet(w.owner, e.id)).stats).toMatchObject({
      scored: 2,
      absent: 1,
      excused: 1,
    }); // original never counts the makeup
    const hist = await read.history(w.A.acad.id, omar.id, null);
    expect(hist.map((h) => [h.kind, h.status, h.score])).toEqual([
      ['REGULAR', 'ABSENT', null],
      ['MAKEUP', 'SCORED', M(24)],
    ]);
    // Voiding the makeup frees the slot.
    await exams.voidExam(w.owner, m1.id, 'اتعمل بالغلط');
    expect(
      new Set((await exams.sheet(w.owner, m2.id)).rows.map((r) => r.academyStudentId)),
    ).toEqual(new Set([omar.id, nour.id]));
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C6 — statistics are one implementation', () => {
  it('property: average, median, extremes and pass rate equal a plain reference over SCORED only', async () => {
    if (!guard()) return;
    const w = await world();
    let seed = 99;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let t = 0; t < 8; t++) {
      const n = 3 + Math.floor(rnd() * 8);
      const people = await Promise.all(
        Array.from({ length: n }, (_, i) => member(w, `خاصية ${t}-${i}`)),
      );
      const max = M(20 + Math.floor(rnd() * 30));
      const pass = Math.floor(max / 2);
      const e = await exam(w, { maxScore: max, passScore: pass, examDate: addDays(DAY, t + 1) });
      const rows = people.map((p) => {
        const r = rnd();
        return r < 0.15
          ? { academyStudentId: p.id, status: 'ABSENT' as const }
          : r < 0.25
            ? { academyStudentId: p.id, status: 'EXCUSED' as const }
            : {
                academyStudentId: p.id,
                status: 'SCORED' as const,
                score: Math.floor(rnd() * (max + 1)),
              };
      });
      await save(w, e.id, rows);
      const scores = rows
        .filter((r) => r.status === 'SCORED')
        .map((r) => (r as { score: number }).score)
        .sort((a, b) => a - b);
      const got = (await read.stats([e.id])).get(e.id)!;
      const mid =
        scores.length % 2
          ? scores[(scores.length - 1) / 2]
          : (scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2;
      expect(got.scored).toBe(scores.length);
      expect(got.average).toBe(
        scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
      );
      expect(got.median).toBe(scores.length ? Math.round(mid) : null);
      expect(got.highest).toBe(scores.length ? scores.at(-1) : null);
      expect(got.passed).toBe(scores.filter((s) => s >= pass).length);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C6 — LOW_GRADE in C5', () => {
  it('only published effective results; pass mark or the academy threshold; corrections and makeups re-derive it; cases untouched', async () => {
    if (!guard()) return;
    const w = await world();
    const today = (await schedule.academyClock(w.A.acad.id)).today;
    const recent = addDays(today, -3);
    const [low, ok, absent, noPass] = await Promise.all(
      ['ضعيف', 'كويس', 'غايب', 'بدون نجاح'].map((n) => member(w, n)),
    );
    const e = await exam(w, { passScore: M(15), examDate: recent });
    await save(w, e.id, [
      { academyStudentId: low.id, status: 'SCORED', score: M(9) },
      { academyStudentId: ok.id, status: 'SCORED', score: M(15) },
      { academyStudentId: absent.id, status: 'ABSENT' },
      { academyStudentId: noPass.id, status: 'SCORED', score: M(14) },
    ]);
    const lows = async (ctx = w.owner) =>
      (
        await signals.compute(w.A.acad.id, { grades: await signals.gradeReach(ctx) })
      ).signals.filter((s) => s.reason === 'LOW_GRADE');
    expect(await lows()).toEqual([]); // a draft raises nothing
    await exams.publish(w.owner, e.id);
    expect((await lows()).map((s) => s.academyStudentId).sort()).toEqual(
      [low.id, noPass.id].sort(),
    );
    expect((await lows()).find((s) => s.academyStudentId === low.id)).toMatchObject({
      signalKey: e.id,
      count: 30,
      since: recent,
    });
    // Reception follows up but holds no grade capability: no grade signals at all.
    expect(await lows(w.reception)).toEqual([]);
    expect(await signals.gradeReach(w.reception)).toBeUndefined();
    // …nor can Reception open a case on a grade it may not see.
    expect(
      await refusal(
        followUp.open(w.reception, {
          requestKey: key(),
          academyStudentId: low.id,
          reason: 'LOW_GRADE',
          signalKey: e.id,
        }),
      ),
    ).toBe('SIGNAL_NOT_FOUND');
    // An exam with no pass mark uses the academy's threshold (50%).
    const e2 = await exam(w, { examDate: addDays(today, -2) });
    await save(
      w,
      e2.id,
      [low, ok, absent, noPass].map((s, i) => ({
        academyStudentId: s.id,
        status: 'SCORED' as const,
        score: [M(14.99), M(15), M(16), M(29)][i],
      })),
    );
    await exams.publish(w.owner, e2.id);
    expect(
      (await lows()).filter((s) => s.signalKey === e2.id).map((s) => s.academyStudentId),
    ).toEqual([low.id]);
    // A case opened on it is not touched by a correction that clears the signal.
    const c = await followUp.open(w.owner, {
      requestKey: key(),
      academyStudentId: low.id,
      reason: 'LOW_GRADE',
      signalKey: e.id,
    });
    await exams.correct(w.owner, e.id, low.id, {
      version: await versionOf(e.id, low),
      status: 'SCORED',
      score: M(21),
      reason: 'جمع غلط',
    });
    expect((await lows()).some((s) => s.signalKey === e.id && s.academyStudentId === low.id)).toBe(
      false,
    );
    expect(
      (await prisma.studentFollowUp.findUniqueOrThrow({ where: { id: c.case.id } })).status,
    ).toBe('OPEN');
    // A makeup result is the effective one: a low makeup raises it, a good one clears it.
    const mk = (
      await exams.createMakeup(w.owner, e.id, { requestKey: key(), examDate: addDays(today, -1) })
    ).exam;
    await save(w, mk.id, [{ academyStudentId: absent.id, status: 'SCORED', score: M(8) }]);
    expect((await lows()).some((s) => s.academyStudentId === absent.id)).toBe(false); // the makeup is still a draft
    await exams.publish(w.owner, mk.id);
    expect(
      (await lows()).some((s) => s.academyStudentId === absent.id && s.signalKey === e.id),
    ).toBe(true);
    await exams.correct(w.owner, mk.id, absent.id, {
      version: await versionOf(mk.id, absent),
      status: 'SCORED',
      score: M(25),
      reason: 'تصحيح',
    });
    expect((await lows()).some((s) => s.academyStudentId === absent.id)).toBe(false);
    // A void exam raises nothing.
    await exams.voidExam(w.owner, e2.id, 'اتلغى');
    expect((await lows()).some((s) => s.signalKey === e2.id)).toBe(false);
    // An original with a live makeup cannot be voided out from under it.
    expect(await refusal(exams.voidExam(w.owner, e.id, 'محاولة'))).toBe('EXAM_HAS_MAKEUPS');
    // The flag switched off: no grade signal, no grade event in the timeline.
    expect((await lows()).length).toBeGreaterThan(0);
    await flags.setFlag(w.A.acad.id, 'paperExams', false, w.A.ownerId);
    expect(await lows()).toEqual([]);
    expect(JSON.stringify(await timeline.forStudent(w.owner, low.id))).not.toMatch(/GRADE_/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C6 — who may do what', () => {
  async function viaGuards(
    user: JwtPayload,
    academyId: string,
    method: keyof PaperExamsController,
  ) {
    const req: any = { user, headers: { 'x-academy-id': academyId }, params: {} };
    const exec: any = {
      getHandler: () => PaperExamsController.prototype[method],
      getClass: () => PaperExamsController,
      switchToHttp: () => ({ getRequest: () => req }),
    };
    await new AcademyMembershipGuard(academy).canActivate(exec);
    new PermissionGuard(new Reflector()).canActivate(exec);
    await new FeatureFlagGuard(new Reflector(), flags).canActivate(exec);
  }
  const outcome = (p: Promise<unknown>) =>
    p.then(
      () => 'ALLOWED',
      (e) =>
        e instanceof ForbiddenException
          ? 'FORBIDDEN'
          : e instanceof NotFoundException
            ? 'NOT_FOUND'
            : `OTHER:${e?.message}`,
    );
  const VIEW = ['list', 'groups', 'sheet', 'byStudent', 'export', 'settings'] as const;
  const MANAGE = ['create', 'update', 'remove', 'save', 'publish', 'makeup'] as const;
  const CORRECT = ['correct', 'voidExam'] as const;

  it('owner all; teacher view+manage (not correct); assistant only as granted; Reception, student, other academy nothing; flag off = nothing', async () => {
    if (!guard()) return;
    const w = await world();
    for (const m of [...VIEW, ...MANAGE, ...CORRECT, 'updateSettings' as const])
      expect(await outcome(viaGuards(jwt(w.A.ownerId, Role.STAFF), w.A.acad.id, m))).toBe(
        'ALLOWED',
      );
    for (const m of [...VIEW, ...MANAGE])
      expect(await outcome(viaGuards(jwt(w.teacherId, Role.TEACHER), w.A.acad.id, m))).toBe(
        'ALLOWED',
      );
    for (const m of [...CORRECT, 'updateSettings' as const])
      expect(await outcome(viaGuards(jwt(w.teacherId, Role.TEACHER), w.A.acad.id, m))).toBe(
        'FORBIDDEN',
      );
    for (const m of [...VIEW, ...MANAGE])
      expect(await outcome(viaGuards(jwt(w.assistantId, Role.STAFF), w.A.acad.id, m))).toBe(
        'ALLOWED',
      );
    for (const m of CORRECT)
      expect(await outcome(viaGuards(jwt(w.assistantId, Role.STAFF), w.A.acad.id, m))).toBe(
        'FORBIDDEN',
      );
    const stu = await prisma.user.create({ data: { role: 'STUDENT', fullName: 'x' } });
    for (const m of [...VIEW, ...MANAGE, ...CORRECT]) {
      expect(await outcome(viaGuards(jwt(w.receptionId, Role.STAFF), w.A.acad.id, m))).toBe(
        'FORBIDDEN',
      );
      expect(await outcome(viaGuards(jwt(stu.id, Role.STUDENT), w.A.acad.id, m))).not.toBe(
        'ALLOWED',
      );
      expect(await outcome(viaGuards(jwt(w.B.ownerId, Role.STAFF), w.A.acad.id, m))).not.toBe(
        'ALLOWED',
      );
    }
    await flags.setFlag(w.A.acad.id, 'paperExams', false, w.A.ownerId);
    for (const m of [...VIEW, ...MANAGE])
      expect(await outcome(viaGuards(jwt(w.A.ownerId, Role.STAFF), w.A.acad.id, m))).toBe(
        'FORBIDDEN',
      );
  });

  it('group reach: a teacher grades only their current groups; losing the assignment loses the exams; tenants never cross', async () => {
    if (!guard()) return;
    const w = await world();
    const a = await member(w, 'في أ');
    const inB = await member(w, 'في ب', w.A.gB.id);
    expect(
      await refusal(
        exams.create(w.teacher, {
          requestKey: key(),
          groupId: w.A.gB.id,
          title: 'x',
          examDate: DAY,
          maxScore: M(10),
        }),
      ),
    ).toBe('GROUP_NOT_ASSIGNED');
    const e = await exam(w, {}, w.teacher);
    await save(w, e.id, [{ academyStudentId: a.id, status: 'SCORED', score: M(10) }], w.teacher);
    await exams.publish(w.teacher, e.id);
    expect(await refusal(exams.sheet(w.teacher2, e.id))).toBe('GROUP_NOT_ASSIGNED');
    expect((await exams.list(w.teacher2, {})).items.map((x) => x.id)).not.toContain(e.id);
    expect(await refusal(exams.sheet(w.ownerB, e.id))).toBe('EXAM_NOT_FOUND');
    expect(
      await refusal(save(w, e.id, [{ academyStudentId: inB.id, status: 'ABSENT' }], w.teacher2)),
    ).toBe('GROUP_NOT_ASSIGNED');
    expect(await read.history(w.A.acad.id, a.id, await read.reach(w.teacher2))).toEqual([]);
    // Assignment ends → access ends.
    await prisma.groupAssignment.deleteMany({ where: { userId: w.teacherId, groupId: w.A.gA.id } });
    expect(await refusal(exams.sheet(w.teacher, e.id))).toBe('GROUP_NOT_ASSIGNED');
    // Foreign group / session / subject on create.
    expect(
      await refusal(
        exams.create(w.owner, {
          requestKey: key(),
          groupId: w.B.gA.id,
          title: 'x',
          examDate: DAY,
          maxScore: M(10),
        }),
      ),
    ).toBe('GROUP_NOT_FOUND');
    const foreignSession = await prisma.groupSession.create({
      data: {
        academyId: w.B.acad.id,
        groupId: w.B.gA.id,
        startAt: new Date('2026-03-10T10:00:00Z'),
        endAt: new Date('2026-03-10T11:00:00Z'),
        locationType: 'CENTER',
        createdBy: w.B.ownerId,
      },
    });
    expect(
      await refusal(
        exams.create(w.owner, {
          requestKey: key(),
          groupId: w.A.gA.id,
          title: 'x',
          examDate: DAY,
          maxScore: M(10),
          groupSessionId: foreignSession.id,
        }),
      ),
    ).toBe('SESSION_NOT_FOUND');
    const foreign = await student(w.B.acad.id, 'غريب');
    const e3 = await exam(w);
    expect(
      await refusal(
        save(w, e3.id, [{ academyStudentId: foreign.id, status: 'ABSENT', guest: true }]),
      ),
    ).toBe('ROWS_INVALID');
  });

  it('mass assignment and malformed scores are refused by the global pipe', async () => {
    if (!guard()) return;
    const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
    const bad = async (metatype: any, value: object) =>
      pipe.transform(value, { type: 'body', metatype }).then(
        () => 'ACCEPTED',
        () => 'REFUSED',
      );
    const base = {
      requestKey: key(),
      groupId: 'c'.repeat(25),
      title: 'x',
      examDate: DAY,
      maxScore: 3000,
    };
    for (const extra of [
      { academyId: 'x' },
      { createdBy: 'x' },
      { status: 'PUBLISHED' },
      { publishedAt: new Date().toISOString() },
      { publishedBy: 'x' },
      { version: 3 },
      { kind: 'MAKEUP' },
    ])
      expect(await bad(CreateExamDto, { ...base, ...extra })).toBe('REFUSED');
    for (const maxScore of [0, -5, 100_001, 26.5, 'NaN', 'Infinity', '1e3', null])
      expect(await bad(CreateExamDto, { ...base, maxScore })).toBe('REFUSED');
    const row = { academyStudentId: 'c'.repeat(25), status: 'SCORED' };
    for (const score of [
      -1,
      26.25,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '2650',
      '26abc',
      1e12,
      null,
    ])
      expect(await bad(SaveResultsDto, { requestKey: key(), rows: [{ ...row, score }] })).toBe(
        'REFUSED',
      );
    for (const extra of [{ enteredBy: 'x' }, { academyId: 'x' }, { makeupKey: 'x' }])
      expect(
        await bad(SaveResultsDto, { requestKey: key(), rows: [{ ...row, score: 100, ...extra }] }),
      ).toBe('REFUSED');
    expect(await bad(CorrectDto, { version: 1, status: 'SCORED', score: 100 })).toBe('REFUSED'); // no reason
    expect(
      await bad(CorrectDto, {
        version: 1,
        status: 'SCORED',
        score: 100,
        reason: 'سبب',
        correctedBy: 'x',
      }),
    ).toBe('REFUSED');
    expect(await bad(CreateExamDto, base)).toBe('ACCEPTED');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C6 — guardians, timeline, and nothing else touched', () => {
  it('guardians: nothing by default; when on, only published safe fields — never drafts', async () => {
    if (!guard()) return;
    const w = await world();
    const a = await member(w, 'ابن');
    const pub = await exam(w, { passScore: M(15), note: 'ملاحظة داخلية' });
    await save(w, pub.id, [{ academyStudentId: a.id, status: 'SCORED', score: M(9) }]);
    await exams.publish(w.owner, pub.id);
    await exams.correct(w.owner, pub.id, a.id, {
      version: await versionOf(pub.id, a),
      status: 'SCORED',
      score: M(12),
      reason: 'سبب سري',
    });
    const draft = await exam(w, { title: 'مسودة', examDate: '2026-03-12' });
    await save(w, draft.id, [{ academyStudentId: a.id, status: 'SCORED', score: M(1) }]);
    expect(await read.guardianView(w.A.acad.id, a.id)).toBeNull();
    await exams.updateSettings(w.owner, { guardianGradesVisible: true });
    const v = await read.guardianView(w.A.acad.id, a.id);
    expect(v).toEqual([
      expect.objectContaining({
        examId: pub.id,
        score: M(12),
        maxScore: M(30),
        passed: false,
        pctBps: 4000,
      }),
    ]);
    expect(JSON.stringify(v)).not.toMatch(/ملاحظة|سري|مسودة|actor|reason|revision|enteredBy/);
    // The flag switched off: guardians see nothing, even with the setting on.
    await flags.setFlag(w.A.acad.id, 'paperExams', false, w.A.ownerId);
    expect(await read.guardianView(w.A.acad.id, a.id)).toBeNull();
  });

  it('timeline: grade events only for grades.view; the correction reason never appears', async () => {
    if (!guard()) return;
    const w = await world();
    const a = await member(w, 'خط زمني');
    const e = await exam(w);
    await save(w, e.id, [{ academyStudentId: a.id, status: 'SCORED', score: M(20) }]);
    await exams.publish(w.owner, e.id);
    await exams.correct(w.owner, e.id, a.id, {
      version: await versionOf(e.id, a),
      status: 'SCORED',
      score: M(21),
      reason: 'سبب مش للعرض',
    });
    const owner = await timeline.forStudent(w.owner, a.id);
    expect(owner.items.map((i) => i.kind)).toEqual(
      expect.arrayContaining(['GRADE_PUBLISHED', 'GRADE_CORRECTED']),
    );
    expect(JSON.stringify(owner)).not.toMatch(/مش للعرض/);
    const rec = await timeline.forStudent(w.reception, a.id);
    expect(JSON.stringify(rec)).not.toMatch(/GRADE_/);
  });

  it('a low-graded, owing learner with an open case still checks in; C6 left online assessments, attendance, C4 and platform money alone', async () => {
    if (!guard()) return;
    const w = await world();
    const today = (await schedule.academyClock(w.A.acad.id)).today;
    const s = await member(w, 'ضعيف ومديون');
    const e = await exam(w, { passScore: M(15), examDate: addDays(today, -1) });
    await save(w, e.id, [{ academyStudentId: s.id, status: 'SCORED', score: M(3) }]);
    await exams.publish(w.owner, e.id);
    await fees.oneTime(w.owner, s.id, {
      requestKey: key(),
      description: 'ملزمة',
      amountCents: 20000,
      dueOn: addDays(today, -30),
    });
    await followUp.open(w.owner, {
      requestKey: key(),
      academyStudentId: s.id,
      reason: 'LOW_GRADE',
      signalKey: e.id,
    });
    const startAt = new Date(Date.now() - 2 * 60_000);
    const c = await prisma.groupSession.create({
      data: {
        academyId: w.A.acad.id,
        groupId: w.A.gA.id,
        startAt,
        endAt: new Date(startAt.getTime() + 3_600_000),
        locationType: 'CENTER',
        createdBy: w.A.ownerId,
      },
    });
    const r = await classes.deskCheckIn(w.owner, {
      sessionId: c.id,
      studentId: s.studentId,
      method: 'CODE',
    });
    expect(r.status).toBe('PRESENT');
    expect(await hashOf([...PLATFORM, ...ONLINE])).toEqual(before);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C6 — edges', () => {
  it('exactly the pass mark passes; a learner withdrawn before the exam is off the roster even with an open stint; a withdrawn learner raises no LOW_GRADE', async () => {
    if (!guard()) return;
    const w = await world();
    const today = (await schedule.academyClock(w.A.acad.id)).today;
    // Withdrawn before the exam, but their group stint was never closed (older data).
    const gone = await student(w.A.acad.id, 'منسحب وستنته مفتوحة', {
      status: 'WITHDRAWN',
      leftAt: new Date('2026-01-20T09:00:00Z'),
    });
    await stint(w, w.A.gA.id, gone, '2026-01-05T09:00:00Z');
    const onLine = await member(w, 'على الحد');
    const below = await member(w, 'تحت الحد بقرش');
    const leaves = await member(w, 'هينسحب بعدين');
    const e = await exam(w, { passScore: M(15), examDate: addDays(today, -2) });
    const ids = new Set((await exams.sheet(w.owner, e.id)).rows.map((r) => r.academyStudentId));
    expect(ids.has(gone.id)).toBe(false);
    await save(w, e.id, [
      { academyStudentId: onLine.id, status: 'SCORED', score: M(15) },
      { academyStudentId: below.id, status: 'SCORED', score: M(15) - 1 },
      { academyStudentId: leaves.id, status: 'SCORED', score: M(2) },
    ]);
    await exams.publish(w.owner, e.id);
    expect((await read.stats([e.id])).get(e.id)).toMatchObject({
      scored: 3,
      passed: 1,
      passRateBps: 3333,
    });
    expect((await read.history(w.A.acad.id, onLine.id, null))[0].passed).toBe(true);
    // The low learner withdraws after the exam: follow-up no longer raises them.
    const before = (await read.lowGrades(w.A.acad.id, addDays(today, -60), null)).map(
      (x) => x.academyStudentId,
    );
    expect(before).toEqual(expect.arrayContaining([below.id, leaves.id]));
    await prisma.academyStudent.update({
      where: { id: leaves.id },
      data: { status: 'WITHDRAWN', leftAt: new Date() },
    });
    const after = (await read.lowGrades(w.A.acad.id, addDays(today, -60), null)).map(
      (x) => x.academyStudentId,
    );
    expect(after).toContain(below.id);
    expect(after).not.toContain(leaves.id);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C6 — export', () => {
  it('CSV: exact hundredths, every learner, a formula-looking name is defused, commas and quotes kept', async () => {
    if (!guard()) return;
    const w = await world();
    const evil = await member(w, '=HYPERLINK("http://x","y")');
    const comma = await member(w, 'أحمد، "الصغير", محمد');
    const plus = await member(w, '+201001234567');
    const ungraded = await member(w, 'لسه');
    const e = await exam(w, { passScore: M(15) });
    await save(w, e.id, [
      { academyStudentId: evil.id, status: 'SCORED', score: 2650 },
      { academyStudentId: comma.id, status: 'ABSENT' },
      { academyStudentId: plus.id, status: 'SCORED', score: 5 },
    ]);
    const { csv, filename } = await exams.exportCsv(w.owner, e.id);
    expect(filename).toBe(`exam-${DAY}.csv`);
    expect(csv.startsWith('﻿code,name,status,score,max,percent,passed\r\n')).toBe(true);
    const lines = csv.split('\r\n');
    const line = (s: L) =>
      lines.find((l) => l.includes(s === evil ? 'HYPERLINK' : s.name.slice(0, 4)))!;
    expect(line(evil)).toContain(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(line(evil)).toContain(',SCORED,26.50,30.00,88.33,yes');
    expect(line(plus)).toContain(`,'+201001234567,SCORED,0.05,30.00,0.17,no`);
    expect(line(comma)).toContain('"أحمد، ""الصغير"", محمد",ABSENT,,30.00,,');
    expect(line(ungraded)).toContain(',UNGRADED,,30.00,,');
    expect(lines.filter((l) => l).length).toBe(5);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C6 — scale', () => {
  it('10,000 learners, a year of exams, stale statistics: sheet, history, stats and LOW_GRADE stay quick', async () => {
    if (!guard() || process.env.C6_SCALE === '0') return;
    const w = await world();
    const a = w.A.acad.id;
    await prisma.$executeRawUnsafe(
      'ANALYZE "PaperExam", "PaperExamResult", "PaperExamRevision", "GroupMembership", "AcademyStudent"',
    );
    const N = 10_000;
    const G = 100;
    const groups = await prisma.group.createManyAndReturn({
      data: Array.from({ length: G }, (_, i) => ({ academyId: a, name: `G${i}` })),
      select: { id: true },
    });
    const users = await prisma.user.createManyAndReturn({
      data: Array.from({ length: N }, (_, i) => ({
        role: 'STUDENT' as const,
        fullName: `متعلم ${i}`,
      })),
      select: { id: true },
    });
    const profiles = await prisma.studentProfile.createManyAndReturn({
      data: users.map((u) => ({ userId: u.id })),
      select: { id: true },
    });
    const codes = new Set<string>();
    while (codes.size < N) codes.add(generateStudentCode());
    const code = [...codes];
    const recs = await prisma.academyStudent.createManyAndReturn({
      data: profiles.map((p, i) => ({
        academyId: a,
        studentId: p.id,
        code: code[i],
        fullName: `متعلم ${i}`,
        source: 'DESK' as const,
      })),
      select: { id: true, studentId: true },
    });
    await prisma.groupMembership.createMany({
      data: recs.map((r, i) => ({
        academyId: a,
        groupId: groups[i % G].id,
        studentId: r.studentId,
        addedAt: new Date('2025-09-01T09:00:00Z'),
      })),
    });
    const today = (await schedule.academyClock(a)).today;
    // 100 groups × 12 published exams (monthly) = 1,200 exams, 120,000 results.
    for (let gi = 0; gi < G; gi++)
      for (let m = 0; m < 12; m++)
        await prisma.paperExam.create({
          data: {
            academyId: a,
            groupId: groups[gi].id,
            title: `E${gi}-${m}`,
            examDate: new Date(`${addDays(today, -m * 30)}T00:00:00Z`),
            maxScore: 3000,
            passScore: 1500,
            createdBy: w.A.ownerId,
            requestKey: key(),
          },
        });
    await prisma.$executeRawUnsafe(
      `
      INSERT INTO "PaperExamResult"(id, "academyId", "examId", "academyStudentId", status, score, "enteredBy")
      SELECT gen_random_uuid()::text, e."academyId", e.id, s.id, 'SCORED', ((hashtext(e.id || s.id) & 2147483647) % 3001), $2
      FROM "PaperExam" e
      JOIN "GroupMembership" m ON m."groupId" = e."groupId"
      JOIN "AcademyStudent" s ON s."studentId" = m."studentId" AND s."academyId" = e."academyId"
      WHERE e."academyId" = $1`,
      a,
      w.A.ownerId,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE "PaperExam" SET status='PUBLISHED', "publishedAt"=now(), "publishedBy"=$2 WHERE "academyId"=$1`,
      a,
      w.A.ownerId,
    );
    const one = await prisma.paperExam.findFirstOrThrow({ where: { academyId: a } });
    let t = Date.now();
    const sheet = await exams.sheet(w.owner, one.id);
    const sheetMs = Date.now() - t;
    t = Date.now();
    await read.history(a, recs[7].id, null);
    const histMs = Date.now() - t;
    t = Date.now();
    await exams.list(w.owner, {});
    const listMs = Date.now() - t;
    t = Date.now();
    const lows = await read.lowGrades(a, addDays(today, -60), null);
    const lowMs = Date.now() - t;
    console.log(
      `C6 scale: sheet ${sheet.rows.length} rows ${sheetMs} ms; history ${histMs} ms; list ${listMs} ms; LOW_GRADE ${lows.length} in ${lowMs} ms`,
    );
    expect(sheetMs).toBeLessThan(1500);
    expect(histMs).toBeLessThan(500);
    expect(listMs).toBeLessThan(1500);
    expect(lowMs).toBeLessThan(3000);
  }, 900_000);
});
