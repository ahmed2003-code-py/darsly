import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'crypto';
import { JwtPayload, Role } from '@darsly/shared-types';
import { AcademyContext } from '../academy/academy-context';
import { AcademyService } from '../academy/academy.service';
import { AcademyMembershipGuard } from '../academy/guards/academy-membership.guard';
import { PermissionGuard } from '../academy/guards/permission.guard';
import { AcademyOpsAccessService } from '../academy-ops/academy-ops-access.service';
import { AttendanceService } from '../academy-ops/attendance.service';
import { GroupsService } from '../academy-ops/groups.service';
import { SessionsService } from '../academy-ops/sessions.service';
import { NeedsAttentionService } from '../academy-ops/needs-attention.service';
import { AuditService } from '../audit/audit.service';
import { CenterStudentsService } from '../center-students/center-students.service';
import { generateStudentCode } from '../center-students/student-code';
import { databaseReady } from '../common/testing/db-available';
import { FeatureFlagGuard } from '../feature-flags/guards/feature-flag.guard';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { PrismaService } from '../prisma/prisma.service';
import { ClassAttendanceService } from './class-attendance.service';
import { ClassOpsController } from './class-ops.controller';
import { ClassScheduleService, HORIZON_DAYS } from './class-schedule.service';
import { addDays, dateKey, wallClock, weekdayOf, zonedToInstant } from './zoned-time';

/**
 * Center Operations C2 against a real PostgreSQL: the partial unique indexes,
 * GiST exclusion constraints, row locks, advisory locks, CHECKs and tenant
 * triggers are part of what is under test, and every race below is two real
 * transactions on two real connections.
 *
 * The world: Center A (Cairo) with an owner, two assigned teachers (T1 on
 * group A, T2 on group B), a receptionist (Reception preset), two rooms, and
 * register students; Center B with its own owner, group and student.
 * classOperations is on for both.
 */
process.env.JWT_ACCESS_SECRET ??= 'test-secret-for-signed-links-0123456789';
const prisma = new PrismaService();
let ready = false;
const academy = new AcademyService(prisma);
const audit = new AuditService(prisma);
const flags = new FeatureFlagsService(prisma);
const access = new AcademyOpsAccessService(prisma);
const realtime = { leaveThread: jest.fn(), emitToUser: () => undefined } as any;
const groups = new GroupsService(prisma, access, audit, realtime);
const sessions = new SessionsService(prisma, access, audit, academy);
const legacy = new AttendanceService(prisma, access, audit);
const schedule = new ClassScheduleService(prisma, access, audit, academy);
const classes = new ClassAttendanceService(prisma, access, audit, schedule);
const register = new CenterStudentsService(prisma, audit, groups);

const CAIRO = 'Africa/Cairo';
const MIN = 60_000;

beforeAll(async () => {
  await prisma.onModuleInit().catch(() => undefined);
  ready = await databaseReady(prisma, ['groupScheduleSlot', 'groupSession', 'attendanceRecord']);
});
afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
});
const guard = () => ready;

const jwt = (sub: string, role: Role) => ({ sub, role, sessionId: 's' }) as JwtPayload;
const ctxOf = async (userId: string, role: Role, academyId: string): Promise<AcademyContext> =>
  (await academy.buildContext(userId, academyId, role))!;
