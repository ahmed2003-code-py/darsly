import { ForbiddenException, ValidationPipe } from '@nestjs/common';
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
import { GradesReadService } from '../paper-exams/grades-read.service';
import { PaperExamsService } from '../paper-exams/paper-exams.service';
import { PrismaService } from '../prisma/prisma.service';
import { DailyOpsController } from './daily-ops.controller';
import { DailyOpsService } from './daily-ops.service';
import { CloseDayDto } from './dto';

/**
 * Center Operations C7 against a real PostgreSQL: one business day's figures
 * from the sources (C2 classes and attendance, C3 desk check-ins, C4 money
 * received and reversals performed, C5 cases and contacts, C6 exams), the
 * exceptions that stand before a clean close, the versioned append-only
 * close, its drift after a legitimate correction, who may do what, and that
 * nothing else is written. The academy sits in a zone where it is about noon
 * now, so the day's classes lie safely inside it.
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
const grades = new GradesReadService(prisma, schedule, flags);
const exams = new PaperExamsService(prisma, grades, access, audit);
const fuSettings = new FollowUpSettingsService(prisma, audit);
const signals = new FollowUpSignalsService(prisma, schedule, fees, flags, fuSettings, grades);
const followUp = new FollowUpService(prisma, signals, schedule, audit);
const ops = new DailyOpsService(prisma, schedule, flags, audit, fees);

const OTHERS = [
  'Payment',
  'PaymentEvent',
  'LedgerTransaction',
  'LedgerEntry',
  'WalletTransaction',
  'PayoutRequest',
  'LivePurchase',
  'CommercialTerms',
  'Quiz',
  'QuizAttempt',
  'Assignment',
  'Challenge',
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

beforeAll(async () => {
  await prisma.onModuleInit().catch(() => undefined);
  ready = await databaseReady(prisma, ['centerDayClose', 'groupSession', 'centerCollection']);
});
afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
});
const guard = () => ready;
const jwt = (sub: string, role: Role) => ({ sub, role, sessionId: 's' }) as JwtPayload;
const ctxOf = async (userId: string, role: Role, academyId: string): Promise<AcademyContext> =>
  (await academy.buildContext(userId, academyId, role))!;
const key = () => randomUUID().replace(/-/g, '');
async function refusal(p: Promise<unknown>) {
  try {
    await p;
    return 'NO REFUSAL';
  } catch (e: any) {
    return e?.response?.code ?? e?.code ?? e?.message;
  }
}
function middayZone() {
  const off = ((12 - new Date().getUTCHours() + 36) % 24) - 12;
  return off === 0 ? 'Etc/UTC' : `Etc/GMT${off > 0 ? '-' : '+'}${Math.abs(off)}`;
}
const H = 3_600_000;
/** Learner codes are random (90,000 of them); a fixture never reuses one in this run. */
const usedCodes = new Set<string>();
const freshCode = () => {
  let c = generateStudentCode();
  while (usedCodes.has(c)) c = generateStudentCode();
  usedCodes.add(c);
  return c;
};

