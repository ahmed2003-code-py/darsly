import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash, randomUUID } from 'crypto';
import { JwtPayload, Role } from '@darsly/shared-types';
import { AcademyContext } from '../academy/academy-context';
import { AcademyService } from '../academy/academy.service';
import { AcademyMembershipGuard } from '../academy/guards/academy-membership.guard';
import { PermissionGuard } from '../academy/guards/permission.guard';
import { StaffScopeService } from '../academy/staff-scope.service';
import { AcademyOpsAccessService } from '../academy-ops/academy-ops-access.service';
import { AuditService } from '../audit/audit.service';
import { CenterFeesService } from '../center-fees/center-fees.service';
import { generateStudentCode } from '../center-students/student-code';
import { ClassAttendanceService } from '../class-ops/class-attendance.service';
import { ClassScheduleService } from '../class-ops/class-schedule.service';
import { addDays, dateValue, zonedToInstant } from '../class-ops/zoned-time';
import { databaseReady } from '../common/testing/db-available';
import { FeatureFlagGuard } from '../feature-flags/guards/feature-flag.guard';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { GuardianService } from '../guardian/guardian.service';
import { GradesReadService } from '../paper-exams/grades-read.service';
import { PrismaService } from '../prisma/prisma.service';
import { FollowUpController } from './follow-up.controller';
import { FollowUpService } from './follow-up.service';
import { GuardianFeesView } from './guardian-fees.view';
import { FollowUpSettingsService } from './settings.service';
import { FollowUpSignalsService } from './signals.service';
import { TimelineService } from './timeline.service';

/**
 * Center Operations C5 against a real PostgreSQL: the derived signals (from
 * C2 attendance rows and C4 balances), cases and their races, the
 * append-only contact log and the database triggers behind it, the timeline
 * and who receives which events, guardians' state and fee visibility, and
 * every refusal. Attendance history is written at fixed past dates so no
 * test depends on the hour it runs; the centre sits in a zone where it is
 * about noon now.
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
const settings = new FollowUpSettingsService(prisma, audit);
const grades = new GradesReadService(prisma, schedule, flags);
const signals = new FollowUpSignalsService(prisma, schedule, fees, flags, settings, grades);
const followUp = new FollowUpService(prisma, signals, schedule, audit);
const timeline = new TimelineService(prisma, fees, flags, schedule, grades);
const guardianFees = new GuardianFeesView(prisma, flags, settings, fees);
const scopes = new StaffScopeService(prisma, academy);
const guardians = new GuardianService(prisma, scopes, null as never, null as never);

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
let platformBefore: Record<string, unknown>;

beforeAll(async () => {
  await prisma.onModuleInit().catch(() => undefined);
  ready = await databaseReady(prisma, ['studentFollowUp', 'studentContact', 'academyStudent']);
  if (ready) platformBefore = await hashOf(PLATFORM);
});
afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
});
const guard = () => ready;

const jwt = (sub: string, role: Role) => ({ sub, role, sessionId: 's' }) as JwtPayload;
const ctxOf = async (userId: string, role: Role, academyId: string): Promise<AcademyContext> =>
  (await academy.buildContext(userId, academyId, role))!;
const key = () => randomUUID().replace(/-/g, '');
/** Learner codes are random (90,000 of them); a fixture never reuses one in this run. */
const usedCodes = new Set<string>();
const freshCode = () => {
  let c = generateStudentCode();
  while (usedCodes.has(c)) c = generateStudentCode();
  usedCodes.add(c);
  return c;
};
const EGP = (n: number) => Math.round(n * 100);

function middayZone() {
  const off = ((12 - new Date().getUTCHours() + 36) % 24) - 12;
  return off === 0 ? 'Etc/UTC' : `Etc/GMT${off > 0 ? '-' : '+'}${Math.abs(off)}`;
}

const DESK = [
  'student.view',
  'student.directory',
  'student.register',
  'desk.checkin',
  'card.manage',
];
const FOLLOW = ['followup.view', 'followup.manage', 'guardian.manage'];