let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}${randomUUID().slice(0, 4)}`;

async function makeTeacher(k: string, academyId: string, tag: string) {
  const u = await prisma.user.create({
    data: { role: 'TEACHER', fullName: `Teacher ${tag} ${k}`, email: `c2-${tag}-${k}@it.test` },
  });
  await prisma.teacherProfile.create({
    data: { userId: u.id, slug: `c2-${tag}-${k}`, status: 'APPROVED' },
  });
  await prisma.academyMembership.create({
    data: { userId: u.id, academyId, role: 'TEACHER', status: 'ACTIVE' },
  });
  return u.id;
}

async function makeStudent(
  academyId: string,
  name: string,
  status: 'ACTIVE' | 'WITHDRAWN' = 'ACTIVE',
) {
  const u = await prisma.user.create({ data: { role: 'STUDENT', fullName: name } });
  const sp = await prisma.studentProfile.create({ data: { userId: u.id } });
  await prisma.academyStudent.create({
    data: {
      academyId,
      studentId: sp.id,
      code: generateStudentCode(),
      fullName: name,
      status,
      source: 'DESK',
      leftAt: status === 'WITHDRAWN' ? new Date() : null,
    },
  });
  return sp.id;
}

async function makeCenter(k: string, tag: string) {
  const owner = await prisma.user.create({
    data: { role: 'STAFF', fullName: `Owner ${tag} ${k}`, email: `c2-${tag}-o-${k}@it.test` },
  });
  const acad = await prisma.academy.create({
    data: { slug: `c2-${tag}-${k}`, name: `C2 ${tag} ${k}`, ownerUserId: owner.id, kind: 'CENTER' },
  });
  await prisma.academyMembership.create({
    data: { userId: owner.id, academyId: acad.id, role: 'OWNER', status: 'ACTIVE' },
  });
  await flags.setFlag(acad.id, 'studentRegistry', true, owner.id);
  await flags.setFlag(acad.id, 'classOperations', true, owner.id);
  const gA = await prisma.group.create({ data: { academyId: acad.id, name: `A ${tag}` } });
  const gB = await prisma.group.create({ data: { academyId: acad.id, name: `B ${tag}` } });
  const r1 = await prisma.room.create({ data: { academyId: acad.id, name: `R1 ${tag}` } });
  const r2 = await prisma.room.create({ data: { academyId: acad.id, name: `R2 ${tag}` } });
  return { acad, ownerId: owner.id, gA, gB, r1, r2 };
}

async function world() {
  const k = randomUUID().slice(0, 8);
  const A = await makeCenter(k, 'a');
  const B = await makeCenter(k, 'b');
  const t1 = await makeTeacher(k, A.acad.id, 't1');
  const t2 = await makeTeacher(k, A.acad.id, 't2');
  await prisma.groupAssignment.createMany({
    data: [
      { groupId: A.gA.id, userId: t1, role: 'TEACHER', academyId: A.acad.id },
      { groupId: A.gB.id, userId: t2, role: 'TEACHER', academyId: A.acad.id },
    ],
  });
  const rUser = await prisma.user.create({
    data: { role: 'STAFF', fullName: `Reception ${k}`, email: `c2-r-${k}@it.test` },
  });
  await prisma.academyMembership.create({
    data: {
      userId: rUser.id,
      academyId: A.acad.id,
      role: 'ASSISTANT',
      status: 'ACTIVE',
      courseScope: 'ALL',
      permissions: ['student.view', 'student.directory', 'student.register'],
    },
  });
  const owner = await ctxOf(A.ownerId, Role.STAFF, A.acad.id);
  const ownerB = await ctxOf(B.ownerId, Role.STAFF, B.acad.id);
  return {
    k,
    A,
    B,
    t1,
    t2,
    owner,
    ownerB,
    teacher1: await ctxOf(t1, Role.TEACHER, A.acad.id),
    teacher2: await ctxOf(t2, Role.TEACHER, A.acad.id),
    reception: await ctxOf(rUser.id, Role.STAFF, A.acad.id),
    receptionId: rUser.id,
  };
}

/** Add students to a group through the real membership writer. */
const join = (academyId: string, groupId: string, ids: string[]) =>
  prisma.$transaction((tx) => groups.writeMemberships(tx, academyId, groupId, ids));

/** A one-off class of `groupId` starting `offsetMin` from now. */
async function classAt(
  w: Awaited<ReturnType<typeof world>>,
  groupId: string,
  offsetMin: number,
  durationMin = 90,
  extra: Record<string, unknown> = {},
) {
  const startAt = new Date(Date.now() + offsetMin * MIN);
  return prisma.groupSession.create({
    data: {
      academyId: w.A.acad.id,
      groupId,
      startAt,
      endAt: new Date(startAt.getTime() + durationMin * MIN),
      locationType: 'CENTER',
      createdBy: w.A.ownerId,
      ...extra,
    },
  });
}

const today = () => wallClock(new Date(), CAIRO).date;
/** The next local date (from tomorrow) with this weekday. */
const nextWeekday = (wd: number) => {
  let d = addDays(today(), 1);
  while (weekdayOf(d) !== wd) d = addDays(d, 1);
  return d;
};
const tomorrowWd = () => weekdayOf(addDays(today(), 1));

async function codeOf(e: unknown) {
  return (e as { response?: { code?: string } })?.response?.code ?? (e as Error)?.message;
}
async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return codeOf(e);
  }
  return 'NO_ERROR';
}

// ───────────────────────────────────────────────────────────────────────────
describe('C2 — membership history', () => {
  it('leaving and coming back opens a new stint; the old one keeps its dates', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await makeStudent(w.A.acad.id, 'سارة');
    await join(w.A.acad.id, w.A.gA.id, [s]);
    const first = await prisma.groupMembership.findFirstOrThrow({
      where: { groupId: w.A.gA.id, studentId: s },
    });
    await groups.removeMember(w.owner, w.A.gA.id, s);
    await join(w.A.acad.id, w.A.gA.id, [s]);
    const all = await prisma.groupMembership.findMany({
      where: { groupId: w.A.gA.id, studentId: s, deletedAt: undefined },
      orderBy: { addedAt: 'asc' },
    });
    expect(all).toHaveLength(2);
    expect(all[0].id).toBe(first.id);
    expect(all[0].addedAt.getTime()).toBe(first.addedAt.getTime()); // never overwritten
    expect(all[0].deletedAt).not.toBeNull();
    expect(all[1].deletedAt).toBeNull();
    expect(all[1].addedAt.getTime()).toBeGreaterThanOrEqual(all[0].deletedAt!.getTime());
  });

  it('adding an active member again is a no-op (one open stint)', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await makeStudent(w.A.acad.id, 'منى');
    const [a, b] = await Promise.all([
      join(w.A.acad.id, w.A.gA.id, [s]),
      join(w.A.acad.id, w.A.gA.id, [s]),
    ]);
    expect([...a, ...b]).toEqual([s]);
    expect(
      await prisma.groupMembership.count({ where: { groupId: w.A.gA.id, studentId: s } }),
    ).toBe(1);
  });

  it('the database refuses a second open stint and overlapping stints', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await makeStudent(w.A.acad.id, 'ليلى');
    await join(w.A.acad.id, w.A.gA.id, [s]);
    await expect(
      prisma.$executeRaw`INSERT INTO "GroupMembership"(id,"groupId","studentId","academyId") VALUES (${uniq()}, ${w.A.gA.id}, ${s}, ${w.A.acad.id})`,
    ).rejects.toThrow(/Code: `23505`.*Key ..*groupId.*studentId.*already exists/);
    // An ended stint that overlaps the open one.
    await expect(
      prisma.$executeRaw`INSERT INTO "GroupMembership"(id,"groupId","studentId","academyId","addedAt","deletedAt")
        VALUES (${uniq()}, ${w.A.gA.id}, ${s}, ${w.A.acad.id}, now() - interval '1 day', now() + interval '1 day')`,
    ).rejects.toThrow(/GroupMembership_stints_no_overlap/);
    await expect(
      prisma.$executeRaw`INSERT INTO "GroupMembership"(id,"groupId","studentId","academyId","addedAt","deletedAt")
        VALUES (${uniq()}, ${w.A.gA.id}, ${s}, ${w.A.acad.id}, now(), now() - interval '1 day')`,
    ).rejects.toThrow(/GroupMembership_stint_order/);
  });

  it('transfer ends A and opens B in one step; history and attendance in A stay', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await makeStudent(w.A.acad.id, 'يوسف');
    // In group A since yesterday, so they were expected at its class two hours ago.
    await prisma.groupMembership.create({
      data: {
        groupId: w.A.gA.id,
        studentId: s,
        academyId: w.A.acad.id,
        addedAt: new Date(Date.now() - 86_400_000),
      },
    });
    const past = await classAt(w, w.A.gA.id, -120);
    await classes.mark(w.owner, past.id, { records: [{ studentId: s, status: 'PRESENT' }] });
    await groups.transfer(w.owner, w.A.gA.id, s, w.A.gB.id);
    const inA = await prisma.groupMembership.findMany({
      where: { groupId: w.A.gA.id, studentId: s, deletedAt: undefined },
    });
    const inB = await prisma.groupMembership.findMany({
      where: { groupId: w.A.gB.id, studentId: s },
    });
    expect(inA).toHaveLength(1);
    expect(inA[0].deletedAt).not.toBeNull();
    expect(inB).toHaveLength(1);
    const roster = await classes.roster(w.owner, past.id);
    expect(roster.students.find((x) => x.studentId === s)?.status).toBe('PRESENT');
    expect(await refusal(groups.transfer(w.owner, w.A.gB.id, s, w.A.gB.id))).toBe(
      'TRANSFER_SAME_GROUP',
    );
    expect(await refusal(groups.transfer(w.owner, w.A.gA.id, s, w.A.gB.id))).toBe(
      'MEMBERSHIP_NOT_FOUND',
    );
  });

  it('opposite transfers at once never deadlock and never leave a student in two or no groups', async () => {
    if (!guard()) return;
    const w = await world();
    const s1 = await makeStudent(w.A.acad.id, 'س1');
    const s2 = await makeStudent(w.A.acad.id, 'س2');
    await join(w.A.acad.id, w.A.gA.id, [s1]);
    await join(w.A.acad.id, w.A.gB.id, [s2]);
    const results = await Promise.allSettled([
      groups.transfer(w.owner, w.A.gA.id, s1, w.A.gB.id),
      groups.transfer(w.owner, w.A.gB.id, s2, w.A.gA.id),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    for (const s of [s1, s2])
      expect(await prisma.groupMembership.count({ where: { studentId: s, deletedAt: null } })).toBe(
        1,
      );
  });

  it('a transfer racing a withdrawal: one wins, the student never ends up active in B while withdrawn', async () => {
    if (!guard()) return;
    const w = await world();
    // Eight pairs at once: the race has to be able to happen to be ruled out.
    await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        const reg = await register.register(w.owner, {
          requestKey: uniq(),
          fullName: `مروان ${i}`,
        });
        const s = reg.student.studentId;
        await join(w.A.acad.id, w.A.gA.id, [s]);
        await Promise.allSettled([
          groups.transfer(w.owner, w.A.gA.id, s, w.A.gB.id),
          register.withdraw(w.owner, reg.student.id),
        ]);
        const rec = await prisma.academyStudent.findFirstOrThrow({
          where: { studentId: s, academyId: w.A.acad.id },
        });
        const open = await prisma.groupMembership.count({
          where: { studentId: s, deletedAt: null },
        });
        expect(open).toBe(rec.status === 'WITHDRAWN' ? 0 : 1);
      }),
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C2 — capacity', () => {
  it('the last seat goes to exactly one of two desks', async () => {
    if (!guard()) return;
    const w = await world();
    await groups.update(w.owner, w.A.gA.id, { capacity: 10 });
    const nine = await Promise.all(
      Array.from({ length: 9 }, (_, i) => makeStudent(w.A.acad.id, `ط${i}`)),
    );
    await join(w.A.acad.id, w.A.gA.id, nine);
    const x = await makeStudent(w.A.acad.id, 'X');
    const y = await makeStudent(w.A.acad.id, 'Y');
    const res = await Promise.allSettled([
      groups.addMembers(w.owner, w.A.gA.id, { studentIds: [x] }),
      groups.addMembers(w.owner, w.A.gA.id, { studentIds: [y] }),
    ]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(await codeOf(lost.reason)).toBe('GROUP_FULL');
    expect(
      await prisma.groupMembership.count({ where: { groupId: w.A.gA.id, deletedAt: null } }),
    ).toBe(10);
    // Harder: six desks' transactions at the membership writer at once, for one seat.
    await groups.update(w.owner, w.A.gA.id, { capacity: 11 });
    const six = await Promise.all(
      Array.from({ length: 6 }, (_, i) => makeStudent(w.A.acad.id, `ز${i}`)),
    );
    const race = await Promise.allSettled(six.map((id) => join(w.A.acad.id, w.A.gA.id, [id])));
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await prisma.groupMembership.count({ where: { groupId: w.A.gA.id, deletedAt: null } }),
    ).toBe(11);
  });

  it('the desk (C1) is refused a full group; capacity cannot drop below the seated count', async () => {
    if (!guard()) return;
    const w = await world();
    await groups.update(w.owner, w.A.gA.id, { capacity: 1 });
    const one = await register.register(w.reception, {
      requestKey: uniq(),
      fullName: 'أول طالب',
    });
    await register.addToGroup(w.reception, one.student.id, { groupId: w.A.gA.id });
    const two = await register.register(w.reception, {
      requestKey: uniq(),
      fullName: 'ثاني طالب',
    });
    expect(
      await refusal(
        register.addToGroup(w.reception, two.student.id, { groupId: w.A.gA.id } as any),
      ),
    ).toBe('GROUP_FULL');
    await groups.update(w.owner, w.A.gA.id, { capacity: null });
    await register.addToGroup(w.reception, two.student.id, { groupId: w.A.gA.id });
    expect(await refusal(groups.update(w.owner, w.A.gA.id, { capacity: 1 }))).toBe(
      'CAPACITY_BELOW_MEMBERS',
    );
  });

  it('config validates subject offering and year; the DB bounds the numbers', async () => {
    if (!guard()) return;
    const w = await world();
    const subject = await prisma.subject.create({
      data: { nameAr: `فيزياء ${w.k}`, nameEn: `Physics ${w.k}` },
    });
    expect(await refusal(groups.update(w.owner, w.A.gA.id, { subjectId: subject.id }))).toBe(
      'SUBJECT_NOT_OFFERED',
    );
    await prisma.academySubject.create({ data: { academyId: w.A.acad.id, subjectId: subject.id } });
    await groups.update(w.owner, w.A.gA.id, { subjectId: subject.id, lateGraceMin: 5 });
    expect(await refusal(groups.update(w.owner, w.A.gA.id, { gradeId: 'nope' }))).toBe(
      'GRADE_NOT_FOUND',
    );
    await expect(
      prisma.$executeRaw`UPDATE "Group" SET capacity = 0 WHERE id = ${w.A.gA.id}`,
    ).rejects.toThrow(/Group_capacity_range/);
    const d = await groups.detail(w.owner, w.A.gA.id);
    expect(d.subject?.id).toBe(subject.id);
    expect(d.lateGraceMin).toBe(5);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C2 — weekly timetable and generated classes', () => {
  const slotDto = (over: Record<string, unknown> = {}) => ({
    weekday: tomorrowWd(),
    startTime: '18:00',
    durationMin: 90,
    roomId: undefined as string | undefined,
    requestKey: uniq(),
    ...over,
  });

  it('a slot creates four weeks of classes at 18:00 Cairo, linked and keyed by local date', async () => {
    if (!guard()) return;
    const w = await world();
    const slot = await schedule.createSlot(w.owner, w.A.gA.id, {
      ...slotDto({ roomId: w.A.r1.id, teacherUserId: w.t1 }),
    });
    const occ = await prisma.groupSession.findMany({
      where: { slotId: slot.id },
      orderBy: { startAt: 'asc' },
    });
    expect(occ).toHaveLength(4);
    for (const o of occ) {
      const local = wallClock(o.startAt, CAIRO);
      expect(local.minute).toBe(18 * 60);
      expect(local.weekday).toBe(slot.weekday);
      expect(dateKey(o.occurrenceDate!)).toBe(local.date);
      expect(o.startAt.getTime()).toBe(zonedToInstant(local.date, 1080, CAIRO).getTime());
      expect(o.endAt.getTime() - o.startAt.getTime()).toBe(90 * MIN);
      expect(o).toMatchObject({
        roomId: w.A.r1.id,
        teacherUserId: w.t1,
        mode: 'PHYSICAL',
        groupId: w.A.gA.id,
      });
    }
    expect(dateKey(occ[0].occurrenceDate!)).toBe(nextWeekday(slot.weekday));
    expect(slot.generatedThrough).toBe(addDays(today(), HORIZON_DAYS - 1));
  });

  it('saving twice with one key makes one slot; generating again makes no duplicates', async () => {
    if (!guard()) return;
    const w = await world();
    const dto = slotDto();
    const [a, b] = await Promise.all([
      schedule.createSlot(w.owner, w.A.gA.id, { ...dto, locationType: 'CENTER' } as any),
      schedule.createSlot(w.owner, w.A.gA.id, { ...dto, locationType: 'CENTER' } as any),
    ]);
    expect(a.id).toBe(b.id);
    expect(await prisma.groupScheduleSlot.count({ where: { groupId: w.A.gA.id } })).toBe(1);
    // Generator ×2 at once (the worker and a Today read) — still four classes.
    await prisma.groupScheduleSlot.update({
      where: { id: a.id },
      data: { generatedThrough: null },
    });
    await Promise.all([schedule.ensureHorizon(w.A.acad.id), schedule.ensureHorizon(w.A.acad.id)]);
    expect(await prisma.groupSession.count({ where: { slotId: a.id } })).toBe(4);
  });

  it('a cancelled class never comes back, and stays cancelled through a slot edit', async () => {
    if (!guard()) return;
    const w = await world();
    const slot = await schedule.createSlot(w.owner, w.A.gA.id, {
      ...slotDto(),
      locationType: 'CENTER',
    } as any);
    const [first] = await prisma.groupSession.findMany({
      where: { slotId: slot.id },
      orderBy: { startAt: 'asc' },
    });
    await sessions.cancel(w.owner, first.id);
    await prisma.groupScheduleSlot.update({
      where: { id: slot.id },
      data: { generatedThrough: null },
    });
    await schedule.ensureHorizon(w.A.acad.id);
    await schedule.updateSlot(w.owner, slot.id, { startTime: '19:00' });
    const onThatDay = await prisma.groupSession.findMany({
      where: { slotId: slot.id, occurrenceDate: first.occurrenceDate, deletedAt: undefined },
    });
    expect(onThatDay).toHaveLength(1);
    expect(onThatDay[0]).toMatchObject({ id: first.id, status: 'CANCELLED' });
    expect(onThatDay[0].startAt.getTime()).toBe(first.startAt.getTime());
  });

  it('editing a slot moves only untouched future classes; started, edited and attended ones stay', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await makeStudent(w.A.acad.id, 'ندى');
    await join(w.A.acad.id, w.A.gA.id, [s]);
    const slot = await schedule.createSlot(w.owner, w.A.gA.id, {
      ...slotDto(),
      locationType: 'CENTER',
    } as any);
    const occ = await prisma.groupSession.findMany({
      where: { slotId: slot.id },
      orderBy: { startAt: 'asc' },
    });
    // [0] hand-edited, [1] started (set directly: its time is in the future), [2] has a sheet.
    await sessions.update(w.owner, occ[0].id, { locationNote: 'الدور الثاني' });
    await prisma.groupSession.update({ where: { id: occ[1].id }, data: { startedAt: new Date() } });
    await prisma.attendanceSession.create({
      data: {
        groupSessionId: occ[2].id,
        groupId: w.A.gA.id,
        academyId: w.A.acad.id,
        date: occ[2].occurrenceDate!,
        createdBy: w.A.ownerId,
      },
    });
    const preview = await schedule.updateSlot(w.owner, slot.id, {
      startTime: '17:00',
      dryRun: true,
    });
    expect(preview).toMatchObject({
      dryRun: true,
      summary: { updated: 1, removed: 0, created: 0, kept: 3 },
    });
    const unchanged = await prisma.groupSession.findUniqueOrThrow({ where: { id: occ[3].id } });
    expect(unchanged.startAt.getTime()).toBe(occ[3].startAt.getTime()); // dry run kept nothing
    const res = await schedule.updateSlot(w.owner, slot.id, { startTime: '17:00' });
    expect(res.summary).toMatchObject({ updated: 1, kept: 3 });
    for (const o of occ.slice(0, 3)) {
      const now = await prisma.groupSession.findUniqueOrThrow({ where: { id: o.id } });
      expect(now.startAt.getTime()).toBe(o.startAt.getTime());
    }
    const moved = await prisma.groupSession.findUniqueOrThrow({ where: { id: occ[3].id } });
    expect(wallClock(moved.startAt, CAIRO).minute).toBe(17 * 60);
    expect(moved.id).toBe(occ[3].id); // moved in place
  });

  it('changing the weekday removes untouched classes and creates the new ones', async () => {
    if (!guard()) return;
    const w = await world();
    const slot = await schedule.createSlot(w.owner, w.A.gA.id, {
      ...slotDto(),
      locationType: 'CENTER',
    } as any);
    const newWd = (slot.weekday + 2) % 7;
    const res = await schedule.updateSlot(w.owner, slot.id, { weekday: newWd });
    expect(res.summary.removed).toBe(4);
    const live = await prisma.groupSession.findMany({ where: { slotId: slot.id } });
    expect(live.length).toBeGreaterThanOrEqual(4);
    expect(live.every((o) => wallClock(o.startAt, CAIRO).weekday === newWd)).toBe(true);
    // Back to the old weekday: the removed keys are free again.
    await schedule.updateSlot(w.owner, slot.id, { weekday: slot.weekday });
    const back = await prisma.groupSession.findMany({ where: { slotId: slot.id } });
    expect(back.every((o) => wallClock(o.startAt, CAIRO).weekday === slot.weekday)).toBe(true);
  });

  it('a room conflict refuses the save with the date; the DB wins a concurrent race', async () => {
    if (!guard()) return;
    const w = await world();
    await schedule.createSlot(w.owner, w.A.gA.id, { ...slotDto({ roomId: w.A.r1.id }) });
    const e = await schedule
      .createSlot(w.owner, w.A.gB.id, {
        ...slotDto({ roomId: w.A.r1.id, startTime: '18:30' }),
      } as any)
      .catch((x) => x);
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.response).toMatchObject({ code: 'ROOM_CONFLICT', date: nextWeekday(tomorrowWd()) });
    expect(await prisma.groupScheduleSlot.count({ where: { groupId: w.A.gB.id } })).toBe(0);

    // Two different groups racing for room 2 at the same time: exactly one wins.
    const race = await Promise.allSettled([
      schedule.createSlot(w.owner, w.A.gA.id, {
        ...slotDto({ roomId: w.A.r2.id, startTime: '10:00' }),
      } as any),
      schedule.createSlot(w.owner, w.A.gB.id, {
        ...slotDto({ roomId: w.A.r2.id, startTime: '10:00' }),
      } as any),
    ]);
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = race.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(['ROOM_CONFLICT', 'GROUP_CONFLICT']).toContain(await codeOf(lost.reason));
    const inRoom = await prisma.groupSession.findMany({ where: { roomId: w.A.r2.id } });
    expect(inRoom).toHaveLength(4);
  });

  it('a slot edit racing the generator ends with one class per date', async () => {
    if (!guard()) return;
    const w = await world();
    const slot = await schedule.createSlot(w.owner, w.A.gA.id, {
      ...slotDto(),
      locationType: 'CENTER',
    } as any);
    await prisma.groupScheduleSlot.update({
      where: { id: slot.id },
      data: { generatedThrough: null },
    });
    await Promise.all([
      schedule.updateSlot(w.owner, slot.id, { startTime: '20:00' } as any),
      schedule.ensureHorizon(w.A.acad.id),
      schedule.ensureHorizon(w.A.acad.id),
    ]);
    const occ = await prisma.groupSession.findMany({ where: { slotId: slot.id } });
    const dates = occ.map((o) => dateKey(o.occurrenceDate!));
    expect(new Set(dates).size).toBe(dates.length);
    expect(occ.every((o) => wallClock(o.startAt, CAIRO).minute === 20 * 60)).toBe(true);
  });

  it('removing a slot keeps touched classes and drops untouched ones', async () => {
    if (!guard()) return;
    const w = await world();
    const slot = await schedule.createSlot(w.owner, w.A.gA.id, {
      ...slotDto(),
      locationType: 'CENTER',
    } as any);
    const [first] = await prisma.groupSession.findMany({
      where: { slotId: slot.id },
      orderBy: { startAt: 'asc' },
    });
    await sessions.cancel(w.owner, first.id);
    const out = await schedule.deleteSlot(w.owner, slot.id);
    expect(out.summary).toMatchObject({ removed: 3, kept: 1 });
    const left = await prisma.groupSession.findMany({ where: { slotId: slot.id } });
    expect(left.map((o) => o.id)).toEqual([first.id]);
    expect(await prisma.groupScheduleSlot.findFirst({ where: { id: slot.id } })).toBeNull();
  });

  it('the database refuses a second class for one slot and date, and a cross-academy slot', async () => {
    if (!guard()) return;
    const w = await world();
    const slot = await schedule.createSlot(w.owner, w.A.gA.id, {
      ...slotDto(),
      locationType: 'CENTER',
    } as any);
    const [o] = await prisma.groupSession.findMany({ where: { slotId: slot.id }, take: 1 });
    await expect(
      prisma.$executeRaw`INSERT INTO "GroupSession"(id,"academyId","groupId","startAt","endAt","createdBy","updatedAt","slotId","occurrenceDate")
        VALUES (${uniq()}, ${w.A.acad.id}, ${w.A.gB.id}, now() + interval '400 days', now() + interval '401 days', 'x', now(), ${slot.id}, ${o.occurrenceDate})`,
    ).rejects.toThrow(/Code: `23505`.*Key ..*slotId.*occurrenceDate.*already exists/);
    await expect(
      prisma.$executeRaw`INSERT INTO "GroupScheduleSlot"(id,"academyId","groupId",weekday,"startMinute","durationMin","locationType","validFrom","createdBy","updatedAt")
        VALUES (${uniq()}, ${w.B.acad.id}, ${w.A.gA.id}, 1, 600, 60, 'CENTER', current_date, 'x', now())`,
    ).rejects.toThrow(/crosses academies/);
  });

  it('a room from another academy, an archived room or an unassigned teacher are refused', async () => {
    if (!guard()) return;
    const w = await world();
    expect(
      await refusal(
        schedule.createSlot(w.owner, w.A.gA.id, { ...slotDto({ roomId: w.B.r1.id }) } as any),
      ),
    ).toBe('ROOM_NOT_FOUND');
    expect(
      await refusal(
        schedule.createSlot(w.owner, w.A.gA.id, {
          ...slotDto({ teacherUserId: w.t2, locationType: 'CENTER' }),
        } as any),
      ),
    ).toBe('TEACHER_NOT_IN_GROUP');
    await prisma.room.update({ where: { id: w.A.r2.id }, data: { status: 'ARCHIVED' } });
    expect(
      await refusal(
        schedule.createSlot(w.owner, w.A.gA.id, { ...slotDto({ roomId: w.A.r2.id }) } as any),
      ),
    ).toBe('ROOM_ARCHIVED');
    expect(await refusal(schedule.createSlot(w.owner, w.A.gA.id, { ...slotDto() } as any))).toBe(
      'LOCATION_REQUIRED',
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C2 — who is expected at a class (membership history)', () => {
  it('uses the stints that overlap the class window, and the register lifecycle', async () => {
    if (!guard()) return;
    const w = await world();
    const cls = await classAt(w, w.A.gA.id, -60, 90); // started an hour ago, ends in 30 min
    const ids = await Promise.all(
      ['before', 'leftBefore', 'leftDuring', 'addedDuring', 'withdrawnBefore'].map((n) =>
        makeStudent(w.A.acad.id, n),
      ),
    );
    const [before, leftBefore, leftDuring, addedDuring, withdrawnBefore] = ids;
    const at = (min: number) => new Date(cls.startAt.getTime() + min * MIN);
    await prisma.groupMembership.createMany({
      data: [
        { groupId: w.A.gA.id, studentId: before, academyId: w.A.acad.id, addedAt: at(-600) },
        {
          groupId: w.A.gA.id,
          studentId: leftBefore,
          academyId: w.A.acad.id,
          addedAt: at(-600),
          deletedAt: at(-1),
        },
        {
          groupId: w.A.gA.id,
          studentId: leftDuring,
          academyId: w.A.acad.id,
          addedAt: at(-600),
          deletedAt: at(30),
        },
        { groupId: w.A.gA.id, studentId: addedDuring, academyId: w.A.acad.id, addedAt: at(45) },
        {
          groupId: w.A.gA.id,
          studentId: withdrawnBefore,
          academyId: w.A.acad.id,
          addedAt: at(-600),
        },
      ],
    });
    await prisma.academyStudent.updateMany({
      where: { studentId: withdrawnBefore },
      data: { status: 'WITHDRAWN', leftAt: at(-5) },
    });
    const exp = await classes.expected(prisma, cls);
    const name = new Map(
      ids.map((id, i) => [
        id,
        ['before', 'leftBefore', 'leftDuring', 'addedDuring', 'withdrawnBefore'][i],
      ]),
    );
    expect([...exp].map((id) => name.get(id)).sort()).toEqual([
      'addedDuring',
      'before',
      'leftDuring',
    ]);
    // Exact boundaries: left exactly at start → not expected; added exactly at end → not expected.
    const edge = await classAt(w, w.A.gB.id, -60, 90);
    const e1 = await makeStudent(w.A.acad.id, 'edge1');
    const e2 = await makeStudent(w.A.acad.id, 'edge2');
    await prisma.groupMembership.createMany({
      data: [
        {
          groupId: w.A.gB.id,
          studentId: e1,
          academyId: w.A.acad.id,
          addedAt: new Date(edge.startAt.getTime() - 600 * MIN),
          deletedAt: edge.startAt,
        },
        { groupId: w.A.gB.id, studentId: e2, academyId: w.A.acad.id, addedAt: edge.endAt },
      ],
    });
    expect((await classes.expected(prisma, edge)).size).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C2 — taking attendance', () => {
  async function classWith(w: Awaited<ReturnType<typeof world>>, offsetMin: number, n = 3) {
    const ids = await Promise.all(
      Array.from({ length: n }, (_, i) => makeStudent(w.A.acad.id, `st${i}`)),
    );
    await prisma.groupMembership.createMany({
      data: ids.map((studentId) => ({
        groupId: w.A.gA.id,
        studentId,
        academyId: w.A.acad.id,
        addedAt: new Date(Date.now() - 86_400_000),
      })),
    });
    const cls = await classAt(w, w.A.gA.id, offsetMin);
    return { ids, cls };
  }

  it('a first check-in after the grace is LATE by the server clock; a correction sticks', async () => {
    if (!guard()) return;
    const w = await world();
    const { ids, cls } = await classWith(w, -20); // started 20 min ago, grace 10
    const r = await classes.mark(w.teacher1, cls.id, {
      records: [{ studentId: ids[0], status: 'PRESENT' }],
    });
    const row = r.students.find((s) => s.studentId === ids[0])!;
    expect(row.status).toBe('LATE');
    expect(row.checkedInAt).not.toBeNull();
    const r2 = await classes.mark(w.teacher1, cls.id, {
      records: [{ studentId: ids[0], status: 'PRESENT' }],
    });
    const row2 = r2.students.find((s) => s.studentId === ids[0])!;
    expect(row2.status).toBe('PRESENT');
    expect(new Date(row2.checkedInAt!).getTime()).toBe(new Date(row.checkedInAt!).getTime());
  });

  it('within the grace a check-in is PRESENT; a group grace overrides the academy', async () => {
    if (!guard()) return;
    const w = await world();
    const { ids, cls } = await classWith(w, -8);
    expect(
      (
        await classes.mark(w.owner, cls.id, { records: [{ studentId: ids[0], status: 'PRESENT' }] })
      ).students.find((s) => s.studentId === ids[0])!.status,
    ).toBe('PRESENT');
    await groups.update(w.owner, w.A.gA.id, { lateGraceMin: 5 });
    expect(
      (
        await classes.mark(w.owner, cls.id, { records: [{ studentId: ids[1], status: 'PRESENT' }] })
      ).students.find((s) => s.studentId === ids[1])!.status,
    ).toBe('LATE');
  });

  it('closing marks every unmarked expected student ABSENT (AUTO), once', async () => {
    if (!guard()) return;
    const w = await world();
    const { ids, cls } = await classWith(w, -30, 4);
    await classes.mark(w.teacher1, cls.id, {
      records: [
        { studentId: ids[0], status: 'PRESENT' },
        { studentId: ids[1], status: 'EXCUSED' },
      ],
    });
    // Close ×2 at once (two desks).
    const [a, b] = await Promise.all([
      classes.close(w.teacher1, cls.id),
      classes.close(w.owner, cls.id),
    ]);
    for (const r of [a, b]) expect(r.closedAt).not.toBeNull();
    const records = await prisma.attendanceRecord.findMany({
      where: { session: { groupSessionId: cls.id } },
    });
    expect(records).toHaveLength(4);
    expect(
      records
        .filter((r) => r.method === 'AUTO')
        .map((r) => r.studentId)
        .sort(),
    ).toEqual([ids[2], ids[3]].sort());
    expect(records.filter((r) => r.method === 'AUTO').every((r) => r.status === 'ABSENT')).toBe(
      true,
    );
    expect((await prisma.groupSession.findUniqueOrThrow({ where: { id: cls.id } })).status).toBe(
      'COMPLETED',
    );
    const closes = await prisma.auditLog.count({
      where: { action: 'attendance.close', academyId: w.A.acad.id },
    });
    expect(closes).toBe(1);
    // A correction after closing: the AUTO absence becomes a MANUAL decision.
    await classes.mark(w.owner, cls.id, { records: [{ studentId: ids[2], status: 'EXCUSED' }] });
    const fixed = await prisma.attendanceRecord.findFirstOrThrow({
      where: { studentId: ids[2], session: { groupSessionId: cls.id } },
    });
    expect(fixed).toMatchObject({ status: 'EXCUSED', method: 'MANUAL' });
    const log = await prisma.auditLog.findFirst({
      where: {
        action: 'attendance.mark',
        academyId: w.A.acad.id,
        meta: { path: ['afterClose'], equals: true },
      },
    });
    expect(log).not.toBeNull();
  });

  it('a mark racing the close: one record per student, never lost, never doubled', async () => {
    if (!guard()) return;
    const w = await world();
    const { ids, cls } = await classWith(w, -30, 3);
    await Promise.all([
      classes.mark(w.teacher1, cls.id, { records: [{ studentId: ids[0], status: 'PRESENT' }] }),
      classes.close(w.owner, cls.id),
    ]);
    const records = await prisma.attendanceRecord.findMany({
      where: { session: { groupSessionId: cls.id } },
    });
    expect(records).toHaveLength(3);
    const r0 = records.find((r) => r.studentId === ids[0])!;
    // Either order is valid: marked first (LATE, manual) or closed first then corrected (LATE, manual).
    expect(r0.method).toBe('MANUAL');
    expect(r0.status).toBe('LATE');
  });

  it('refuses strangers, cancelled classes, future classes, and a close before the start', async () => {
    if (!guard()) return;
    const w = await world();
    const { ids, cls } = await classWith(w, -30);
    const stranger = await makeStudent(w.A.acad.id, 'غريب');
    expect(
      await refusal(
        classes.mark(w.owner, cls.id, { records: [{ studentId: stranger, status: 'PRESENT' }] }),
      ),
    ).toBe('STUDENT_NOT_EXPECTED');
    const later = await classAt(w, w.A.gA.id, 180);
    expect(
      await refusal(
        classes.mark(w.owner, later.id, { records: [{ studentId: ids[0], status: 'PRESENT' }] }),
      ),
    ).toBe('ATTENDANCE_NOT_OPEN');
    const soon = await classAt(w, w.A.gA.id, 65, 30);
    expect(await refusal(classes.close(w.owner, soon.id))).toBe('ATTENDANCE_NOT_OPEN');
    await sessions.cancel(w.owner, soon.id);
    expect(
      await refusal(
        classes.mark(w.owner, soon.id, { records: [{ studentId: ids[0], status: 'PRESENT' }] }),
      ),
    ).toBe('SESSION_CANCELLED');
    // A class with attendance cannot be cancelled.
    await classes.mark(w.owner, cls.id, { records: [{ studentId: ids[0], status: 'PRESENT' }] });
    expect(await refusal(sessions.cancel(w.owner, cls.id))).toBe('SESSION_HAS_ATTENDANCE');
  });

  it('cancel racing the first mark: exactly one of them wins', async () => {
    if (!guard()) return;
    const w = await world();
    const { ids, cls } = await classWith(w, -5);
    const [m, c] = await Promise.allSettled([
      classes.mark(w.owner, cls.id, { records: [{ studentId: ids[0], status: 'PRESENT' }] }),
      sessions.cancel(w.owner, cls.id),
    ]);
    const s = await prisma.groupSession.findUniqueOrThrow({ where: { id: cls.id } });
    const recs = await prisma.attendanceRecord.count({
      where: { session: { groupSessionId: cls.id } },
    });
    if (s.status === 'CANCELLED') {
      expect(c.status).toBe('fulfilled');
      expect(recs).toBe(0);
    } else {
      expect(m.status).toBe('fulfilled');
      expect(recs).toBe(1);
    }
  });

  it('a class that ended but is not closed: no Start, marks recorded as given, still closable', async () => {
    if (!guard()) return;
    const w = await world();
    const { ids, cls } = await classWith(w, -120);
    const r = await classes.roster(w.teacher1, cls.id);
    expect(r).toMatchObject({ ended: true, canStart: false, canMark: true, canClose: true });
    await classes.start(w.teacher1, cls.id);
    expect(
      (await prisma.groupSession.findUniqueOrThrow({ where: { id: cls.id } })).startedAt,
    ).toBeNull();
    const m = await classes.mark(w.teacher1, cls.id, {
      records: [{ studentId: ids[0], status: 'PRESENT' }],
    });
    expect(m.students.find((x) => x.studentId === ids[0])?.status).toBe('PRESENT');
  });

  it('starting a class is server-timed and repeat-safe', async () => {
    if (!guard()) return;
    const w = await world();
    const { cls } = await classWith(w, -1);
    const [a, b] = await Promise.all([
      classes.start(w.teacher1, cls.id),
      classes.start(w.teacher1, cls.id),
    ]);
    expect(a.session.startedAt).not.toBeNull();
    expect(new Date(a.session.startedAt!).getTime()).toBe(new Date(b.session.startedAt!).getTime());
    expect(
      await prisma.auditLog.count({ where: { action: 'session.start', entityId: cls.id } }),
    ).toBe(1);
  });

  it('the occurrence sheet carries the local date; a date-based sheet on the same day still works', async () => {
    if (!guard()) return;
    const w = await world();
    const { ids, cls } = await classWith(w, -30);
    await classes.mark(w.owner, cls.id, { records: [{ studentId: ids[0], status: 'PRESENT' }] });
    const sheet = await prisma.attendanceSession.findFirstOrThrow({
      where: { groupSessionId: cls.id },
    });
    expect(dateKey(sheet.date)).toBe(wallClock(cls.startAt, CAIRO).date);
    // The legacy date-based flow on the same group and date: its own sheet.
    const d = dateKey(sheet.date);
    await legacy.mark(w.owner, w.A.gA.id, {
      date: d,
      records: [{ studentId: ids[1], status: 'ABSENT' }],
    });
    const view = await legacy.sessionFor(w.owner, w.A.gA.id, d);
    expect(view.students.find((s) => s.studentId === ids[1])?.status).toBe('ABSENT');
    expect(view.students.find((s) => s.studentId === ids[0])?.status).toBeNull();
    expect(
      await prisma.attendanceSession.count({ where: { groupId: w.A.gA.id, date: sheet.date } }),
    ).toBe(2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C2 — makeup', () => {
  it('a group A student attends group B as makeup; their membership and A record stay', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await makeStudent(w.A.acad.id, 'مكمل');
    await prisma.groupMembership.create({
      data: {
        groupId: w.A.gA.id,
        studentId: s,
        academyId: w.A.acad.id,
        addedAt: new Date(Date.now() - 86_400_000 * 3),
      },
    });
    const missed = await classAt(w, w.A.gA.id, -2 * 24 * 60);
    await classes.mark(w.owner, missed.id, { records: [{ studentId: s, status: 'ABSENT' }] });
    const target = await classAt(w, w.A.gB.id, -5);
    const r = await classes.makeup(w.teacher2, target.id, {
      studentId: s,
      makeupForSessionId: missed.id,
    });
    const row = r.students.find((x) => x.studentId === s)!;
    expect(row).toMatchObject({
      expected: false,
      status: 'PRESENT',
      makeup: { homeGroup: { id: w.A.gA.id } },
    });
    expect(row.makeup!.forSession!.id).toBe(missed.id);
    expect(
      await prisma.groupMembership.count({
        where: { studentId: s, groupId: w.A.gB.id, deletedAt: undefined },
      }),
    ).toBe(0);
    const home = await prisma.attendanceRecord.findFirstOrThrow({
      where: { studentId: s, session: { groupSessionId: missed.id } },
    });
    expect(home.status).toBe('ABSENT');
    // Repeat is harmless; double-click at once too.
    await Promise.all([
      classes.makeup(w.teacher2, target.id, { studentId: s, makeupForSessionId: missed.id }),
      classes.makeup(w.teacher2, target.id, { studentId: s, makeupForSessionId: missed.id }),
    ]);
    expect(
      await prisma.attendanceRecord.count({
        where: { studentId: s, session: { groupSessionId: target.id } },
      }),
    ).toBe(1);
    // It closes cleanly (not counted as an expected absentee).
    const closed = await classes.close(w.teacher2, target.id);
    expect(closed.counts.MAKEUP).toBe(1);
  });

  it('refuses own-class, withdrawn, foreign-academy and not-their-class makeups', async () => {
    if (!guard()) return;
    const w = await world();
    const own = await makeStudent(w.A.acad.id, 'منهم');
    await prisma.groupMembership.create({
      data: {
        groupId: w.A.gB.id,
        studentId: own,
        academyId: w.A.acad.id,
        addedAt: new Date(Date.now() - 86_400_000),
      },
    });
    const target = await classAt(w, w.A.gB.id, -5);
    expect(await refusal(classes.makeup(w.owner, target.id, { studentId: own }))).toBe(
      'MAKEUP_NOT_ALLOWED',
    );
    const gone = await makeStudent(w.A.acad.id, 'منسحب', 'WITHDRAWN');
    expect(await refusal(classes.makeup(w.owner, target.id, { studentId: gone }))).toBe(
      'STUDENT_WITHDRAWN',
    );
    const foreign = await makeStudent(w.B.acad.id, 'غريب');
    expect(await refusal(classes.makeup(w.owner, target.id, { studentId: foreign }))).toBe(
      'STUDENT_NOT_FOUND',
    );
    const lone = await makeStudent(w.A.acad.id, 'بدون مجموعة');
    expect(await refusal(classes.makeup(w.owner, target.id, { studentId: lone }))).toBe(
      'MAKEUP_NOT_ALLOWED',
    );
    const inA = await makeStudent(w.A.acad.id, 'في أ');
    await prisma.groupMembership.create({
      data: {
        groupId: w.A.gA.id,
        studentId: inA,
        academyId: w.A.acad.id,
        addedAt: new Date(Date.now() - 86_400_000),
      },
    });
    const otherClass = await classAt(w, w.A.gB.id, -3 * 24 * 60);
    expect(
      await refusal(
        classes.makeup(w.owner, target.id, { studentId: inA, makeupForSessionId: otherClass.id }),
      ),
    ).toBe('MAKEUP_NOT_ALLOWED');
    const bClass = await prisma.groupSession.create({
      data: {
        academyId: w.B.acad.id,
        groupId: w.B.gA.id,
        startAt: new Date(Date.now() - 86_400_000),
        endAt: new Date(Date.now() - 86_000_000),
        locationType: 'CENTER',
        createdBy: w.B.ownerId,
      },
    });
    expect(
      await refusal(
        classes.makeup(w.owner, target.id, { studentId: inA, makeupForSessionId: bClass.id }),
      ),
    ).toBe('SESSION_NOT_FOUND');
  });

  it('makeup respects the class seats; two makeups racing for the last seat: one wins', async () => {
    if (!guard()) return;
    const w = await world();
    const members = await Promise.all([
      makeStudent(w.A.acad.id, 'm1'),
      makeStudent(w.A.acad.id, 'm2'),
    ]);
    await prisma.groupMembership.createMany({
      data: members.map((studentId) => ({
        groupId: w.A.gB.id,
        studentId,
        academyId: w.A.acad.id,
        addedAt: new Date(Date.now() - 86_400_000),
      })),
    });
    await groups.update(w.owner, w.A.gB.id, { capacity: 3 });
    const guests = await Promise.all([
      makeStudent(w.A.acad.id, 'g1'),
      makeStudent(w.A.acad.id, 'g2'),
    ]);
    await prisma.groupMembership.createMany({
      data: guests.map((studentId) => ({
        groupId: w.A.gA.id,
        studentId,
        academyId: w.A.acad.id,
        addedAt: new Date(Date.now() - 86_400_000),
      })),
    });
    const target = await classAt(w, w.A.gB.id, -5);
    const res = await Promise.allSettled(
      guests.map((studentId) => classes.makeup(w.owner, target.id, { studentId })),
    );
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await codeOf((res.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason),
    ).toBe('GROUP_FULL');
  });

  it('a teacher finds makeup candidates by code only; the register holder by name too', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await makeStudent(w.A.acad.id, 'كريم عادل');
    await prisma.groupMembership.create({
      data: {
        groupId: w.A.gA.id,
        studentId: s,
        academyId: w.A.acad.id,
        addedAt: new Date(Date.now() - 86_400_000),
      },
    });
    const code = (await prisma.academyStudent.findFirstOrThrow({ where: { studentId: s } })).code;
    const target = await classAt(w, w.A.gB.id, -5);
    expect((await classes.makeupCandidates(w.teacher2, target.id, 'كريم')).mode).toBe('CODE_ONLY');
    const byCode = await classes.makeupCandidates(w.teacher2, target.id, code);
    expect(byCode.candidates.map((c) => c.studentId)).toEqual([s]);
    expect(byCode.candidates[0].groups.map((g) => g.id)).toEqual([w.A.gA.id]);
    expect(Object.keys(byCode.candidates[0])).not.toContain('studentPhone');
    const byName = await classes.makeupCandidates(w.owner, target.id, 'كريم');
    expect(byName.candidates.map((c) => c.studentId)).toContain(s);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C2 — who may do what', () => {
  /** Run a class-ops route's real guards for this caller. */
  async function viaGuards(user: JwtPayload, academyId: string, method: keyof ClassOpsController) {
    const req: any = { user, headers: { 'x-academy-id': academyId }, params: {} };
    const exec: any = {
      getHandler: () => ClassOpsController.prototype[method],
      getClass: () => ClassOpsController,
      switchToHttp: () => ({ getRequest: () => req }),
    };
    await new AcademyMembershipGuard(academy).canActivate(exec);
    new PermissionGuard(new Reflector()).canActivate(exec);
    await new FeatureFlagGuard(new Reflector(), flags).canActivate(exec);
    return req.academyContext as AcademyContext;
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

  it('reception (the desk) cannot plan, take attendance or open a class', async () => {
    if (!guard()) return;
    const w = await world();
    for (const m of [
      'day',
      'roster',
      'mark',
      'close',
      'makeup',
      'start',
      'createSlot',
      'updateSlot',
      'deleteSlot',
      'slots',
    ] as const)
      expect(await outcome(viaGuards(jwt(w.receptionId, Role.STAFF), w.A.acad.id, m))).toBe(
        'FORBIDDEN',
      );
    const a = await viaGuards(jwt(w.receptionId, Role.STAFF), w.A.acad.id, 'access').then(() =>
      new ClassOpsController(schedule, classes, flags, academy, prisma).access(w.reception),
    );
    expect(a).toMatchObject({ enabled: true, canAttend: false, canSchedule: false });
  });

  it('the flag gates every route; teachers and owners pass the guards', async () => {
    if (!guard()) return;
    const w = await world();
    expect(await outcome(viaGuards(jwt(w.t1, Role.TEACHER), w.A.acad.id, 'mark'))).toBe('ALLOWED');
    expect(await outcome(viaGuards(jwt(w.A.ownerId, Role.STAFF), w.A.acad.id, 'createSlot'))).toBe(
      'ALLOWED',
    );
    await flags.setFlag(w.A.acad.id, 'classOperations', false, w.A.ownerId);
    expect(await outcome(viaGuards(jwt(w.t1, Role.TEACHER), w.A.acad.id, 'mark'))).toBe(
      'FORBIDDEN',
    );
    expect(await outcome(viaGuards(jwt(w.A.ownerId, Role.STAFF), w.A.acad.id, 'day'))).toBe(
      'FORBIDDEN',
    );
    // A student of the academy is no member of its staff.
    const s = await makeStudent(w.A.acad.id, 'طالب');
    const sp = await prisma.studentProfile.findUniqueOrThrow({ where: { id: s } });
    expect(await outcome(viaGuards(jwt(sp.userId, Role.STUDENT), w.A.acad.id, 'day'))).not.toBe(
      'ALLOWED',
    );
  });

  it("a teacher acts only on their own groups' classes; other academies' ids are 404", async () => {
    if (!guard()) return;
    const w = await world();
    const s = await makeStudent(w.A.acad.id, 'ط');
    await prisma.groupMembership.create({
      data: {
        groupId: w.A.gB.id,
        studentId: s,
        academyId: w.A.acad.id,
        addedAt: new Date(Date.now() - 86_400_000),
      },
    });
    const bClass = await classAt(w, w.A.gB.id, -5);
    // T1 is on group A only.
    expect(await outcome(classes.roster(w.teacher1, bClass.id))).toBe('FORBIDDEN');
    expect(
      await outcome(
        classes.mark(w.teacher1, bClass.id, { records: [{ studentId: s, status: 'PRESENT' }] }),
      ),
    ).toBe('FORBIDDEN');
    expect(await outcome(classes.close(w.teacher1, bClass.id))).toBe('FORBIDDEN');
    expect(await outcome(classes.start(w.teacher1, bClass.id))).toBe('FORBIDDEN');
    expect(await outcome(schedule.listSlots(w.teacher1, w.A.gB.id))).toBe('FORBIDDEN');
    expect(
      await prisma.attendanceRecord.count({ where: { session: { groupSessionId: bClass.id } } }),
    ).toBe(0);
    // Center B's owner, with A's ids.
    expect(await outcome(classes.roster(w.ownerB, bClass.id))).toBe('NOT_FOUND');
    // Refused by the class lookup itself, not only by the group check behind it.
    expect(await refusal(classes.roster(w.ownerB, bClass.id))).toBe('SESSION_NOT_FOUND');
    expect(
      await outcome(
        classes.mark(w.ownerB, bClass.id, { records: [{ studentId: s, status: 'ABSENT' }] }),
      ),
    ).toBe('NOT_FOUND');
    expect(
      await outcome(
        schedule.createSlot(w.ownerB, w.A.gA.id, {
          weekday: 1,
          startTime: '10:00',
          durationMin: 60,
          locationType: 'CENTER',
        } as any),
      ),
    ).toBe('NOT_FOUND');
    const slot = await schedule.createSlot(w.owner, w.A.gA.id, {
      weekday: tomorrowWd(),
      startTime: '07:00',
      durationMin: 60,
      locationType: 'CENTER',
    } as any);
    expect(
      await outcome(schedule.updateSlot(w.ownerB, slot.id, { startTime: '08:00' } as any)),
    ).toBe('NOT_FOUND');
    expect(await outcome(schedule.deleteSlot(w.ownerB, slot.id))).toBe('NOT_FOUND');
    expect(await outcome(groups.transfer(w.ownerB, w.A.gA.id, s, w.B.gA.id))).toBe('NOT_FOUND');
    expect(
      await prisma.groupScheduleSlot.findUniqueOrThrow({ where: { id: slot.id } }),
    ).toMatchObject({ startMinute: 420, deletedAt: null });
  });

  it('Today: the owner sees every class, a teacher only theirs, each with its counts', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await makeStudent(w.A.acad.id, 'ع');
    await prisma.groupMembership.create({
      data: {
        groupId: w.A.gA.id,
        studentId: s,
        academyId: w.A.acad.id,
        addedAt: new Date(Date.now() - 86_400_000),
      },
    });
    const now = wallClock(new Date(), CAIRO).minute;
    // Keep both classes inside today's local date.
    const offset = now > 23 * 60 ? -30 : now < 60 ? 5 : -30;
    const a = await classAt(w, w.A.gA.id, offset, 20);
    await classAt(w, w.A.gB.id, offset, 20);
    await classes
      .mark(w.teacher1, a.id, { records: [{ studentId: s, status: 'PRESENT' }] })
      .catch(() => undefined);
    const own = await classes.day(w.owner);
    expect(own.classes.map((c) => c.group.id).sort()).toEqual([w.A.gA.id, w.A.gB.id].sort());
    const mine = await classes.day(w.teacher1);
    expect(mine.classes.map((c) => c.group.id)).toEqual([w.A.gA.id]);
    expect(mine.classes[0].counts.expected).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C2 — what reads attendance keeps working', () => {
  it('three closed classes missed in a row raise Needs Attention; a makeup elsewhere does not', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await makeStudent(w.A.acad.id, 'غايب دايمًا');
    const other = await makeStudent(w.A.acad.id, 'حاضر');
    const since = new Date(Date.now() - 30 * 86_400_000);
    await prisma.groupMembership.createMany({
      data: [s, other].map((studentId) => ({
        groupId: w.A.gA.id,
        studentId,
        academyId: w.A.acad.id,
        addedAt: since,
      })),
    });
    for (const daysAgo of [9, 6, 3]) {
      const c = await classAt(w, w.A.gA.id, -daysAgo * 24 * 60, 60);
      await classes.mark(w.owner, c.id, { records: [{ studentId: other, status: 'PRESENT' }] });
      await classes.close(w.owner, c.id);
    }
    // The same student sitting a group B class as makeup is not an absence anywhere.
    const b = await classAt(w, w.A.gB.id, -2 * 24 * 60, 60);
    await classes.makeup(w.owner, b.id, { studentId: s });
    const na = new NeedsAttentionService(prisma);
    const out = await na.overview(w.owner);
    const flagged = out.repeatedAbsences
      .filter((r) => r.groupId === w.A.gA.id)
      .map((r) => r.studentId);
    expect(flagged).toEqual([s]);
    expect(out.repeatedAbsences.some((r) => r.groupId === w.A.gB.id)).toBe(false);
    // Legacy readers see occurrence sheets by group and date.
    const history = await legacy.studentHistory(w.owner, s);
    expect(history.filter((h) => h.status === 'ABSENT')).toHaveLength(3);
  });
});

describe('C2 — scale', () => {
  it('a large center: 100 groups × 3 weekly slots generate fast and idempotently; Today stays quick', async () => {
    if (!guard()) return;
    const w = await world();
    const gs = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        prisma.group.create({ data: { academyId: w.A.acad.id, name: `G${i}` } }),
      ),
    );
    // 40 students per group (4,000 memberships).
    const users = await prisma.user.createManyAndReturn({
      data: Array.from({ length: 4000 }, (_, i) => ({
        role: 'STUDENT' as const,
        fullName: `s${i}`,
      })),
      select: { id: true },
    });
    const profiles = await prisma.studentProfile.createManyAndReturn({
      data: users.map((u) => ({ userId: u.id })),
      select: { id: true },
    });
    await prisma.groupMembership.createMany({
      data: profiles.map((p, i) => ({
        groupId: gs[Math.floor(i / 40)].id,
        studentId: p.id,
        academyId: w.A.acad.id,
        addedAt: new Date(Date.now() - 86_400_000),
      })),
    });
    // 300 slots written directly (no generation yet), each on its own hour.
    const today0 = today();
    await prisma.groupScheduleSlot.createMany({
      data: gs.flatMap((g, i) =>
        [0, 2, 4].map((d) => ({
          academyId: w.A.acad.id,
          groupId: g.id,
          weekday: d,
          startMinute: (i % 14) * 60 + 8 * 60,
          durationMin: 50,
          locationType: 'CENTER' as const,
          validFrom: new Date(`${today0}T00:00:00Z`),
          createdBy: w.A.ownerId,
        })),
      ),
    });
    let t = Date.now();
    const created = await schedule.ensureHorizon(w.A.acad.id);
    const firstMs = Date.now() - t;
    t = Date.now();
    const again = await schedule.ensureHorizon(w.A.acad.id);
    const againMs = Date.now() - t;
    await prisma.groupScheduleSlot.updateMany({
      where: { academyId: w.A.acad.id },
      data: { generatedThrough: null },
    });
    const forced = await schedule.ensureHorizon(w.A.acad.id);
    const total = await prisma.groupSession.count({
      where: { academyId: w.A.acad.id, slotId: { not: null } },
    });
    expect(created).toBeGreaterThanOrEqual(1100); // 300 slots × ~4 weeks (≈12 per slot, less today's past)
    expect(again).toBe(0);
    expect(forced).toBe(0);
    expect(total).toBe(created);
    t = Date.now();
    // From tomorrow: today's early classes may already have ended (and are,
    // rightly, not generated), which made this count depend on the hour it ran.
    let busiest = today0;
    for (let d = 1; d < 8; d++)
      if ([0, 2, 4].includes(weekdayOf(addDays(today0, d)))) {
        busiest = addDays(today0, d);
        break;
      }
    const day = await classes.day(w.owner, busiest);
    const dayMs = Date.now() - t;
    expect(day.classes.length).toBe(100);
    const counts = [...new Set(day.classes.map((c) => c.counts.expected))];
    expect(counts).toEqual([40]);
    const oneClass = day.classes[0].id;
    t = Date.now();
    await classes.roster(w.owner, oneClass);
    const rosterMs = Date.now() - t;
    console.log(
      `[c2-perf] generate ${created} classes ${firstMs}ms; idempotent re-run ${againMs}ms; day of 100 classes ${dayMs}ms; roster of 40 ${rosterMs}ms`,
    );
    expect(firstMs).toBeLessThan(60_000);
    expect(dayMs).toBeLessThan(3_000);
    expect(rosterMs).toBeLessThan(1_500);
  }, 180_000);
});

describe('C2 — a teacher reaches their classes from any workspace', () => {
  it('my-day: every academy where they take attendance and classes are on — assigned groups only', async () => {
    if (!guard()) return;
    const w = await world();
    const ctl = new ClassOpsController(schedule, classes, flags, academy, prisma);
    // A second center where t1 also teaches (classes on), and a third where classes are off.
    const k = randomUUID().slice(0, 6);
    const mk = async (tag: string, on: boolean) => {
      const acad = await prisma.academy.create({
        data: {
          slug: `c2-x-${tag}-${k}`,
          name: `X ${tag}`,
          ownerUserId: w.A.ownerId,
          kind: 'CENTER',
        },
      });
      await prisma.academyMembership.create({
        data: { userId: w.t1, academyId: acad.id, role: 'TEACHER', status: 'ACTIVE' },
      });
      if (on) await flags.setFlag(acad.id, 'classOperations', true, w.A.ownerId);
      const g = await prisma.group.create({ data: { academyId: acad.id, name: `G ${tag}` } });
      await prisma.groupAssignment.create({
        data: { groupId: g.id, userId: w.t1, role: 'TEACHER', academyId: acad.id },
      });
      const startAt = new Date(Date.now() - 10 * MIN);
      await prisma.groupSession.create({
        data: {
          academyId: acad.id,
          groupId: g.id,
          startAt,
          endAt: new Date(startAt.getTime() + 20 * MIN),
          locationType: 'CENTER',
          createdBy: w.A.ownerId,
        },
      });
      return acad.id;
    };
    const on = await mk('on', true);
    const off = await mk('off', false);
    // In center A: a class of t1's group and one of a group not theirs.
    const now = wallClock(new Date(), CAIRO).minute;
    const offset = now > 23 * 60 ? -30 : now < 60 ? 5 : -30;
    await classAt(w, w.A.gA.id, offset, 20);
    await classAt(w, w.A.gB.id, offset, 20);
    const user = jwt(w.t1, Role.TEACHER);
    const day = await ctl.myDay(user, {});
    const byAcademy = new Map(day.academies.map((a) => [a.academy.id, a.classes]));
    expect([...byAcademy.keys()].sort()).toEqual([w.A.acad.id, on].sort());
    expect(byAcademy.get(w.A.acad.id)!.map((c) => c.group.id)).toEqual([w.A.gA.id]);
    expect(byAcademy.get(on)!.length).toBe(1);
    expect(byAcademy.has(off)).toBe(false);
    const accessT = await ctl.myAccess(user);
    expect(accessT.enabled).toBe(true);
    // Reception holds no attendance.mark anywhere: nothing.
    const accessR = await ctl.myAccess(jwt(w.receptionId, Role.STAFF));
    expect(accessR).toEqual({ enabled: false, academies: [] });
  });
});

describe('C2 — transfer vs withdrawal, deterministically', () => {
  it('a transfer waits on the register row a withdrawal holds, then refuses — never reopens a stint', async () => {
    if (!guard()) return;
    const w = await world();
    const reg = await register.register(w.owner, {
      requestKey: uniq(),
      fullName: 'حتمي الترتيب',
    });
    const sid = reg.student.studentId;
    await prisma.groupMembership.create({
      data: {
        groupId: w.A.gA.id,
        studentId: sid,
        academyId: w.A.acad.id,
        addedAt: new Date(Date.now() - 60_000),
      },
    });
    // The withdrawal, exactly as the desk runs it, held open at a gate we control.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const holding = new Promise<void>((r) => (locked = r));
    const withdrawal = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "AcademyStudent" WHERE id = ${reg.student.id} FOR UPDATE`;
        await tx.academyStudent.update({
          where: { id: reg.student.id },
          data: { status: 'WITHDRAWN', leftAt: new Date() },
        });
        await groups.endMemberships(tx, w.A.acad.id, sid);
        locked();
        await gate;
      },
      { timeout: 20_000 },
    );
    await holding;
    let settled = false;
    const transfer = groups
      .transfer(w.owner, w.A.gA.id, sid, w.A.gB.id)
      .then(
        () => 'MOVED',
        (e) => codeOf(e),
      )
      .finally(() => (settled = true));
    await new Promise((r) => setTimeout(r, 1500));
    // Blocked on the register row the withdrawal holds.
    expect(settled).toBe(false);
    release();
    await withdrawal;
    // Refused either way: the stint the withdrawal ended is gone, or the learner is withdrawn.
    expect(['MEMBERSHIP_NOT_FOUND', 'STUDENT_WITHDRAWN']).toContain(await transfer);
    expect(await prisma.groupMembership.count({ where: { studentId: sid, deletedAt: null } })).toBe(
      0,
    );
  });
});