async function world() {
  const k = randomUUID().slice(0, 8);
  const owner = await prisma.user.create({
    data: { role: 'STAFF', fullName: `Owner ${k}`, email: `c7-o-${k}@it.test` },
  });
  const acad = await prisma.academy.create({
    data: {
      slug: `c7-${k}`,
      name: `C7 ${k}`,
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
    'dailyOperations',
  ] as const)
    await flags.setFlag(acad.id, f, true, owner.id);
  const member = async (tag: string, role: 'TEACHER' | 'ASSISTANT', permissions: string[]) => {
    const u = await prisma.user.create({
      data: {
        role: role === 'TEACHER' ? 'TEACHER' : 'STAFF',
        fullName: `${tag} ${k}`,
        email: `c7-${tag}-${k}@it.test`,
      },
    });
    if (role === 'TEACHER')
      await prisma.teacherProfile.create({
        data: { userId: u.id, slug: `c7-${tag}-${k}`, status: 'APPROVED' },
      });
    await prisma.academyMembership.create({
      data: {
        userId: u.id,
        academyId: acad.id,
        role,
        status: 'ACTIVE',
        courseScope: 'ALL',
        permissions,
      },
    });
    return u.id;
  };
  const teacherId = await member('t', 'TEACHER', []);
  const managerId = await member('m', 'ASSISTANT', ['daily.view', 'daily.close']);
  const viewerId = await member('v', 'ASSISTANT', ['daily.view']);
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
  const g = await prisma.group.create({ data: { academyId: acad.id, name: 'فيزياء أ' } });
  const other = await prisma.academy.create({
    data: {
      slug: `c7x-${k}`,
      name: `C7 other ${k}`,
      ownerUserId: owner.id,
      kind: 'CENTER',
      timezone: middayZone(),
    },
  });
  return {
    acad,
    other,
    g,
    ownerId: owner.id,
    teacherId,
    managerId,
    viewerId,
    receptionId,
    owner: await ctxOf(owner.id, Role.STAFF, acad.id),
    manager: await ctxOf(managerId, Role.STAFF, acad.id),
    viewer: await ctxOf(viewerId, Role.STAFF, acad.id),
    reception: await ctxOf(receptionId, Role.STAFF, acad.id),
  };
}
type World = Awaited<ReturnType<typeof world>>;
async function learner(w: World, name: string) {
  const u = await prisma.user.create({ data: { role: 'STUDENT', fullName: name } });
  const sp = await prisma.studentProfile.create({ data: { userId: u.id } });
  const rec = await prisma.academyStudent.create({
    data: {
      academyId: w.acad.id,
      studentId: sp.id,
      code: freshCode(),
      fullName: name,
      source: 'DESK',
    },
  });
  await prisma.groupMembership.create({
    data: {
      academyId: w.acad.id,
      groupId: w.g.id,
      studentId: sp.id,
      addedAt: new Date(Date.now() - 30 * 24 * H),
    },
  });
  return { id: rec.id, studentId: sp.id };
}
const cls = (w: World, fromNowH: number, hours = 1) =>
  prisma.groupSession.create({
    data: {
      academyId: w.acad.id,
      groupId: w.g.id,
      startAt: new Date(Date.now() + fromNowH * H),
      endAt: new Date(Date.now() + (fromNowH + hours) * H),
      locationType: 'CENTER',
      createdBy: w.ownerId,
    },
  });

describe('C7 — the database keeps the rules', () => {
  it('closes are append-only, versions consecutive, exceptions need a note, a second version a reason', async () => {
    if (!guard()) return;
    const w = await world();
    const base = {
      academyId: w.acad.id,
      businessDate: new Date('2026-03-10T00:00:00Z'),
      timezone: 'Etc/UTC',
      figures: {},
      closedBy: w.ownerId,
    };
    const v1 = await prisma.centerDayClose.create({
      data: { ...base, version: 1, exceptions: [], requestKey: key() },
    });
    await expect(
      prisma.centerDayClose.update({ where: { id: v1.id }, data: { reason: 'xxx' } }),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.centerDayClose.delete({ where: { id: v1.id } })).rejects.toThrow(
      /append-only/,
    );
    await expect(
      prisma.centerDayClose.create({
        data: { ...base, version: 3, exceptions: [], reason: 'قفل تاني', requestKey: key() },
      }),
    ).rejects.toThrow(/consecutive/);
    await expect(
      prisma.centerDayClose.create({
        data: { ...base, version: 2, exceptions: [], requestKey: key() },
      }),
    ).rejects.toThrow(/shape/);
    await expect(
      prisma.centerDayClose.create({
        data: {
          ...base,
          version: 2,
          exceptions: [{ code: 'X' }],
          reason: 'قفل تاني',
          requestKey: key(),
        },
      }),
    ).rejects.toThrow(/shape/);
    await prisma.centerDayClose.create({
      data: {
        ...base,
        version: 2,
        exceptions: [{ code: 'X' }],
        exceptionNote: 'معروف',
        reason: 'قفل تاني',
        requestKey: key(),
      },
    });
  });
});

describe('C7 — the day, from the sources', () => {
  it('classes, attendance, desk, money received and reversed, follow-up and exams — exact; drift after a correction; nothing else written', async () => {
    if (!guard()) return;
    const w = await world();
    const before = await hashOf(OTHERS);
    const today = (await schedule.academyClock(w.acad.id)).today;
    const L = await Promise.all(['أحمد', 'منى', 'عمر', 'نور', 'سارة'].map((n) => learner(w, n)));
    // Three classes today: one done and closed, one ended but never closed, one cancelled; one still to come.
    const done = await cls(w, -4);
    const open = await cls(w, -2.5);
    const cancelled = await cls(w, -6);
    await prisma.groupSession.update({
      where: { id: cancelled.id },
      data: { status: 'CANCELLED' },
    });
    await classes.mark(w.owner, done.id, {
      records: [
        { studentId: L[0].studentId, status: 'PRESENT' },
        { studentId: L[1].studentId, status: 'LATE' },
        { studentId: L[2].studentId, status: 'EXCUSED' },
      ],
    } as any);
    await classes.close(w.owner, done.id); // the other two become ABSENT
    await classes.mark(w.owner, open.id, {
      records: [{ studentId: L[0].studentId, status: 'PRESENT' }],
    } as any);
    // The desk checks one learner into a class on now.
    const now = await cls(w, -0.05, 1);
    await classes.deskCheckIn(w.reception, {
      sessionId: now.id,
      studentId: L[3].studentId,
      method: 'CODE',
    });

    // Money: a charge, two collections today, one reversed today; and a collection from
    // yesterday reversed today (the fixture backdates it in this test database only).
    for (const l of L.slice(0, 3))
      await fees.oneTime(w.owner, l.id, {
        requestKey: key(),
        description: 'ملزمة',
        amountCents: 50_000,
        dueOn: today,
      });
    const c1 = await fees.collect(w.reception, L[0].id, {
      requestKey: key(),
      amountCents: 20_000,
      method: 'CASH',
    });
    await fees.collect(w.reception, L[1].id, {
      requestKey: key(),
      amountCents: 15_000,
      method: 'BANK_TRANSFER',
    });
    const old = await fees.collect(w.reception, L[2].id, {
      requestKey: key(),
      amountCents: 7_000,
      method: 'CASH',
    });
    await prisma.$transaction([
      prisma.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      prisma.$executeRawUnsafe(
        `UPDATE "CenterCollection" SET "receivedAt" = "receivedAt" - interval '1 day' WHERE id = $1`,
        (old as any).receipt.collectionId,
      ),
    ]);
    await fees.reverse(w.owner, (c1 as any).receipt.collectionId, 'اتسجل غلط');
    await fees.reverse(w.owner, (old as any).receipt.collectionId, 'اتسجل غلط');

    // Follow-up: one case opened and resolved, one contact.
    const c = await followUp.open(w.owner, {
      requestKey: key(),
      academyStudentId: L[4].id,
      reason: 'MANUAL',
      note: 'متابعة يدوية',
    });
    await followUp.close(w.owner, c.case.id, 'RESOLVED', 'اتكلمنا');
    await followUp.logContact(w.owner, L[4].id, {
      requestKey: key(),
      channel: 'PHONE_CALL',
      outcome: 'REACHED',
      party: 'OTHER',
    } as any);
    // Exams: one published, one correction, one draft due.
    const e = (
      await exams.create(w.owner, {
        requestKey: key(),
        groupId: w.g.id,
        title: 'امتحان',
        examDate: today,
        maxScore: 3000,
      })
    ).exam;
    await exams.saveResults(w.owner, e.id, {
      requestKey: key(),
      rows: L.map((l) => ({ academyStudentId: l.id, status: 'SCORED' as const, score: 1500 })),
    });
    await exams.publish(w.owner, e.id);
    const v = (
      await prisma.paperExamResult.findFirstOrThrow({
        where: { examId: e.id, academyStudentId: L[0].id },
      })
    ).version;
    await exams.correct(w.owner, e.id, L[0].id, {
      version: v,
      status: 'SCORED',
      score: 1600,
      reason: 'جمع',
    });
    await exams.create(w.owner, {
      requestKey: key(),
      groupId: w.g.id,
      title: 'لسه',
      examDate: today,
      maxScore: 1000,
    });

    const d = await ops.day(w.owner, today);
    expect(d.figures.classes).toEqual({
      total: 4,
      scheduled: 2,
      completed: 1,
      cancelled: 1,
      ended: 2,
      upcoming: 1,
    });
    expect(d.figures.attendance).toMatchObject({
      present: 3,
      late: 1,
      absent: 2,
      excused: 1,
      closedClasses: 1,
      openClasses: 2,
    });
    // The ended, unclosed class: 5 expected, 1 marked.
    expect(d.figures.attendance.unmarked).toBe(4);
    expect(d.figures.desk).toEqual({ checkIns: 1, byCard: 0, byCode: 1 });
    expect(d.figures.collections).toMatchObject({
      received: { count: 2, amountCents: 35_000 },
      reversedToday: { count: 2, amountCents: 27_000 },
      netCents: 8_000,
    });
    expect(d.figures.collections!.received.byMethod.CASH).toEqual({
      count: 1,
      amountCents: 20_000,
    });
    expect(d.figures.followUp).toEqual({
      opened: 1,
      resolved: 1,
      dismissed: 0,
      contacts: 1,
      state: { openCases: 0 },
    });
    expect(d.figures.exams).toEqual({ published: 1, corrections: 1, state: { draftsDue: 1 } });
    expect(d.exceptions.map((x) => x.code).sort()).toEqual([
      'ATTENDANCE_NOT_CLOSED',
      'CLASS_NOT_ENDED',
    ]);
    expect(d.exceptions.find((x) => x.code === 'ATTENDANCE_NOT_CLOSED')).toMatchObject({
      sessionId: open.id,
      unmarked: 4,
    });
    // Yesterday: the payment received then, its reversal is today's.
    const y = await ops.day(w.owner, addDays(today, -1));
    expect(y.figures.collections).toMatchObject({
      received: { count: 1, amountCents: 7_000 },
      reversedToday: { count: 0 },
    });

    // Close: refused without a note (exceptions), then with it; double submit = one close.
    expect(await refusal(ops.close(w.owner, { date: today, requestKey: key() }))).toBe(
      'DAY_HAS_EXCEPTIONS',
    );
    const ck = key();
    const twice = await Promise.all([
      ops.close(w.manager, {
        date: today,
        requestKey: ck,
        exceptionNote: 'حصة لسه ماخلصتش وحصة مفتوحة',
      }),
      ops.close(w.manager, {
        date: today,
        requestKey: ck,
        exceptionNote: 'حصة لسه ماخلصتش وحصة مفتوحة',
      }),
    ]);
    expect(twice.map((t) => t.created).sort()).toEqual([false, true]);
    expect(await prisma.centerDayClose.count({ where: { academyId: w.acad.id } })).toBe(1);
    expect(
      await refusal(ops.close(w.owner, { date: today, requestKey: key(), exceptionNote: 'x x x' })),
    ).toBe('DAY_ALREADY_CLOSED');
    expect(await refusal(ops.close(w.owner, { date: addDays(today, 1), requestKey: key() }))).toBe(
      'DAY_IN_FUTURE',
    );
    expect(await refusal(ops.close(w.owner, { date: addDays(today, -2), requestKey: ck }))).toBe(
      'DAY_CLOSE_KEY_REUSED',
    );
    // Nothing changed since the close: a re-close (even with a reason) is refused, not a new version.
    expect(
      await refusal(
        ops.close(w.owner, {
          date: today,
          requestKey: key(),
          exceptionNote: 'x x x',
          reason: 'من غير تغيير',
        }),
      ),
    ).toBe('DAY_UNCHANGED');
    // An open day never blocks anything: attendance still closes after the day is closed.
    await classes.close(w.owner, open.id);
    const after = await ops.day(w.owner, today);
    expect(after.latest!.version).toBe(1);
    expect(after.latest!.drift).toEqual(['classes', 'attendance']);
    expect(after.closes[0]).toMatchObject({
      version: 1,
      exceptions: 2,
      exceptionNote: 'حصة لسه ماخلصتش وحصة مفتوحة',
      reason: null,
    });
    // The snapshot is what was true at close; re-closing records the corrected day.
    expect(after.latest!.figures.attendance.closedClasses).toBe(1);
    // Two re-closes at once after the change: one new version, the other told nothing changed.
    const pair = await Promise.allSettled(
      ['اتقفل الحضور بعد القفل', 'نفس السبب من جهاز تاني'].map((reason) =>
        ops.close(w.owner, {
          date: today,
          requestKey: key(),
          exceptionNote: 'حصة لسه ماخلصتش',
          reason,
        }),
      ),
    );
    const won = pair.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{
      version: number;
    }>[];
    expect(won.map((r) => r.value.version)).toEqual([2]);
    expect(
      (pair.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.response.code,
    ).toBe('DAY_UNCHANGED');
    const final = await ops.day(w.owner, today);
    expect(final.latest!.drift).toEqual([]);
    expect(final.closes.map((x) => x.version)).toEqual([1, 2]);
    // The audit log never holds the note or the reason.
    const log = await prisma.auditLog.findMany({
      where: { academyId: w.acad.id, action: 'day.close' },
    });
    expect(log).toHaveLength(2);
    expect(JSON.stringify(log.map((l) => l.meta))).not.toMatch(/حصة|اتقفل/);
    // A past day with no classes closes cleanly.
    expect(
      (await ops.close(w.owner, { date: addDays(today, -5), requestKey: key() })).version,
    ).toBe(1);
    expect(await hashOf(OTHERS)).toEqual(before);
  });

  it('redaction: a daily.view holder without fees.report / followup.view / grades sees no money, cases or exams — live or closed', async () => {
    if (!guard()) return;
    const w = await world();
    const today = (await schedule.academyClock(w.acad.id)).today;
    const l = await learner(w, 'منى');
    await fees.oneTime(w.owner, l.id, {
      requestKey: key(),
      description: 'ملزمة',
      amountCents: 10_000,
      dueOn: today,
    });
    await fees.collect(w.owner, l.id, { requestKey: key(), amountCents: 10_000, method: 'CASH' });
    await ops.close(w.owner, { date: today, requestKey: key() });
    const v = await ops.day(w.viewer, today);
    expect(v.figures.collections).toBeNull();
    expect(v.figures.followUp).toBeNull();
    expect(v.figures.exams).toBeNull();
    expect(v.latest!.figures.collections).toBeNull();
    expect((await ops.day(w.owner, today)).figures.collections!.received.amountCents).toBe(10_000);
    // Sections of a feature that is off are absent for everyone.
    await flags.setFlag(w.acad.id, 'centerFees', false, w.ownerId);
    expect((await ops.day(w.owner, today)).figures.collections).toBeNull();
  });
});

describe('C7 — edges', () => {
  it('a makeup visitor never hides an unmarked own learner; a group-scoped grades holder sees no academy exam totals', async () => {
    if (!guard()) return;
    const w = await world();
    const today = (await schedule.academyClock(w.acad.id)).today;
    const [a, b] = await Promise.all([learner(w, 'أ'), learner(w, 'ب')]);
    const g2 = await prisma.group.create({ data: { academyId: w.acad.id, name: 'ب' } });
    const visitorU = await prisma.user.create({ data: { role: 'STUDENT', fullName: 'زائر' } });
    const visitor = await prisma.studentProfile.create({ data: { userId: visitorU.id } });
    await prisma.groupMembership.create({
      data: {
        academyId: w.acad.id,
        groupId: g2.id,
        studentId: visitor.id,
        addedAt: new Date(Date.now() - 30 * 24 * H),
      },
    });
    // An ended class: one own learner marked, one not; one makeup visitor from another group.
    const c = await cls(w, -3);
    const sh = await prisma.attendanceSession.create({
      data: {
        academyId: w.acad.id,
        groupId: w.g.id,
        date: new Date(`${today}T00:00:00Z`),
        groupSessionId: c.id,
        createdBy: w.ownerId,
      },
    });
    await prisma.attendanceRecord.createMany({
      data: [
        {
          academyId: w.acad.id,
          sessionId: sh.id,
          studentId: a.studentId,
          status: 'PRESENT',
          markedBy: w.ownerId,
        },
        {
          academyId: w.acad.id,
          sessionId: sh.id,
          studentId: visitor.id,
          status: 'PRESENT',
          markedBy: w.ownerId,
          homeGroupId: g2.id,
        },
      ],
    });
    const d = await ops.day(w.owner, today);
    expect(d.figures.attendance).toMatchObject({ expected: 2, present: 2, makeup: 1, unmarked: 1 });
    expect(d.exceptions.find((x) => x.sessionId === c.id)).toMatchObject({
      code: 'ATTENDANCE_NOT_CLOSED',
      unmarked: 1,
    });
    expect(b).toBeTruthy();
    // An assistant holding daily.view and grades.view, assigned to one group only.
    const u = await prisma.user.create({
      data: { role: 'STAFF', fullName: 'مساعد', email: `c7-g-${randomUUID().slice(0, 8)}@it.test` },
    });
    await prisma.academyMembership.create({
      data: {
        userId: u.id,
        academyId: w.acad.id,
        role: 'ASSISTANT',
        status: 'ACTIVE',
        courseScope: 'ALL',
        permissions: ['daily.view', 'grades.view'],
      },
    });
    await prisma.groupAssignment.create({
      data: { groupId: w.g.id, userId: u.id, role: 'ASSISTANT', academyId: w.acad.id },
    });
    const scoped = await ctxOf(u.id, Role.STAFF, w.acad.id);
    expect((await ops.day(w.owner, today)).figures.exams).not.toBeNull();
    expect((await ops.day(scoped, today)).figures.exams).toBeNull();
  });
});

describe('C7 — who may do what', () => {
  async function viaGuards(user: JwtPayload, academyId: string, method: keyof DailyOpsController) {
    const req: any = { user, headers: { 'x-academy-id': academyId }, params: {} };
    const exec: any = {
      getHandler: () => DailyOpsController.prototype[method],
      getClass: () => DailyOpsController,
      switchToHttp: () => ({ getRequest: () => req }),
    };
    await new AcademyMembershipGuard(academy).canActivate(exec);
    new PermissionGuard(new Reflector()).canActivate(exec);
    await new FeatureFlagGuard(new Reflector(), flags).canActivate(exec);
  }
  const outcome = (p: Promise<unknown>) =>
    p.then(
      () => 'ALLOWED',
      (e) => (e instanceof ForbiddenException ? 'FORBIDDEN' : `OTHER:${e?.constructor?.name}`),
    );

  it('owner and a granted manager may view and close; a viewer only views; teacher, Reception, another academy and flag-off nothing', async () => {
    if (!guard()) return;
    const w = await world();
    for (const m of ['day', 'close'] as const) {
      expect(await outcome(viaGuards(jwt(w.ownerId, Role.STAFF), w.acad.id, m))).toBe('ALLOWED');
      expect(await outcome(viaGuards(jwt(w.managerId, Role.STAFF), w.acad.id, m))).toBe('ALLOWED');
      expect(await outcome(viaGuards(jwt(w.teacherId, Role.TEACHER), w.acad.id, m))).toBe(
        'FORBIDDEN',
      );
      expect(await outcome(viaGuards(jwt(w.receptionId, Role.STAFF), w.acad.id, m))).toBe(
        'FORBIDDEN',
      );
      expect(await outcome(viaGuards(jwt(w.ownerId, Role.STAFF), w.other.id, m))).not.toBe(
        'ALLOWED',
      );
    }
    expect(await outcome(viaGuards(jwt(w.viewerId, Role.STAFF), w.acad.id, 'day'))).toBe('ALLOWED');
    expect(await outcome(viaGuards(jwt(w.viewerId, Role.STAFF), w.acad.id, 'close'))).toBe(
      'FORBIDDEN',
    );
    await flags.setFlag(w.acad.id, 'dailyOperations', false, w.ownerId);
    expect(await outcome(viaGuards(jwt(w.ownerId, Role.STAFF), w.acad.id, 'day'))).toBe(
      'FORBIDDEN',
    );
  });

  it('a close names its own day; extra fields (version, figures, academyId, closedBy) are refused', async () => {
    if (!guard()) return;
    const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
    const bad = async (value: object) =>
      pipe.transform(value, { type: 'body', metatype: CloseDayDto }).then(
        () => 'ACCEPTED',
        () => 'REFUSED',
      );
    const base = { date: '2026-03-10', requestKey: key() };
    expect(await bad(base)).toBe('ACCEPTED');
    for (const extra of [
      { version: 2 },
      { figures: {} },
      { academyId: 'x' },
      { closedBy: 'x' },
      { date: '2026-13-01' },
      { date: 'today' },
      { requestKey: 'short' },
      { exceptionNote: 'x' },
    ])
      expect(await bad({ ...base, ...extra })).toBe('REFUSED');
  });
});

describe('C7 — scale', () => {
  it('a busy center (10,000 learners, a year of classes, collections and exam history), stale statistics: the day stays quick', async () => {
    if (!guard() || process.env.C7_SCALE === '0') return;
    const w = await world();
    const a = w.acad.id;
    await prisma.$executeRawUnsafe(
      'ANALYZE "GroupSession", "AttendanceRecord", "CenterCollection", "PaperExamRevision", "StudentFollowUp"',
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
        addedAt: new Date(Date.now() - 400 * 24 * H),
      })),
    });
    // A year of classes: every group twice a week (≈ 10,400 classes), attendance for each.
    await prisma.$executeRawUnsafe(
      `
      INSERT INTO "GroupSession"(id, "academyId", "groupId", "startAt", "endAt", "locationType", "createdBy", status, "updatedAt")
      SELECT 'gs' || md5(g.id || d::text), $1, g.id, now() - (d || ' days')::interval - interval '2 hours', now() - (d || ' days')::interval - interval '1 hour', 'CENTER', $2, 'COMPLETED', now()
      FROM "Group" g, generate_series(0, 364, 3) d WHERE g."academyId" = $1`,
      a,
      w.ownerId,
    );
    await prisma.$executeRawUnsafe(
      `
      INSERT INTO "AttendanceSession"(id, "academyId", "groupId", date, "groupSessionId", "createdBy", "closedAt", "closedBy")
      SELECT 'as' || gs.id, gs."academyId", gs."groupId", (gs."startAt" AT TIME ZONE 'UTC')::date, gs.id, $2, gs."endAt", $2
      FROM "GroupSession" gs WHERE gs."academyId" = $1`,
      a,
      w.ownerId,
    );
    await prisma.$executeRawUnsafe(
      `
      INSERT INTO "AttendanceRecord"(id, "academyId", "sessionId", "studentId", status, "markedBy", "updatedAt")
      SELECT 'ar' || md5(sh.id || m."studentId"), $1, sh.id, m."studentId", 'PRESENT', $2, now()
      FROM "AttendanceSession" sh JOIN "GroupMembership" m ON m."groupId" = sh."groupId"
      WHERE sh."academyId" = $1 AND sh.date > (now() - interval '60 days')::date`,
      a,
      w.ownerId,
    );
    const today = (await schedule.academyClock(a)).today;
    let t = Date.now();
    const d = await ops.day(w.owner, today);
    const dayMs = Date.now() - t;
    t = Date.now();
    await ops.day(w.owner, addDays(today, -30));
    const pastMs = Date.now() - t;
    console.log(
      `C7 scale: today ${d.classes.length} classes ${dayMs} ms; a busy past day ${pastMs} ms`,
    );
    expect(dayMs).toBeLessThan(2000);
    expect(pastMs).toBeLessThan(2000);
  }, 900_000);
});