async function makeCenter(k: string, tag: string) {
  const owner = await prisma.user.create({
    data: { role: 'STAFF', fullName: `Owner ${tag} ${k}`, email: `c5-${tag}-o-${k}@it.test` },
  });
  const acad = await prisma.academy.create({
    data: {
      slug: `c5-${tag}-${k}`,
      name: `C5 ${tag} ${k}`,
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
  const staff = async (tag: string, permissions: string[]) => {
    const u = await prisma.user.create({
      data: { role: 'STAFF', fullName: `${tag} ${k}`, email: `c5-${tag}-${k}@it.test` },
    });
    await prisma.academyMembership.create({
      data: {
        userId: u.id,
        academyId: A.acad.id,
        role: 'ASSISTANT',
        status: 'ACTIVE',
        courseScope: 'ALL',
        permissions,
      },
    });
    return u.id;
  };
  const receptionId = await staff('r', [...DESK, 'fees.view', 'fees.collect', ...FOLLOW]);
  const reception2Id = await staff('r2', [...DESK, 'fees.view', 'fees.collect', ...FOLLOW]);
  const followNoFeesId = await staff('nf', [...DESK, ...FOLLOW]);
  const deskOnlyId = await staff('d', [...DESK, 'fees.view', 'fees.collect']);
  const t = await prisma.user.create({
    data: { role: 'TEACHER', fullName: `T ${k}`, email: `c5-t-${k}@it.test` },
  });
  await prisma.teacherProfile.create({
    data: { userId: t.id, slug: `c5-t-${k}`, status: 'APPROVED' },
  });
  await prisma.academyMembership.create({
    data: { userId: t.id, academyId: A.acad.id, role: 'TEACHER', status: 'ACTIVE' },
  });
  await prisma.groupAssignment.create({
    data: { groupId: A.gA.id, userId: t.id, role: 'TEACHER', academyId: A.acad.id },
  });
  const today = (await schedule.academyClock(A.acad.id)).today;
  return {
    k,
    A,
    B,
    today,
    tz: middayZone(),
    teacherId: t.id,
    receptionId,
    reception2Id,
    deskOnlyId,
    followNoFeesId,
    owner: await ctxOf(A.ownerId, Role.STAFF, A.acad.id),
    ownerB: await ctxOf(B.ownerId, Role.STAFF, B.acad.id),
    reception: await ctxOf(receptionId, Role.STAFF, A.acad.id),
    reception2: await ctxOf(reception2Id, Role.STAFF, A.acad.id),
    followNoFees: await ctxOf(followNoFeesId, Role.STAFF, A.acad.id),
  };
}
type World = Awaited<ReturnType<typeof world>>;

async function student(
  academyId: string,
  name: string,
  opts: { status?: 'ACTIVE' | 'WITHDRAWN'; guardianName?: string; guardianPhone?: string } = {},
) {
  const u = await prisma.user.create({ data: { role: 'STUDENT', fullName: name } });
  const sp = await prisma.studentProfile.create({ data: { userId: u.id } });
  const rec = await prisma.academyStudent.create({
    data: {
      academyId,
      studentId: sp.id,
      code: freshCode(),
      fullName: name,
      source: 'DESK',
      status: opts.status ?? 'ACTIVE',
      leftAt: opts.status === 'WITHDRAWN' ? new Date() : null,
      guardianName: opts.guardianName ?? null,
      guardianPhone: opts.guardianPhone ?? null,
    },
  });
  return { id: rec.id, studentId: sp.id, code: rec.code, name };
}
type Learner = Awaited<ReturnType<typeof student>>;

/** A C2 class on a local date (with its attendance sheet) — one per group, date and kind. */
const classCache = new Map<string, Promise<{ gsId: string; shId: string }>>();
function classOn(w: World, groupId: string, date: string, cancelled = false) {
  const k = `${groupId}|${date}|${cancelled}`;
  if (!classCache.has(k)) classCache.set(k, makeClass(w, groupId, date, cancelled));
  return classCache.get(k)!;
}
async function makeClass(w: World, groupId: string, date: string, cancelled: boolean) {
  // A cancelled class sits two hours later: the group's live class keeps its slot.
  const startAt = zonedToInstant(date, (cancelled ? 18 : 16) * 60, w.tz);
  const gs = await prisma.groupSession.create({
    data: {
      academyId: w.A.acad.id,
      groupId,
      startAt,
      endAt: new Date(startAt.getTime() + 3_600_000),
      status: cancelled ? 'CANCELLED' : 'COMPLETED',
      locationType: 'CENTER',
      createdBy: w.A.ownerId,
    },
  });
  const sh = await prisma.attendanceSession.create({
    data: {
      academyId: w.A.acad.id,
      groupId,
      date: dateValue(date),
      groupSessionId: gs.id,
      createdBy: w.A.ownerId,
    },
  });
  return { gsId: gs.id, shId: sh.id };
}
type Status = 'PRESENT' | 'LATE' | 'ABSENT' | 'EXCUSED';
const mark = (
  w: World,
  shId: string,
  s: Learner,
  status: Status,
  extra: { homeGroupId?: string; makeupForSessionId?: string } = {},
) =>
  prisma.attendanceRecord.create({
    data: {
      academyId: w.A.acad.id,
      sessionId: shId,
      studentId: s.studentId,
      status,
      markedBy: w.A.ownerId,
      ...extra,
    },
  });
/** A learner in group A with one record per status, oldest first, one class a day ending `endDaysAgo` days ago. */
async function history(
  w: World,
  s: Learner,
  statuses: Status[],
  endDaysAgo = 1,
  groupId = w.A.gA.id,
) {
  const out: { gsId: string; shId: string }[] = [];
  for (let i = 0; i < statuses.length; i++) {
    const c = await classOn(w, groupId, addDays(w.today, -(endDaysAgo + statuses.length - 1 - i)));
    await mark(w, c.shId, s, statuses[i]);
    out.push(c);
  }
  return out;
}
const signalsOf = async (w: World, s: Learner, withAmounts = false) =>
  (await signals.compute(w.A.acad.id, { academyStudentId: s.id, withAmounts })).signals;
async function refusal(p: Promise<unknown>) {
  try {
    await p;
    return 'NO REFUSAL';
  } catch (e: any) {
    return e?.response?.code ?? e?.code ?? e?.message;
  }
}
async function oneTime(w: World, s: Learner, amount: number, dueOn: string) {
  await fees.oneTime(w.owner, s.id, {
    requestKey: key(),
    description: 'كتاب',
    amountCents: amount,
    dueOn,
  });
}

// ───────────────────────────────────────────────────────────────────────────
describe('C5 — the database keeps the rules', () => {
  it('no delete, a contact is never edited, a closed case is history, one academy, bounded settings', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await student(w.A.acad.id, 'قواعد');
    const c = await followUp.open(w.reception, {
      requestKey: key(),
      academyStudentId: s.id,
      reason: 'MANUAL',
      note: 'متابعة يدوية',
    });
    const k = await followUp.logContact(w.reception, s.id, {
      requestKey: key(),
      channel: 'PHONE_CALL',
      outcome: 'NO_ANSWER',
      party: 'REGISTER_GUARDIAN',
    });
    await expect(prisma.studentFollowUp.delete({ where: { id: c.case.id } })).rejects.toThrow(
      /never deleted/,
    );
    await expect(prisma.studentContact.delete({ where: { id: k.contact.id } })).rejects.toThrow(
      /never deleted/,
    );
    await expect(
      prisma.studentContact.update({ where: { id: k.contact.id }, data: { note: 'x' } }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.studentFollowUp.update({
        where: { id: c.case.id },
        data: { reason: 'ABSENT_TODAY', signalKey: 'x' },
      }),
    ).rejects.toThrow(/keeps what it is about/);
    await expect(
      prisma.studentFollowUp.update({ where: { id: c.case.id }, data: { status: 'RESOLVED' } }),
    ).rejects.toThrow(/closed_whole/);
    await followUp.close(w.reception, c.case.id, 'RESOLVED', 'اتكلمنا مع الأب');
    await expect(
      prisma.studentFollowUp.update({
        where: { id: c.case.id },
        data: { assignedToUserId: w.receptionId },
      }),
    ).rejects.toThrow(/history/);
    // Another academy's learner in this academy's name never commits.
    const other = await student(w.B.acad.id, 'غريب');
    await expect(
      prisma.studentFollowUp.create({
        data: {
          academyId: w.A.acad.id,
          academyStudentId: other.id,
          reason: 'MANUAL',
          note: 'xxx',
          openedBy: w.A.ownerId,
          requestKey: key(),
        },
      }),
    ).rejects.toThrow(/crosses academies/);
    await expect(
      prisma.studentFollowUp.create({
        data: {
          academyId: w.A.acad.id,
          academyStudentId: s.id,
          reason: 'MANUAL',
          signalKey: 'x',
          openedBy: w.A.ownerId,
          requestKey: key(),
        },
      }),
    ).rejects.toThrow(/shape/);
    await expect(
      prisma.academyFollowUpSettings.create({ data: { academyId: w.A.acad.id, absenceStreak: 1 } }),
    ).rejects.toThrow(/bounds/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C5 — signals are derived from C2 and C4 truth', () => {
  it('consecutive absences: EXCUSED is skipped, PRESENT and a made-up absence break it, a guest visit is not counted', async () => {
    if (!guard()) return;
    const w = await world();
    const three = await student(w.A.acad.id, 'تلات غيابات');
    const cls = await history(w, three, ['PRESENT', 'ABSENT', 'ABSENT', 'ABSENT']);
    const sig = (await signalsOf(w, three)).find((x) => x.reason === 'ABSENT_STREAK');
    expect(sig).toMatchObject({
      count: 3,
      groupId: w.A.gA.id,
      signalKey: `${w.A.gA.id}:${cls[1].shId}`,
    });
    const two = await student(w.A.acad.id, 'غيابين');
    await history(w, two, ['ABSENT', 'PRESENT', 'ABSENT', 'ABSENT']);
    expect((await signalsOf(w, two)).some((x) => x.reason === 'ABSENT_STREAK')).toBe(false);
    const excused = await student(w.A.acad.id, 'بعذر في النص');
    await history(w, excused, ['ABSENT', 'EXCUSED', 'ABSENT', 'ABSENT']);
    expect((await signalsOf(w, excused)).find((x) => x.reason === 'ABSENT_STREAK')?.count).toBe(3);
    const allExcused = await student(w.A.acad.id, 'كله بعذر');
    await history(w, allExcused, ['EXCUSED', 'EXCUSED', 'EXCUSED', 'EXCUSED']);
    expect(await signalsOf(w, allExcused)).toEqual([]);
    // The middle absence was made up in group B: it is not an absence any more.
    const madeUp = await student(w.A.acad.id, 'عوّض');
    const m = await history(w, madeUp, ['ABSENT', 'ABSENT', 'ABSENT']);
    const visit = await classOn(w, w.A.gB.id, addDays(w.today, -1));
    await mark(w, visit.shId, madeUp, 'PRESENT', {
      homeGroupId: w.A.gA.id,
      makeupForSessionId: m[1].gsId,
    });
    expect((await signalsOf(w, madeUp)).some((x) => x.reason === 'ABSENT_STREAK')).toBe(false);
    // A guest's records in B never make a streak in B.
    const guest = await student(w.A.acad.id, 'ضيف');
    for (let i = 0; i < 3; i++) {
      const c = await classOn(w, w.A.gB.id, addDays(w.today, -(5 - i)));
      await mark(w, c.shId, guest, 'ABSENT', { homeGroupId: w.A.gA.id });
    }
    expect(await signalsOf(w, guest)).toEqual([]);
  });

  it('cancelled classes and withdrawn learners raise nothing; lateness streaks; absent today', async () => {
    if (!guard()) return;
    const w = await world();
    const cancelled = await student(w.A.acad.id, 'حصص اتلغت');
    for (let i = 0; i < 3; i++) {
      const c = await classOn(w, w.A.gA.id, addDays(w.today, -(4 - i)), true);
      await mark(w, c.shId, cancelled, 'ABSENT');
    }
    expect(await signalsOf(w, cancelled)).toEqual([]);
    const gone = await student(w.A.acad.id, 'انسحب', { status: 'WITHDRAWN' });
    await history(w, gone, ['ABSENT', 'ABSENT', 'ABSENT']);
    expect(await signalsOf(w, gone)).toEqual([]);
    const late = await student(w.A.acad.id, 'بيتأخر');
    await history(w, late, ['PRESENT', 'LATE', 'LATE', 'LATE']);
    expect((await signalsOf(w, late)).find((x) => x.reason === 'LATE_STREAK')?.count).toBe(3);
    const absentNow = await student(w.A.acad.id, 'غايب النهارده');
    const t = await classOn(w, w.A.gA.id, w.today);
    await mark(w, t.shId, absentNow, 'ABSENT');
    expect(await signalsOf(w, absentNow)).toEqual([
      expect.objectContaining({ reason: 'ABSENT_TODAY', signalKey: t.shId, since: w.today }),
    ]);
    const excusedNow = await student(w.A.acad.id, 'بعذر النهارده');
    await mark(w, t.shId, excusedNow, 'EXCUSED');
    expect(await signalsOf(w, excusedNow)).toEqual([]);
  });

  it('fees overdue: through C4 balances, only beyond the threshold, amounts only on request; C4 off → none', async () => {
    if (!guard()) return;
    const w = await world();
    const ten = await student(w.A.acad.id, 'متأخر عشر أيام');
    await oneTime(w, ten, EGP(300), addDays(w.today, -10));
    const five = await student(w.A.acad.id, 'متأخر خمس أيام');
    await oneTime(w, five, EGP(300), addDays(w.today, -5));
    const sTen = (await signalsOf(w, ten, true)).find((x) => x.reason === 'FEES_OVERDUE');
    expect(sTen).toMatchObject({ count: 10, since: addDays(w.today, -10), overdueCents: EGP(300) });
    expect((await signalsOf(w, ten, false))[0]).not.toHaveProperty('overdueCents');
    expect(await signalsOf(w, five)).toEqual([]);
    // The threshold is the academy's; it changes what is derived, nothing else.
    const before = await hashOf([
      'CenterCharge',
      'AttendanceRecord',
      'StudentContact',
      'StudentFollowUp',
    ]);
    await settings.update(w.owner, { overdueDays: 3 });
    expect((await signalsOf(w, five)).map((x) => x.reason)).toEqual(['FEES_OVERDUE']);
    expect(
      await hashOf(['CenterCharge', 'AttendanceRecord', 'StudentContact', 'StudentFollowUp']),
    ).toEqual(before);
    // Paid → gone.
    await fees.collect(w.owner, ten.id, {
      requestKey: key(),
      amountCents: EGP(300),
      method: 'CASH',
    });
    expect(await signalsOf(w, ten)).toEqual([]);
    await flags.setFlag(w.A.acad.id, 'centerFees', false, w.A.ownerId);
    expect(await signalsOf(w, five)).toEqual([]);
  });

  it('streak thresholds are the academy’s, and changing them rewrites nothing', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await student(w.A.acad.id, 'عتبة');
    await history(w, s, ['ABSENT', 'ABSENT', 'ABSENT']);
    await followUp.open(w.reception, {
      requestKey: key(),
      academyStudentId: s.id,
      reason: 'ABSENT_STREAK',
      signalKey: (await signalsOf(w, s))[0].signalKey,
    });
    const before = await hashOf(['AttendanceRecord', 'StudentFollowUp']);
    await settings.update(w.owner, { absenceStreak: 4 });
    expect(await signalsOf(w, s)).toEqual([]);
    expect(await hashOf(['AttendanceRecord', 'StudentFollowUp'])).toEqual(before); // the open case stays
    await settings.update(w.owner, { absenceStreak: 2 });
    expect((await signalsOf(w, s))[0].count).toBe(3);
  });

  it('property: the streak equals a plain reading of the record sequence', async () => {
    if (!guard()) return;
    const w = await world();
    const ref = (seq: Status[], want: Status) => {
      let n = 0;
      for (let i = seq.length - 1; i >= 0; i--) {
        if (seq[i] === 'EXCUSED' && want === 'ABSENT') continue;
        if (seq[i] === want) n++;
        else break;
      }
      return n;
    };
    const ALL: Status[] = ['PRESENT', 'LATE', 'ABSENT', 'EXCUSED'];
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    await settings.update(w.owner, { absenceStreak: 2, lateStreak: 2 });
    for (let trial = 0; trial < 25; trial++) {
      const s = await student(w.A.acad.id, `خاصية ${trial}`);
      const seq = Array.from(
        { length: 1 + Math.floor(rnd() * 7) },
        () => ALL[Math.floor(rnd() * 4)],
      );
      await history(w, s, seq);
      const got = await signalsOf(w, s);
      const absent = ref(seq, 'ABSENT');
      // LATE: EXCUSED is filtered out of the sequence before reading it.
      const late = ref(
        seq.filter((x) => x !== 'EXCUSED'),
        'LATE',
      );
      expect([seq.join(','), got.find((x) => x.reason === 'ABSENT_STREAK')?.count ?? 0]).toEqual([
        seq.join(','),
        absent >= 2 ? absent : 0,
      ]);
      expect([seq.join(','), got.find((x) => x.reason === 'LATE_STREAK')?.count ?? 0]).toEqual([
        seq.join(','),
        late >= 2 ? late : 0,
      ]);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C5 — cases', () => {
  async function streakLearner(w: World, name = 'غايب') {
    const s = await student(w.A.acad.id, name);
    await history(w, s, ['ABSENT', 'ABSENT', 'ABSENT']);
    return { s, signalKey: (await signalsOf(w, s))[0].signalKey };
  }

  it('opening is idempotent: a retry, a double click and five desks at once make one case', async () => {
    if (!guard()) return;
    const w = await world();
    const { s, signalKey } = await streakLearner(w);
    const dto = {
      requestKey: key(),
      academyStudentId: s.id,
      reason: 'ABSENT_STREAK' as const,
      signalKey,
    };
    const a = await followUp.open(w.reception, dto);
    const b = await followUp.open(w.reception, dto);
    expect(a.created).toBe(true);
    expect(b).toMatchObject({ created: false, case: { id: a.case.id } });
    const many = await Promise.all(
      [w.reception, w.reception2, w.owner, w.reception, w.reception2].map((c) =>
        followUp.open(c, { ...dto, requestKey: key() }),
      ),
    );
    expect(new Set(many.map((x) => x.case.id))).toEqual(new Set([a.case.id]));
    expect(await prisma.studentFollowUp.count({ where: { academyStudentId: s.id } })).toBe(1);
    // The same key for something else, or another learner: refused.
    const other = await student(w.A.acad.id, 'تاني');
    expect(
      await refusal(
        followUp.open(w.reception, {
          ...dto,
          academyStudentId: other.id,
          reason: 'MANUAL',
          signalKey: undefined,
          note: 'xxxx',
        }),
      ),
    ).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('a case is opened only for a signal that is really raised; a manual case names no signal', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await student(w.A.acad.id, 'مفيش إشارة');
    expect(
      await refusal(
        followUp.open(w.reception, {
          requestKey: key(),
          academyStudentId: s.id,
          reason: 'ABSENT_STREAK',
          signalKey: 'made-up',
        }),
      ),
    ).toBe('SIGNAL_NOT_FOUND');
    expect(
      await refusal(
        followUp.open(w.reception, {
          requestKey: key(),
          academyStudentId: s.id,
          reason: 'MANUAL',
          signalKey: 'x',
          note: 'xxxx',
        }),
      ),
    ).toBe('SIGNAL_KEY_NOT_ALLOWED');
    const foreign = await student(w.B.acad.id, 'برا');
    expect(
      await refusal(
        followUp.open(w.reception, {
          requestKey: key(),
          academyStudentId: foreign.id,
          reason: 'MANUAL',
          note: 'xxxx',
        }),
      ),
    ).toBe('STUDENT_NOT_FOUND');
  });

  it('two people closing at once: exactly one terminal result; a repeat changes nothing; assign only while open', async () => {
    if (!guard()) return;
    const w = await world();
    const { s, signalKey } = await streakLearner(w);
    const c = (
      await followUp.open(w.reception, {
        requestKey: key(),
        academyStudentId: s.id,
        reason: 'ABSENT_STREAK',
        signalKey,
      })
    ).case;
    expect(await refusal(followUp.assign(w.owner, c.id, { assignedToUserId: w.teacherId }))).toBe(
      'ASSIGNEE_INVALID',
    );
    expect(
      await refusal(followUp.assign(w.owner, c.id, { assignedToUserId: w.ownerB.userId })),
    ).toBe('ASSIGNEE_INVALID');
    expect(
      (await followUp.assign(w.owner, c.id, { assignedToUserId: w.receptionId, dueOn: w.today }))
        .assignedTo?.id,
    ).toBe(w.receptionId);
    const race = await Promise.allSettled([
      followUp.close(w.reception, c.id, 'RESOLVED', 'ولي الأمر رد'),
      followUp.close(w.reception2, c.id, 'DISMISSED', 'مش محتاج'),
      followUp.close(w.owner, c.id, 'RESOLVED', 'ولي الأمر رد'),
    ]);
    const row = await prisma.studentFollowUp.findUniqueOrThrow({ where: { id: c.id } });
    expect(['RESOLVED', 'DISMISSED']).toContain(row.status);
    const changed = race.filter((r) => r.status === 'fulfilled' && r.value.changed).length;
    expect(changed).toBe(1);
    for (const r of race)
      if (r.status === 'rejected') expect(r.reason?.response?.code).toBe('CASE_ALREADY_CLOSED');
    expect((await followUp.close(w.owner, c.id, row.status as 'RESOLVED', 'تاني')).changed).toBe(
      false,
    );
    expect(await refusal(followUp.assign(w.owner, c.id, { assignedToUserId: null }))).toBe(
      'CASE_ALREADY_CLOSED',
    );
    // The signal is still raised: a new case may be opened for it now.
    expect(
      (
        await followUp.open(w.reception, {
          requestKey: key(),
          academyStudentId: s.id,
          reason: 'ABSENT_STREAK',
          signalKey,
        })
      ).created,
    ).toBe(true);
    const meta = await prisma.auditLog.findMany({
      where: { entity: 'StudentFollowUp', academyId: w.A.acad.id },
    });
    expect(meta.map((m) => m.action)).toEqual(
      expect.arrayContaining(['followup.case.open', 'followup.case.assign']),
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C5 — contacts', () => {
  async function linked(w: World, s: Learner, phone: string, opened = false) {
    const u = await prisma.user.create({ data: { role: 'GUARDIAN', fullName: 'ولي أمر', phone } });
    const g = await prisma.guardian.create({ data: { userId: u.id } });
    const l = await prisma.guardianLink.create({
      data: {
        guardianId: g.id,
        studentId: s.studentId,
        academyId: w.A.acad.id,
        relationship: 'FATHER',
        createdByUserId: w.A.ownerId,
      },
    });
    await prisma.guardianAccessToken.create({
      data: {
        linkId: l.id,
        tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
        expiresAt: new Date(Date.now() + 86_400_000),
        createdByUserId: w.A.ownerId,
        useCount: opened ? 1 : 0,
      },
    });
    return l.id;
  }
  const phone = () => `+2010${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

  it('logging is append-only and idempotent; guardian, case and learner are checked; the note stays out of the audit', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await student(w.A.acad.id, 'اتصال', { guardianName: 'الأب', guardianPhone: phone() });
    const linkId = await linked(w, s, phone());
    const dto = {
      requestKey: key(),
      channel: 'WHATSAPP' as const,
      outcome: 'MESSAGE_SENT' as const,
      party: 'GUARDIAN_LINK' as const,
      guardianLinkId: linkId,
      note: 'سرّي: رقم الأم مختلف',
    };
    const three = await Promise.all(
      [1, 2, 3].map(() => followUp.logContact(w.reception, s.id, dto)),
    );
    expect(new Set(three.map((x) => x.contact.id)).size).toBe(1);
    expect(three.filter((x) => x.created)).toHaveLength(1);
    expect(await prisma.studentContact.count({ where: { academyStudentId: s.id } })).toBe(1);
    expect(
      await refusal(followUp.logContact(w.reception, s.id, { ...dto, outcome: 'REACHED' })),
    ).toBe('IDEMPOTENCY_KEY_REUSED');
    const audit = await prisma.auditLog.findMany({
      where: { action: 'followup.contact.log', academyId: w.A.acad.id },
    });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0].meta)).not.toMatch(/سرّي|رقم|\+20/);
    // Another learner's guardian, a revoked guardian, a closed case, a foreign learner.
    const other = await student(w.A.acad.id, 'أخوه');
    const otherLink = await linked(w, other, phone());
    expect(
      await refusal(
        followUp.logContact(w.reception, s.id, {
          ...dto,
          requestKey: key(),
          guardianLinkId: otherLink,
        }),
      ),
    ).toBe('CONTACT_GUARDIAN_NOT_FOUND');
    await prisma.guardianLink.update({
      where: { id: linkId },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    expect(
      await refusal(followUp.logContact(w.reception, s.id, { ...dto, requestKey: key() })),
    ).toBe('CONTACT_GUARDIAN_NOT_FOUND');
    const c = (
      await followUp.open(w.reception, {
        requestKey: key(),
        academyStudentId: s.id,
        reason: 'MANUAL',
        note: 'تابع',
      })
    ).case;
    await followUp.close(w.reception, c.id, 'RESOLVED', 'خلاص');
    expect(
      await refusal(
        followUp.logContact(w.reception, s.id, {
          requestKey: key(),
          channel: 'PHONE_CALL',
          outcome: 'REACHED',
          party: 'REGISTER_GUARDIAN',
          followUpId: c.id,
        }),
      ),
    ).toBe('CASE_ALREADY_CLOSED');
    expect(
      await refusal(
        followUp.logContact(w.reception, s.id, {
          requestKey: key(),
          channel: 'PHONE_CALL',
          outcome: 'REACHED',
          party: 'STUDENT',
          guardianLinkId: otherLink,
        }),
      ),
    ).toBe('CONTACT_PARTY_MISMATCH');
    const foreign = await student(w.B.acad.id, 'برا');
    expect(
      await refusal(
        followUp.logContact(w.reception, foreign.id, {
          requestKey: key(),
          channel: 'PHONE_CALL',
          outcome: 'REACHED',
          party: 'STUDENT',
        }),
      ),
    ).toBe('STUDENT_NOT_FOUND');
  });

  it('register contact ≠ guardian account ≠ connected guardian', async () => {
    if (!guard()) return;
    const w = await world();
    const regPhone = phone();
    const s = await student(w.A.acad.id, 'جهة اتصال', {
      guardianName: 'أم أحمد',
      guardianPhone: regPhone,
    });
    const usersBefore = await prisma.user.count({ where: { phone: regPhone } });
    const v = await followUp.student(w.reception, s.id);
    expect(v.parties.registerContact).toEqual({
      name: 'أم أحمد',
      phone: regPhone,
      invitedAs: null,
    });
    expect(v.parties.guardians).toEqual([]);
    expect(await prisma.user.count({ where: { phone: regPhone } })).toBe(usersBefore); // reading created nothing
    expect(usersBefore).toBe(0);
    // An invited guardian is INVITED until their link is really opened.
    await linked(w, s, regPhone, false);
    const scope = await scopes.forContext(w.owner);
    expect((await guardians.listForStudent(scope, s.studentId)).map((g) => g.state)).toEqual([
      'INVITED',
    ]);
    expect(
      (await followUp.student(w.reception, s.id)).parties.registerContact?.invitedAs,
    ).not.toBeNull();
    await prisma.guardianAccessToken.updateMany({
      where: { link: { studentId: s.studentId } },
      data: { useCount: 1 },
    });
    expect((await guardians.listForStudent(scope, s.studentId)).map((g) => g.state)).toEqual([
      'CONNECTED',
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C5 — timeline and guardian fees', () => {
  it('composed from the owners of each fact; fee events never even fetched without fees.view', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await student(w.A.acad.id, 'خط زمني');
    await prisma.groupMembership.create({
      data: {
        academyId: w.A.acad.id,
        groupId: w.A.gA.id,
        studentId: s.studentId,
        addedAt: new Date(Date.now() - 3 * 86_400_000),
      },
    });
    await history(w, s, ['PRESENT', 'ABSENT']);
    await oneTime(w, s, EGP(100), w.today);
    await followUp.logContact(w.reception, s.id, {
      requestKey: key(),
      channel: 'PHONE_CALL',
      outcome: 'REACHED',
      party: 'REGISTER_GUARDIAN',
      note: 'تمام',
    });
    const spy = jest.spyOn(fees, 'timelineEvents');
    const withFees = await timeline.forStudent(w.reception, s.id);
    const kinds = withFees.items.map((i) => i.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['REGISTERED', 'JOINED_GROUP', 'ATTENDANCE', 'FEE_CHARGE', 'CONTACT']),
    );
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();
    const noFees = await timeline.forStudent(w.followNoFees, s.id);
    expect(spy).not.toHaveBeenCalled();
    expect(noFees.fees).toBe(false);
    expect(JSON.stringify(noFees)).not.toMatch(/FEE_|amountCents|receiptNumber/);
    spy.mockRestore();
    expect(await refusal(timeline.forStudent(w.ownerB, s.id))).toBe('STUDENT_NOT_FOUND');
  });

  it('guardians see fees only when follow-up is on AND the academy chose to — and only safe fields', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await student(w.A.acad.id, 'ابن');
    await oneTime(w, s, EGP(500), addDays(w.today, -3));
    await fees.collect(w.owner, s.id, {
      requestKey: key(),
      amountCents: EGP(200),
      method: 'CASH',
      note: 'ملاحظة داخلية',
    });
    expect(await guardianFees.forChild(w.A.acad.id, s.studentId)).toBeNull(); // default OFF
    await settings.update(w.owner, { guardianFeesVisible: true });
    const v = await guardianFees.forChild(w.A.acad.id, s.studentId);
    expect(v).toMatchObject({
      outstandingCents: EGP(300),
      overdueCents: EGP(300),
      receipts: [expect.objectContaining({ amountCents: EGP(200), reversed: false })],
    });
    expect(JSON.stringify(v)).not.toMatch(/ملاحظة|note|collector|receivedBy|reason|adjust/i);
    await flags.setFlag(w.A.acad.id, 'studentFollowUp', false, w.A.ownerId);
    expect(await guardianFees.forChild(w.A.acad.id, s.studentId)).toBeNull();
    // Not coupled to centerFees being used internally: off by default even where C4 is on.
    expect(await guardianFees.forChild(w.B.acad.id, s.studentId)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C5 — who may do what', () => {
  async function viaGuards(user: JwtPayload, academyId: string, method: keyof FollowUpController) {
    const req: any = { user, headers: { 'x-academy-id': academyId }, params: {} };
    const exec: any = {
      getHandler: () => FollowUpController.prototype[method],
      getClass: () => FollowUpController,
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
  const VIEW = [
    'signalsToday',
    'contactsToday',
    'cases',
    'student',
    'timelineOf',
    'getSettings',
  ] as const;
  const MANAGE = ['open', 'assign', 'resolve', 'dismiss', 'logContact', 'staff'] as const;

  it('owner: all; Reception with the preset: view + manage, not settings; teacher, desk without follow-up, student, other academy: nothing', async () => {
    if (!guard()) return;
    const w = await world();
    for (const m of [...VIEW, ...MANAGE, 'updateSettings' as const])
      expect(await outcome(viaGuards(jwt(w.A.ownerId, Role.STAFF), w.A.acad.id, m))).toBe(
        'ALLOWED',
      );
    for (const m of [...VIEW, ...MANAGE])
      expect(await outcome(viaGuards(jwt(w.receptionId, Role.STAFF), w.A.acad.id, m))).toBe(
        'ALLOWED',
      );
    expect(
      await outcome(viaGuards(jwt(w.receptionId, Role.STAFF), w.A.acad.id, 'updateSettings')),
    ).toBe('FORBIDDEN');
    const stu = await prisma.user.create({ data: { role: 'STUDENT', fullName: 'x' } });
    for (const m of [...VIEW, ...MANAGE, 'updateSettings' as const]) {
      expect(await outcome(viaGuards(jwt(w.teacherId, Role.TEACHER), w.A.acad.id, m))).toBe(
        'FORBIDDEN',
      );
      expect(await outcome(viaGuards(jwt(w.deskOnlyId, Role.STAFF), w.A.acad.id, m))).toBe(
        'FORBIDDEN',
      );
      expect(await outcome(viaGuards(jwt(stu.id, Role.STUDENT), w.A.acad.id, m))).not.toBe(
        'ALLOWED',
      );
      expect(await outcome(viaGuards(jwt(w.B.ownerId, Role.STAFF), w.A.acad.id, m))).not.toBe(
        'ALLOWED',
      );
    }
    await flags.setFlag(w.A.acad.id, 'studentFollowUp', false, w.A.ownerId);
    for (const m of [...VIEW, ...MANAGE])
      expect(await outcome(viaGuards(jwt(w.A.ownerId, Role.STAFF), w.A.acad.id, m))).toBe(
        'FORBIDDEN',
      );
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C5 — never an attendance gate, never touches other books', () => {
  it('an owing learner with an open case checks in at the desk; C5 wrote nothing in C2 or C4', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await student(w.A.acad.id, 'مديون ومتابَع');
    await prisma.groupMembership.create({
      data: {
        academyId: w.A.acad.id,
        groupId: w.A.gA.id,
        studentId: s.studentId,
        addedAt: new Date(Date.now() - 86_400_000),
      },
    });
    await oneTime(w, s, EGP(400), addDays(w.today, -20));
    const sig = (await signalsOf(w, s)).find((x) => x.reason === 'FEES_OVERDUE')!;
    const before = await hashOf([
      'CenterCharge',
      'CenterCollection',
      'CenterAllocation',
      'CenterAdjustment',
      'AttendanceRecord',
      'AttendanceSession',
      'GroupMembership',
      'AcademyStudent',
    ]);
    await followUp.open(w.reception, {
      requestKey: key(),
      academyStudentId: s.id,
      reason: 'FEES_OVERDUE',
      signalKey: sig.signalKey,
    });
    await followUp.logContact(w.reception, s.id, {
      requestKey: key(),
      channel: 'WHATSAPP',
      outcome: 'MESSAGE_SENT',
      party: 'REGISTER_GUARDIAN',
    });
    await signals.today(w.reception, {});
    await timeline.forStudent(w.reception, s.id);
    expect(
      await hashOf([
        'CenterCharge',
        'CenterCollection',
        'CenterAllocation',
        'CenterAdjustment',
        'AttendanceRecord',
        'AttendanceSession',
        'GroupMembership',
        'AcademyStudent',
      ]),
    ).toEqual(before);
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
    const r = await classes.deskCheckIn(w.reception, {
      sessionId: c.id,
      studentId: s.studentId,
      method: 'CODE',
    });
    expect(r.status).toBe('PRESENT');
  });

  it('platform money: byte-identical after every C5 flow above', async () => {
    if (!guard()) return;
    expect(await hashOf(PLATFORM)).toEqual(platformBefore);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C5 — scale', () => {
  it("10,000 learners, months of attendance: Today's signals and a timeline stay quick", async () => {
    if (!guard() || process.env.C5_SCALE === '0') return;
    const w = await world();
    const N = 10_000;
    const groups = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        prisma.group.create({ data: { academyId: w.A.acad.id, name: `G${i}` } }),
      ),
    );
    const a = w.A.acad.id;
    // The worst case on purpose: statistics taken while the tables are tiny,
    // then 160k records arrive (a center that just grew or imported). With
    // stale estimates an earlier version of the signal query chose nested
    // loops and took minutes; this must stay quick anyway.
    await prisma.$executeRawUnsafe(
      'ANALYZE "AttendanceRecord", "AttendanceSession", "GroupSession", "AcademyStudent", "Group"',
    );
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
    // 20 groups × 16 classes over 8 weeks; every learner in one group, every class marked.
    const shIds: string[][] = [];
    for (const g of groups) {
      const list: string[] = [];
      for (let d = 1; d <= 16; d++)
        list.push((await classOn(w, g.id, addDays(w.today, -(d * 3)))).shId);
      shIds.push(list);
    }
    for (let gi = 0; gi < groups.length; gi++)
      await prisma.$executeRawUnsafe(
        `
        INSERT INTO "AttendanceRecord"(id, "sessionId", "studentId", status, "academyId", "markedBy", "updatedAt")
        SELECT 'r5-' || $1 || '-' || i || '-' || x.n, x.sh, ($5::text[])[i],
               (CASE WHEN (i + x.n) % 7 = 0 THEN 'LATE' WHEN i % 11 = 0 AND x.n <= 4 THEN 'ABSENT' WHEN (i * x.n) % 13 = 0 THEN 'ABSENT' ELSE 'PRESENT' END)::"AttendanceStatus",
               $2, $3, now()
        FROM generate_series(1, ${N}) i, unnest($4::text[]) WITH ORDINALITY AS x(sh, n)
        WHERE i % ${groups.length} = ${gi}`,
        w.k,
        a,
        w.A.ownerId,
        shIds[gi],
        recs.map((r) => r.studentId),
      );
    for (let i = 0; i < 400; i++)
      await oneTime(
        w,
        { id: recs[i * 7 + 1].id, studentId: '', code: '', name: '' },
        EGP(100),
        addDays(w.today, -30),
      );
    const t0 = Date.now();
    const today = await signals.today(w.reception, {});
    const signalsMs = Date.now() - t0;
    const t1 = Date.now();
    await timeline.forStudent(w.reception, recs[11].id);
    const timelineMs = Date.now() - t1;
    console.log(
      `C5 scale: ${today.total} signals in ${signalsMs} ms (absent streaks ${today.totals.ABSENT_STREAK}, late ${today.totals.LATE_STREAK}, fees ${today.totals.FEES_OVERDUE}); timeline ${timelineMs} ms`,
    );
    expect(today.totals.ABSENT_STREAK).toBeGreaterThan(100);
    expect(today.totals.FEES_OVERDUE).toBe(400);
    expect(signalsMs).toBeLessThan(3000);
    expect(timelineMs).toBeLessThan(500);
  }, 600_000);
});
