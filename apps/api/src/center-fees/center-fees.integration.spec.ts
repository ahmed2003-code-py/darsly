import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'crypto';
import { JwtPayload, Role } from '@darsly/shared-types';
import { AcademyContext } from '../academy/academy-context';
import { AcademyService } from '../academy/academy.service';
import { AcademyMembershipGuard } from '../academy/guards/academy-membership.guard';
import { PermissionGuard } from '../academy/guards/permission.guard';
import { AcademyOpsAccessService } from '../academy-ops/academy-ops-access.service';
import { AuditService } from '../audit/audit.service';
import { generateStudentCode } from '../center-students/student-code';
import { ClassAttendanceService } from '../class-ops/class-attendance.service';
import { ClassScheduleService } from '../class-ops/class-schedule.service';
import { databaseReady } from '../common/testing/db-available';
import { VALIDATION_PIPE_OPTIONS } from '../common/errors/validation-exception.factory';
import { FeatureFlagGuard } from '../feature-flags/guards/feature-flag.guard';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { PrismaService } from '../prisma/prisma.service';
import { CenterFeesController } from './center-fees.controller';
import { CenterFeesService } from './center-fees.service';
import { CollectDto } from './dto';
import { FeePlansService } from './fee-plans.service';

/**
 * Center Operations C4 against a real PostgreSQL. The balance view, the
 * append-only and money triggers (checked at commit), the unique indexes and
 * the learner row lock are part of what is under test; every race is two
 * real transactions on two real connections.
 *
 * Generation is tested on FIXED past months with explicit membership times
 * (generatePlan's `today`), so it never depends on what day the suite runs.
 * Live flows use a centre in a fixed-offset zone where it is about noon now.
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
const plans = new FeePlansService(prisma, schedule, audit);
const fees = new CenterFeesService(prisma, schedule, audit);

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
const platformHash = async () => {
  const out: Record<string, unknown> = {};
  for (const t of PLATFORM)
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
  ready = await databaseReady(prisma, ['centerCharge', 'centerCollection', 'academyStudent']);
  if (ready) platformBefore = await platformHash();
});
afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
});
const guard = () => ready;

const jwt = (sub: string, role: Role) => ({ sub, role, sessionId: 's' }) as JwtPayload;
const ctxOf = async (userId: string, role: Role, academyId: string): Promise<AcademyContext> =>
  (await academy.buildContext(userId, academyId, role))!;
const key = () => randomUUID().replace(/-/g, '');
const EGP = (n: number) => Math.round(n * 100);

function middayZone() {
  const off = ((12 - new Date().getUTCHours() + 36) % 24) - 12;
  return off === 0 ? 'Etc/UTC' : `Etc/GMT${off > 0 ? '-' : '+'}${Math.abs(off)}`;
}

async function makeCenter(k: string, tag: string) {
  const owner = await prisma.user.create({
    data: { role: 'STAFF', fullName: `Owner ${tag} ${k}`, email: `c4-${tag}-o-${k}@it.test` },
  });
  const acad = await prisma.academy.create({
    data: {
      slug: `c4-${tag}-${k}`,
      name: `C4 ${tag} ${k}`,
      ownerUserId: owner.id,
      kind: 'CENTER',
      timezone: middayZone(),
    },
  });
  await prisma.academyMembership.create({
    data: { userId: owner.id, academyId: acad.id, role: 'OWNER', status: 'ACTIVE' },
  });
  for (const f of ['studentRegistry', 'classOperations', 'receptionDesk', 'centerFees'] as const)
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
      data: { role: 'STAFF', fullName: `${tag} ${k}`, email: `c4-${tag}-${k}@it.test` },
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
  const receptionId = await staff('r', [
    'student.view',
    'student.directory',
    'student.register',
    'desk.checkin',
    'card.manage',
    'fees.view',
    'fees.collect',
  ]);
  const reception2Id = await staff('r2', [
    'student.view',
    'student.directory',
    'student.register',
    'desk.checkin',
    'card.manage',
    'fees.view',
    'fees.collect',
  ]);
  const deskOnlyId = await staff('d', [
    'student.view',
    'student.directory',
    'student.register',
    'desk.checkin',
    'card.manage',
  ]);
  const t = await prisma.user.create({
    data: { role: 'TEACHER', fullName: `T ${k}`, email: `c4-t-${k}@it.test` },
  });
  await prisma.teacherProfile.create({
    data: { userId: t.id, slug: `c4-t-${k}`, status: 'APPROVED' },
  });
  await prisma.academyMembership.create({
    data: { userId: t.id, academyId: A.acad.id, role: 'TEACHER', status: 'ACTIVE' },
  });
  await prisma.groupAssignment.create({
    data: { groupId: A.gA.id, userId: t.id, role: 'TEACHER', academyId: A.acad.id },
  });
  return {
    k,
    A,
    B,
    teacherId: t.id,
    receptionId,
    deskOnlyId,
    owner: await ctxOf(A.ownerId, Role.STAFF, A.acad.id),
    ownerB: await ctxOf(B.ownerId, Role.STAFF, B.acad.id),
    reception: await ctxOf(receptionId, Role.STAFF, A.acad.id),
    reception2: await ctxOf(reception2Id, Role.STAFF, A.acad.id),
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
  return { id: rec.id, studentId: sp.id, code: rec.code, name };
}
const stint = (
  academyId: string,
  groupId: string,
  studentId: string,
  addedAt: Date,
  deletedAt: Date | null = null,
) => prisma.groupMembership.create({ data: { academyId, groupId, studentId, addedAt, deletedAt } });

/** A plan written as if made long ago (the API refuses a past start on purpose). */
const oldPlan = (
  w: World,
  groupId: string,
  type: 'MONTHLY' | 'PER_SESSION',
  amountCents: number,
  startsOn = '2025-06-01',
) =>
  prisma.centerFeePlan.create({
    data: {
      academyId: w.A.acad.id,
      groupId,
      name: type === 'MONTHLY' ? 'شهري' : 'بالحصة',
      type,
      amountCents,
      currency: 'EGP',
      dueDay: type === 'MONTHLY' ? 5 : null,
      startsOn: new Date(`${startsOn}T00:00:00Z`),
      createdBy: w.A.ownerId,
    },
  });

/** A learner who owes `amounts` as one-time charges, due in that order. */
async function owing(w: World, amounts: number[], name = 'مدين') {
  const s = await student(w.A.acad.id, name);
  for (const [i, a] of amounts.entries())
    await fees.oneTime(w.owner, s.id, {
      requestKey: key(),
      description: `بند ${i + 1}`,
      amountCents: a,
      dueOn: `2026-0${i + 1}-10`,
    });
  return s;
}

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return (e as { response?: { code?: string } })?.response?.code ?? (e as Error)?.message;
  }
  return 'NO_ERROR';
}
const collect = (
  ctx: AcademyContext,
  id: string,
  amountCents: number,
  extra: Partial<CollectDto> = {},
) => fees.collect(ctx, id, { requestKey: key(), amountCents, method: 'CASH', ...extra });
const owed = async (w: World, id: string) => (await fees.summary(w.owner, id)).outstandingCents;

// ───────────────────────────────────────────────────────────────────────────
describe('C4 — the database guards the money', () => {
  it('history cannot be deleted or rewritten; a reversal is once and for good', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await owing(w, [EGP(500)]);
    const { receipt } = await collect(w.reception, s.id, EGP(200));
    const charge = await prisma.centerCharge.findFirstOrThrow({
      where: { academyStudentId: s.id },
    });
    for (const sql of [
      `DELETE FROM "CenterCharge" WHERE id = '${charge.id}'`,
      `DELETE FROM "CenterCollection" WHERE id = '${receipt.collectionId}'`,
      `DELETE FROM "CenterAllocation" WHERE "collectionId" = '${receipt.collectionId}'`,
    ])
      await expect(prisma.$executeRawUnsafe(sql)).rejects.toThrow(/never deleted/);
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "CenterCharge" SET "amountCents" = 1 WHERE id = '${charge.id}'`,
      ),
    ).rejects.toThrow(/never rewritten/);
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "CenterCollection" SET "amountCents" = 1 WHERE id = '${receipt.collectionId}'`,
      ),
    ).rejects.toThrow(/never rewritten/);
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "CenterCollection" SET "receiptNumber" = '2026-999999' WHERE id = '${receipt.collectionId}'`,
      ),
    ).rejects.toThrow(/never rewritten/);
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "CenterAllocation" SET "amountCents" = 1 WHERE "collectionId" = '${receipt.collectionId}'`,
      ),
    ).rejects.toThrow(/never edited/);
    await fees.reverse(w.owner, receipt.collectionId, 'خطأ في التسجيل');
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "CenterCollection" SET "reversedAt" = NULL, "reversedBy" = NULL, "reversalReason" = NULL WHERE id = '${receipt.collectionId}'`,
      ),
    ).rejects.toThrow(/reversed for good/);
  });

  it('at commit: no money without allocation, no over-allocation, no balance below what was paid', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await owing(w, [EGP(100)]);
    const charge = await prisma.centerCharge.findFirstOrThrow({
      where: { academyStudentId: s.id },
    });
    const coll = (id: string, amount: number, no: string) =>
      Promise.resolve(
        prisma.$executeRawUnsafe(
          `INSERT INTO "CenterCollection"(id,"academyId","academyStudentId","amountCents",currency,method,"receivedBy","receiptNumber","balanceAfterCents","requestKey")
           VALUES ('${id}','${w.A.acad.id}','${s.id}',${amount},'EGP','CASH','${w.A.ownerId}','${no}',0,'${key()}')`,
        ),
      );
    // A collection with no allocation never commits.
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT 1`);
        void tx;
        await coll(randomUUID(), 5000, '2026-900001');
      }),
    ).rejects.toThrow(/not fully allocated/);
    // Over-allocating a charge never commits.
    await expect(
      prisma.$transaction([
        prisma.$executeRawUnsafe(
          `INSERT INTO "CenterCollection"(id,"academyId","academyStudentId","amountCents",currency,method,"receivedBy","receiptNumber","balanceAfterCents","requestKey")
           VALUES ('k1-${w.k}','${w.A.acad.id}','${s.id}',20000,'EGP','CASH','${w.A.ownerId}','2026-900002',0,'${key()}')`,
        ),
        prisma.$executeRawUnsafe(
          `INSERT INTO "CenterAllocation"(id,"academyId","collectionId","chargeId","amountCents") VALUES ('${randomUUID()}','${w.A.acad.id}','k1-${w.k}','${charge.id}',20000)`,
        ),
      ]),
    ).rejects.toThrow(/over-paid/);
    // A discount below what was paid never commits.
    await collect(w.owner, s.id, EGP(60));
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "CenterAdjustment"(id,"academyId","chargeId",kind,"deltaCents",reason,"createdBy","requestKey") VALUES ('${randomUUID()}','${w.A.acad.id}','${charge.id}','DISCOUNT',-5000,'x','${w.A.ownerId}','${key()}')`,
      ),
    ).rejects.toThrow(/less than was paid/);
    // A charge in another academy's name, or a collection for another academy's learner, never commits.
    const other = await student(w.B.acad.id, 'غريب');
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "CenterCharge"(id,"academyId","academyStudentId",kind,description,"amountCents",currency,"dueOn","requestKey") VALUES ('${randomUUID()}','${w.A.acad.id}','${other.id}','ONE_TIME','x',100,'EGP','2026-01-01','${key()}')`,
      ),
    ).rejects.toThrow(/crosses academies/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C4 — plans and the charges they post', () => {
  it('a plan cannot start in the past: turning fees on never back-charges', async () => {
    if (!guard()) return;
    const w = await world();
    expect(
      await refusal(
        plans.create(w.owner, {
          name: 'x',
          groupId: w.A.gA.id,
          type: 'MONTHLY',
          amountCents: EGP(500),
          startsOn: '2020-01-01',
        }),
      ),
    ).toBe('PLAN_START_IN_PAST');
    // A plan starting today posts this month for whoever is in the group today — and nothing before.
    const s = await student(w.A.acad.id, 'اليوم');
    await stint(w.A.acad.id, w.A.gA.id, s.studentId, new Date(Date.now() - 400 * 86_400_000));
    const p = await plans.create(w.owner, {
      name: 'شهري',
      groupId: w.A.gA.id,
      type: 'MONTHLY',
      amountCents: EGP(500),
    });
    expect(p.posted).toBe(1);
    const charges = await prisma.centerCharge.findMany({ where: { academyStudentId: s.id } });
    expect(charges).toHaveLength(1);
    const today = (await schedule.academyClock(w.A.acad.id)).today;
    expect(charges[0].period).toBe(today.slice(0, 7));
    // Due on the 1st by default, but never before the plan's first day: today.
    expect(charges[0].dueOn.toISOString().slice(0, 10)).toBe(today);
    expect(await plans.generate(w.owner, p.id)).toEqual({ posted: 0 });
  });

  it('monthly: anchor-day members, full month, idempotent, price change only forward', async () => {
    if (!guard()) return;
    const w = await world();
    const plan = await oldPlan(w, w.A.gA.id, 'MONTHLY', EGP(500));
    const T = (iso: string) => new Date(iso);
    const onFirst = await student(w.A.acad.id, 'من الأول');
    await stint(w.A.acad.id, w.A.gA.id, onFirst.studentId, T('2025-12-20T10:00:00Z'));
    const lateJoin = await student(w.A.acad.id, 'دخل متأخر');
    await stint(w.A.acad.id, w.A.gA.id, lateJoin.studentId, T('2026-01-12T10:00:00Z'));
    const goneBefore = await student(w.A.acad.id, 'مشي قبل', {
      status: 'WITHDRAWN',
      leftAt: T('2025-12-28T10:00:00Z'),
    });
    await stint(w.A.acad.id, w.A.gA.id, goneBefore.studentId, T('2025-11-01T10:00:00Z'));
    const posted = await Promise.all([
      plans.generatePlan(plan, { today: '2026-01-15' }),
      plans.generatePlan(plan, { today: '2026-01-15' }),
    ]);
    expect(posted.reduce((a, b) => a + b, 0)).toBe(1); // two generators at once: one charge
    expect(await plans.generatePlan(plan, { today: '2026-01-20' })).toBe(0);
    const jan = await prisma.centerCharge.findMany({ where: { planId: plan.id } });
    expect(jan.map((c) => c.academyStudentId)).toEqual([onFirst.id]);
    expect(jan[0]).toMatchObject({ period: '2026-01', amountCents: EGP(500), kind: 'MONTHLY' });
    expect(jan[0].dueOn.toISOString().slice(0, 10)).toBe('2026-01-05');
    // The price changes: January stays 500, February is 600.
    await prisma.centerFeePlan.update({ where: { id: plan.id }, data: { amountCents: EGP(600) } });
    const p2 = await prisma.centerFeePlan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(await plans.generatePlan(p2, { today: '2026-02-02' })).toBe(2); // onFirst + lateJoin
    const all = await prisma.centerCharge.findMany({
      where: { planId: plan.id },
      orderBy: { period: 'asc' },
    });
    expect(all.filter((c) => c.period === '2026-01').map((c) => c.amountCents)).toEqual([EGP(500)]);
    expect(all.filter((c) => c.period === '2026-02').map((c) => c.amountCents)).toEqual([
      EGP(600),
      EGP(600),
    ]);
    expect(all.some((c) => c.academyStudentId === goneBefore.id)).toBe(false);
  });

  it('transfer mid-month: old group keeps the month, new group from next month; withdrawal stops it, debt stays', async () => {
    if (!guard()) return;
    const w = await world();
    const pA = await oldPlan(w, w.A.gA.id, 'MONTHLY', EGP(500));
    const pB = await oldPlan(w, w.A.gB.id, 'MONTHLY', EGP(450));
    const s = await student(w.A.acad.id, 'منقول');
    const moved = new Date('2026-03-14T09:00:00Z');
    await stint(w.A.acad.id, w.A.gA.id, s.studentId, new Date('2026-01-01T08:00:00Z'), moved);
    await stint(w.A.acad.id, w.A.gB.id, s.studentId, moved);
    for (const p of [pA, pB]) await plans.generatePlan(p, { today: '2026-03-20' });
    for (const p of [pA, pB]) await plans.generatePlan(p, { today: '2026-04-03' });
    const got = await prisma.centerCharge.findMany({
      where: { academyStudentId: s.id },
      orderBy: { period: 'asc' },
    });
    expect(got.map((c) => [c.period, c.planId === pA.id ? 'A' : 'B', c.amountCents])).toEqual([
      ['2026-03', 'A', EGP(500)],
      ['2026-04', 'B', EGP(450)],
    ]);
    // Withdrawn on 20 April: May is not charged, March/April stay owed.
    await prisma.academyStudent.update({
      where: { id: s.id },
      data: { status: 'WITHDRAWN', leftAt: new Date('2026-04-20T10:00:00Z') },
    });
    expect(await plans.generatePlan(pB, { today: '2026-05-02' })).toBe(0);
    expect(await owed(w, s.id)).toBe(EGP(950));
  });

  // Found in production acceptance on 1 October: a transfer made ON the 1st left
  // the learner in both groups "at some moment of the anchor day", so both
  // groups charged October.
  it('transfer ON the anchor day: still one month, in the old group — whichever plan posts first', async () => {
    if (!guard()) return;
    for (const order of ['old-first', 'new-first'] as const) {
      const w = await world();
      const pA = await oldPlan(w, w.A.gA.id, 'MONTHLY', EGP(500));
      const pB = await oldPlan(w, w.A.gB.id, 'MONTHLY', EGP(450));
      const moved = new Date('2026-03-01T09:00:00Z'); // 11:00 in Cairo on the 1st
      const s = await student(w.A.acad.id, `منقول يوم 1 (${order})`);
      await stint(w.A.acad.id, w.A.gA.id, s.studentId, new Date('2026-01-01T08:00:00Z'), moved);
      await stint(w.A.acad.id, w.A.gB.id, s.studentId, moved);
      // Still charged by a new group: someone brand new on the 1st, and someone
      // who adds a second subject on the 1st without leaving the first.
      const fresh = await student(w.A.acad.id, `جديد يوم 1 (${order})`);
      await stint(w.A.acad.id, w.A.gB.id, fresh.studentId, moved);
      const both = await student(w.A.acad.id, `مادتين (${order})`);
      await stint(w.A.acad.id, w.A.gA.id, both.studentId, new Date('2026-01-01T08:00:00Z'));
      await stint(w.A.acad.id, w.A.gB.id, both.studentId, moved);
      // The production case: registered into A on the 1st, moved to B the same day.
      const sameDay = await student(w.A.acad.id, `سجّل واتنقل يوم 1 (${order})`);
      await stint(
        w.A.acad.id,
        w.A.gA.id,
        sameDay.studentId,
        new Date('2026-03-01T07:00:00Z'),
        moved,
      );
      await stint(w.A.acad.id, w.A.gB.id, sameDay.studentId, moved);
      const plansInOrder = order === 'old-first' ? [pA, pB] : [pB, pA];
      for (const p of plansInOrder) await plans.generatePlan(p, { today: '2026-03-01' });
      for (const p of plansInOrder) await plans.generatePlan(p, { today: '2026-04-02' });
      const of = async (id: string) =>
        (
          await prisma.centerCharge.findMany({
            where: { academyStudentId: id },
            orderBy: [{ period: 'asc' }, { amountCents: 'desc' }],
          })
        ).map((c) => [c.period, c.planId === pA.id ? 'A' : 'B']);
      expect(await of(s.id)).toEqual([
        ['2026-03', 'A'],
        ['2026-04', 'B'],
      ]);
      expect(await of(sameDay.id)).toEqual([
        ['2026-03', 'A'],
        ['2026-04', 'B'],
      ]);
      expect(await of(fresh.id)).toEqual([
        ['2026-03', 'B'],
        ['2026-04', 'B'],
      ]);
      expect(await of(both.id)).toEqual([
        ['2026-03', 'A'],
        ['2026-03', 'B'],
        ['2026-04', 'A'],
        ['2026-04', 'B'],
      ]);
    }
  });

  it('changing a plan through the screen leaves posted charges exactly as they were', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await student(w.A.acad.id, 'قبل التغيير');
    await stint(w.A.acad.id, w.A.gA.id, s.studentId, new Date(Date.now() - 400 * 86_400_000));
    const p = await plans.create(w.owner, {
      name: 'شهري',
      groupId: w.A.gA.id,
      type: 'MONTHLY',
      amountCents: EGP(500),
    });
    const posted = await prisma.centerCharge.findFirstOrThrow({ where: { planId: p.id } });
    const updated = await plans.update(w.owner, p.id, { amountCents: EGP(600) });
    expect(updated.amountCents).toBe(EGP(600));
    expect(await prisma.centerCharge.findUniqueOrThrow({ where: { id: posted.id } })).toEqual(
      posted,
    );
    expect(await owed(w, s.id)).toBe(EGP(500));
  });

  it("'add this month's fee' for a learner who joined after the 1st: posted on purpose, once", async () => {
    if (!guard()) return;
    const w = await world();
    const p = await plans.create(w.owner, {
      name: 'شهري',
      groupId: w.A.gA.id,
      type: 'MONTHLY',
      amountCents: EGP(500),
    });
    const s = await student(w.A.acad.id, 'جديد');
    expect(await refusal(plans.monthlyForStudent(w.owner, s.id, p.id))).toBe('NOT_IN_GROUP');
    await stint(w.A.acad.id, w.A.gA.id, s.studentId, new Date());
    const twice = await Promise.all([
      plans.monthlyForStudent(w.owner, s.id, p.id),
      plans.monthlyForStudent(w.owner, s.id, p.id),
    ]);
    expect(twice.map((t) => t.posted).sort()).toEqual([0, 1]);
    expect(await owed(w, s.id)).toBe(EGP(500));
  });

  it('per class: only classes attended in the group, from the plan start; repeat posts nothing', async () => {
    if (!guard()) return;
    const w = await world();
    const startsOn = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10);
    const plan = await oldPlan(w, w.A.gA.id, 'PER_SESSION', EGP(75), startsOn);
    const people = await Promise.all(
      ['حاضر', 'متأخر', 'غايب', 'بعذر'].map((n) => student(w.A.acad.id, n)),
    );
    for (const s of people)
      await stint(w.A.acad.id, w.A.gA.id, s.studentId, new Date(Date.now() - 30 * 86_400_000));
    const guest = await student(w.A.acad.id, 'تعويض');
    await stint(w.A.acad.id, w.A.gB.id, guest.studentId, new Date(Date.now() - 30 * 86_400_000));
    const mk = async (daysAgo: number, status: 'SCHEDULED' | 'CANCELLED' = 'SCHEDULED') => {
      const startAt = new Date(Date.now() - daysAgo * 86_400_000);
      return prisma.groupSession.create({
        data: {
          academyId: w.A.acad.id,
          groupId: w.A.gA.id,
          startAt,
          endAt: new Date(startAt.getTime() + 3_600_000),
          locationType: 'CENTER',
          createdBy: w.A.ownerId,
          status,
        },
      });
    };
    const sheet = async (
      gs: { id: string; startAt: Date },
      marks: [string, 'PRESENT' | 'LATE' | 'ABSENT' | 'EXCUSED', string?][],
    ) => {
      const sh = await prisma.attendanceSession.create({
        data: {
          groupSessionId: gs.id,
          groupId: w.A.gA.id,
          academyId: w.A.acad.id,
          date: new Date(gs.startAt.toISOString().slice(0, 10) + 'T00:00:00Z'),
          createdBy: w.A.ownerId,
        },
      });
      for (const [sid, status, home] of marks)
        await prisma.attendanceRecord.create({
          data: {
            sessionId: sh.id,
            studentId: sid,
            status,
            academyId: w.A.acad.id,
            markedBy: w.A.ownerId,
            homeGroupId: home ?? null,
            checkedInAt: status === 'PRESENT' || status === 'LATE' ? gs.startAt : null,
          },
        });
    };
    const c1 = await mk(3);
    await sheet(c1, [
      [people[0].studentId, 'PRESENT'],
      [people[1].studentId, 'LATE'],
      [people[2].studentId, 'ABSENT'],
      [people[3].studentId, 'EXCUSED'],
      [guest.studentId, 'PRESENT', w.A.gB.id],
    ]);
    const before = await mk(40); // before the plan started
    await sheet(before, [[people[0].studentId, 'PRESENT']]);
    const cancelled = await mk(2, 'CANCELLED');
    await sheet(cancelled, [[people[0].studentId, 'PRESENT']]);
    expect(await plans.generatePlan(plan)).toBe(2);
    expect(await plans.generatePlan(plan)).toBe(0);
    const posted = await prisma.centerCharge.findMany({ where: { planId: plan.id } });
    expect(posted.map((c) => c.academyStudentId).sort()).toEqual(
      [people[0].id, people[1].id].sort(),
    );
    expect(posted.every((c) => c.groupSessionId === c1.id && c.amountCents === EGP(75))).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C4 — collecting, receipts, corrections', () => {
  it('600 owed → 200, 300, 100: receipts in order, exact balances, then nothing owed', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await owing(w, [EGP(500), EGP(100)]);
    expect(await owed(w, s.id)).toBe(EGP(600));
    const r1 = (await collect(w.reception, s.id, EGP(200))).receipt;
    const r2 = (await collect(w.reception, s.id, EGP(300))).receipt;
    const r3 = (await collect(w.reception, s.id, EGP(100))).receipt;
    const year = new Date().getUTCFullYear();
    expect([r1, r2, r3].map((r) => r.receiptNumber)).toEqual(
      [1, 2, 3]
        .map((n) => `${year}-${String(n).padStart(6, '0')}`)
        .map((x, i) => x.replace(/^\d{4}/, [r1, r2, r3][i].receiptNumber.slice(0, 4))),
    );
    expect([r1, r2, r3].map((r) => r.balanceAfterCents)).toEqual([EGP(400), EGP(100), 0]);
    expect(r1.lines).toEqual([
      { description: 'بند 1', period: null, kind: 'ONE_TIME', amountCents: EGP(200) },
    ]);
    expect(r2.lines.map((l) => l.amountCents)).toEqual([EGP(300)]);
    expect(r3.lines.map((l) => [l.description, l.amountCents])).toEqual([['بند 2', EGP(100)]]);
    expect(r1.collector).toContain('r ');
    expect(Object.keys(r1)).not.toContain('studentPhone');
    expect(await owed(w, s.id)).toBe(0);
    expect(await refusal(collect(w.reception, s.id, EGP(1)))).toBe('NOTHING_OWED');
  });

  it('one payment across several charges, oldest first, shown before it is taken; never more than owed', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await owing(w, [EGP(300), EGP(100), EGP(300)]);
    const pv = await fees.preview(w.reception, s.id, { amountCents: EGP(400) });
    expect(pv.allocations.map((a) => [a.description, a.amountCents])).toEqual([
      ['بند 1', EGP(300)],
      ['بند 2', EGP(100)],
    ]);
    expect(pv.balanceAfterCents).toBe(EGP(300));
    expect(await prisma.centerCollection.count({ where: { academyStudentId: s.id } })).toBe(0);
    expect(await refusal(collect(w.reception, s.id, EGP(701)))).toBe('AMOUNT_EXCEEDS_BALANCE');
    const charges = await prisma.centerCharge.findMany({
      where: { academyStudentId: s.id },
      orderBy: { dueOn: 'asc' },
    });
    // Named allocations: must add up, each within what it owes, own charges only.
    expect(
      await refusal(
        collect(w.reception, s.id, EGP(150), {
          allocations: [{ chargeId: charges[2].id, amountCents: EGP(100) }],
        }),
      ),
    ).toBe('ALLOCATION_MISMATCH');
    expect(
      await refusal(
        collect(w.reception, s.id, EGP(150), {
          allocations: [{ chargeId: charges[1].id, amountCents: EGP(150) }],
        }),
      ),
    ).toBe('AMOUNT_EXCEEDS_BALANCE');
    const other = await owing(w, [EGP(50)], 'آخر');
    const foreign = await prisma.centerCharge.findFirstOrThrow({
      where: { academyStudentId: other.id },
    });
    expect(
      await refusal(
        collect(w.reception, s.id, EGP(50), {
          allocations: [{ chargeId: foreign.id, amountCents: EGP(50) }],
        }),
      ),
    ).toBe('ALLOCATION_INVALID');
    const named = await collect(w.reception, s.id, EGP(350), {
      allocations: [
        { chargeId: charges[2].id, amountCents: EGP(300) },
        { chargeId: charges[1].id, amountCents: EGP(50) },
      ],
    });
    expect(named.receipt.lines.map((l) => [l.description, l.amountCents]).sort()).toEqual([
      ['بند 2', EGP(50)],
      ['بند 3', EGP(300)],
    ]);
    expect(await owed(w, s.id)).toBe(EGP(350));
  });

  it('money units: 0.01, 0.10, 99.99 and large amounts are exact', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await owing(w, [1, 10, 9_999, 100_000_000]);
    for (const a of [1, 10, 9_999]) await collect(w.reception, s.id, a);
    expect(await owed(w, s.id)).toBe(100_000_000);
    await collect(w.reception, s.id, 99_999_999);
    expect(await owed(w, s.id)).toBe(1);
  });

  it('idempotency: retry and double click give one collection; a reused key for something else is refused', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await owing(w, [EGP(500)]);
    const k1 = key();
    const shots = await Promise.all(
      [1, 2, 3].map(() =>
        fees.collect(w.reception, s.id, { requestKey: k1, amountCents: EGP(200), method: 'CASH' }),
      ),
    );
    expect(new Set(shots.map((x) => x.receipt.receiptNumber)).size).toBe(1);
    expect(shots.filter((x) => !x.replayed)).toHaveLength(1);
    expect(await prisma.centerCollection.count({ where: { academyStudentId: s.id } })).toBe(1);
    expect(
      await prisma.centerAllocation.count({ where: { charge: { academyStudentId: s.id } } }),
    ).toBe(1);
    expect(
      await refusal(
        fees.collect(w.reception, s.id, { requestKey: k1, amountCents: EGP(250), method: 'CASH' }),
      ),
    ).toBe('IDEMPOTENCY_KEY_REUSED');
    const log = await prisma.auditLog.findMany({
      where: { academyId: w.A.acad.id, action: 'fees.collect' },
    });
    expect(log).toHaveLength(1);
  });

  it('two receptionists take the last 200 at once: one receipt, never 400', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await owing(w, [EGP(200)]);
    const out = await Promise.allSettled([
      collect(w.reception, s.id, EGP(200)),
      collect(w.reception2, s.id, EGP(200)),
    ]);
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const why = (out.find((o) => o.status === 'rejected') as PromiseRejectedResult).reason.response
      .code;
    expect(['NOTHING_OWED', 'AMOUNT_EXCEEDS_BALANCE']).toContain(why);
    const [{ paid }] = await prisma.$queryRaw<{ paid: number }[]>`
      SELECT sum("paidCents")::int paid FROM "CenterChargeBalance" WHERE "academyStudentId" = ${s.id}`;
    expect(paid).toBe(EGP(200));
  });

  it('receipt numbers under a race: unique, consecutive, per academy', async () => {
    if (!guard()) return;
    const w = await world();
    const people = await Promise.all(
      Array.from({ length: 12 }, (_, i) => owing(w, [EGP(10)], `ر${i}`)),
    );
    const rs = await Promise.all(
      people.map((s, i) => collect(i % 2 ? w.reception : w.reception2, s.id, EGP(10))),
    );
    const nums = rs.map((r) => Number(r.receipt.receiptNumber.split('-')[1])).sort((a, b) => a - b);
    expect(nums).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    // Another academy counts on its own.
    const other = await student(w.B.acad.id, 'ب');
    await fees.oneTime(w.ownerB, other.id, {
      requestKey: key(),
      description: 'x',
      amountCents: 100,
      dueOn: '2026-01-01',
    });
    expect((await collect(w.ownerB, other.id, 100)).receipt.receiptNumber).toMatch(/-000001$/);
  });

  it('reversal: kept with its receipt, balance restored, once; collection vs reversal race stays consistent', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await owing(w, [EGP(500)]);
    const { receipt } = await collect(w.reception, s.id, EGP(200));
    const [a, b] = await Promise.all([
      fees.reverse(w.owner, receipt.collectionId, 'سجلت بالغلط'),
      fees.reverse(w.owner, receipt.collectionId, 'سجلت بالغلط'),
    ]);
    expect([a.changed, b.changed].sort()).toEqual([false, true]);
    expect(a.receipt.reversed?.reason).toBe('سجلت بالغلط');
    expect(a.receipt.receiptNumber).toBe(receipt.receiptNumber);
    expect(await owed(w, s.id)).toBe(EGP(500));
    const race = await Promise.allSettled([
      collect(w.reception, s.id, EGP(500)),
      fees.reverse(w.owner, receipt.collectionId, 'مرة كمان'),
    ]);
    expect(race[0].status).toBe('fulfilled');
    expect(await owed(w, s.id)).toBe(0);
    const st = await fees.statement(w.owner, s.id);
    expect(st.events.map((e) => e.kind)).toEqual([
      'CHARGE',
      'COLLECTION',
      'REVERSAL',
      'COLLECTION',
    ]);
    expect(st.events.at(-1)!.balanceCents).toBe(0);
  });

  it('discount (amount or %), correction, void — with reasons, never below what was paid', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await owing(w, [EGP(500), EGP(100)]);
    const [c1, c2] = await prisma.centerCharge.findMany({
      where: { academyStudentId: s.id },
      orderBy: { dueOn: 'asc' },
    });
    await fees.adjust(w.owner, c1.id, {
      requestKey: key(),
      kind: 'DISCOUNT',
      percentBps: 1_000,
      reason: 'خصم إخوات',
    });
    expect(await owed(w, s.id)).toBe(EGP(550));
    await fees.adjust(w.owner, c1.id, {
      requestKey: key(),
      kind: 'CORRECTION',
      amountCents: EGP(25),
      direction: 'INCREASE',
      reason: 'تصحيح',
    });
    expect(await owed(w, s.id)).toBe(EGP(575));
    await collect(w.reception, s.id, EGP(400), {
      allocations: [{ chargeId: c1.id, amountCents: EGP(400) }],
    });
    expect(
      await refusal(
        fees.adjust(w.owner, c1.id, {
          requestKey: key(),
          kind: 'DISCOUNT',
          amountCents: EGP(100),
          reason: 'كبير',
        }),
      ),
    ).toBe('ADJUSTMENT_BELOW_PAID');
    expect(await refusal(fees.voidCharge(w.owner, c1.id, 'غلط'))).toBe('CHARGE_HAS_PAYMENTS');
    await fees.voidCharge(w.owner, c2.id, 'اتسجل بالغلط');
    const v = await fees.student(w.owner, s.id);
    expect(v.charges.find((c) => c.id === c2.id)!.status).toBe('VOID');
    expect(v.summary.outstandingCents).toBe(EGP(75));
    const st = await fees.statement(w.owner, s.id);
    expect(st.events.at(-1)!.balanceCents).toBe(v.summary.outstandingCents);
    expect(st.events.map((e) => e.kind)).toContain('DISCOUNT');
    // Discount racing a collection: whichever goes first, the books close.
    const s2 = await owing(w, [EGP(200)], 'سباق');
    const ch = await prisma.centerCharge.findFirstOrThrow({ where: { academyStudentId: s2.id } });
    await Promise.allSettled([
      collect(w.reception, s2.id, EGP(200)),
      fees.adjust(w.owner, ch.id, {
        requestKey: key(),
        kind: 'DISCOUNT',
        amountCents: EGP(50),
        reason: 'خصم',
      }),
    ]);
    const [bal] = await prisma.$queryRaw<{ net: number; paid: number; out: number }[]>`
      SELECT "netCents" net, "paidCents" paid, "outstandingCents" out FROM "CenterChargeBalance" WHERE "chargeId" = ${ch.id}`;
    expect(bal.out).toBeGreaterThanOrEqual(0);
    expect(bal.paid).toBeLessThanOrEqual(bal.net);
  });

  it('property: random histories keep every invariant', async () => {
    if (!guard()) return;
    const w = await world();
    let seed = 42;
    const rnd = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const people = await Promise.all(
      Array.from({ length: 6 }, (_, i) => owing(w, [1 + rnd(90_000), 1 + rnd(90_000)], `خ${i}`)),
    );
    const done: string[] = [];
    for (let i = 0; i < 80; i++) {
      const s = people[rnd(people.length)];
      const op = rnd(4);
      try {
        if (op === 0)
          await fees.oneTime(w.owner, s.id, {
            requestKey: key(),
            description: 'إضافي',
            amountCents: 1 + rnd(50_000),
            dueOn: '2026-02-01',
          });
        if (op === 1)
          done.push((await collect(w.reception, s.id, 1 + rnd(60_000))).receipt.collectionId);
        if (op === 2 && done.length) await fees.reverse(w.owner, done[rnd(done.length)], 'عشوائي');
        if (op === 3) {
          const ch = await prisma.centerCharge.findFirst({ where: { academyStudentId: s.id } });
          if (ch)
            await fees.adjust(w.owner, ch.id, {
              requestKey: key(),
              kind: 'DISCOUNT',
              amountCents: 1 + rnd(5_000),
              reason: 'عشوائي',
            });
        }
      } catch {
        /* a refusal is an outcome; the invariants below must hold either way */
      }
    }
    const [inv] = await prisma.$queryRaw<
      { neg: number; overpaid: number; mism: number; dupR: number; badAlloc: number }[]
    >`
      SELECT
        (SELECT count(*)::int FROM "CenterChargeBalance" WHERE "academyId" = ${w.A.acad.id} AND "outstandingCents" < 0) neg,
        (SELECT count(*)::int FROM "CenterChargeBalance" WHERE "academyId" = ${w.A.acad.id} AND "paidCents" > "netCents") overpaid,
        (SELECT count(*)::int FROM "CenterCollection" k WHERE k."academyId" = ${w.A.acad.id}
           AND k."amountCents" <> (SELECT sum(a."amountCents") FROM "CenterAllocation" a WHERE a."collectionId" = k.id)) mism,
        (SELECT count(*)::int FROM (SELECT "receiptNumber" FROM "CenterCollection" WHERE "academyId" = ${w.A.acad.id} GROUP BY 1 HAVING count(*) > 1) x) "dupR",
        (SELECT count(*)::int FROM "CenterAllocation" a JOIN "CenterCollection" k ON k.id = a."collectionId" JOIN "CenterCharge" c ON c.id = a."chargeId"
           WHERE k."academyStudentId" <> c."academyStudentId") "badAlloc"`;
    expect(inv).toEqual({ neg: 0, overpaid: 0, mism: 0, dupR: 0, badAlloc: 0 });
    for (const s of people) {
      const st = await fees.statement(w.owner, s.id);
      expect(st.events.at(-1)?.balanceCents ?? 0).toBe(st.summary.outstandingCents);
      const rows = await fees.balances(prisma, w.A.acad.id, s.id);
      for (const r of rows) expect(r.paidCents + r.outstandingCents).toBe(r.netCents);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C4 — reports', () => {
  it("the day: everyone's with fees.report, only one's own otherwise; reversals counted apart", async () => {
    if (!guard()) return;
    const w = await world();
    const a = await owing(w, [EGP(1000)], 'أ');
    await collect(w.reception, a.id, EGP(100));
    await collect(w.reception2, a.id, EGP(200), { method: 'CARD_EXTERNAL' });
    const r = await collect(w.owner, a.id, EGP(50), { method: 'BANK_TRANSFER' });
    await fees.reverse(w.owner, r.receipt.collectionId, 'خطأ');
    const all = await fees.day(w.owner, undefined);
    expect(all.scope).toBe('ALL');
    expect(all.totals.amountCents).toBe(EGP(300));
    expect(all.totals.byMethod.CASH.amountCents).toBe(EGP(100));
    expect(all.totals.byMethod.CARD_EXTERNAL.amountCents).toBe(EGP(200));
    expect(all.totals.reversed).toEqual({ count: 1, amountCents: EGP(50) });
    const mine = await fees.day(w.reception, undefined);
    expect(mine.scope).toBe('MINE');
    expect(mine.items.map((i) => i.amountCents)).toEqual([EGP(100)]);
  });

  it('who owes: filters, search by code, paging, totals', async () => {
    if (!guard()) return;
    const w = await world();
    const late = await owing(w, [EGP(300)], 'متأخر عن الدفع'); // due 2026-01-10 (past) → overdue
    const part = await owing(w, [EGP(300)], 'دافع جزء');
    await collect(w.reception, part.id, EGP(100));
    const paid = await owing(w, [EGP(100)], 'دافع كله');
    await collect(w.reception, paid.id, EGP(100));
    const owingList = await fees.outstanding(w.owner, { status: 'OWING' });
    expect(owingList.items.map((i) => i.id).sort()).toEqual([late.id, part.id].sort());
    expect(owingList.totals.outstandingCents).toBe(EGP(500));
    expect((await fees.outstanding(w.owner, { status: 'PARTIAL' })).items.map((i) => i.id)).toEqual(
      [part.id],
    );
    expect((await fees.outstanding(w.owner, { status: 'PAID' })).items.map((i) => i.id)).toEqual([
      paid.id,
    ]);
    expect(
      (await fees.outstanding(w.owner, { status: 'OWING', q: late.code })).items.map((i) => i.id),
    ).toEqual([late.id]);
    expect(
      (await fees.outstanding(w.owner, { status: 'OWING', q: 'متأخر' })).items.map((i) => i.id),
    ).toEqual([late.id]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C4 — who may do what', () => {
  async function viaGuards(
    user: JwtPayload,
    academyId: string,
    method: keyof CenterFeesController,
  ) {
    const req: any = { user, headers: { 'x-academy-id': academyId }, params: {} };
    const exec: any = {
      getHandler: () => CenterFeesController.prototype[method],
      getClass: () => CenterFeesController,
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
    'outstanding',
    'day',
    'summary',
    'student',
    'statement',
    'receipt',
    'listPlans',
  ] as const;
  const COLLECT = ['preview', 'collect'] as const;
  const OWNER_ONLY = [
    'createPlan',
    'updatePlan',
    'generate',
    'groups',
    'oneTime',
    'monthly',
    'adjust',
    'voidCharge',
    'reverse',
    'exportOutstanding',
    'exportDay',
  ] as const;

  it('owner: everything; reception (fees.view + fees.collect): read and collect only', async () => {
    if (!guard()) return;
    const w = await world();
    for (const m of [...VIEW, ...COLLECT, ...OWNER_ONLY])
      expect(await outcome(viaGuards(jwt(w.A.ownerId, Role.STAFF), w.A.acad.id, m))).toBe(
        'ALLOWED',
      );
    for (const m of [...VIEW, ...COLLECT])
      expect(await outcome(viaGuards(jwt(w.receptionId, Role.STAFF), w.A.acad.id, m))).toBe(
        'ALLOWED',
      );
    for (const m of OWNER_ONLY)
      expect(await outcome(viaGuards(jwt(w.receptionId, Role.STAFF), w.A.acad.id, m))).toBe(
        'FORBIDDEN',
      );
  });

  it('a teacher, the desk without fees, a student and another academy see nothing', async () => {
    if (!guard()) return;
    const w = await world();
    const stu = await prisma.user.create({ data: { role: 'STUDENT', fullName: 'x' } });
    for (const m of [...VIEW, ...COLLECT, ...OWNER_ONLY]) {
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
  });

  it('centerFees off: every route shut, whatever the other flags', async () => {
    if (!guard()) return;
    const w = await world();
    await flags.setFlag(w.A.acad.id, 'centerFees', false, w.A.ownerId);
    for (const m of [...VIEW, ...COLLECT, ...OWNER_ONLY])
      expect(await outcome(viaGuards(jwt(w.A.ownerId, Role.STAFF), w.A.acad.id, m))).toBe(
        'FORBIDDEN',
      );
  });

  it('tenant: another academy’s learner, charge, receipt and plan are simply not found', async () => {
    if (!guard()) return;
    const w = await world();
    const other = await student(w.B.acad.id, 'برّه');
    await fees.oneTime(w.ownerB, other.id, {
      requestKey: key(),
      description: 'x',
      amountCents: 500,
      dueOn: '2026-01-01',
    });
    const ch = await prisma.centerCharge.findFirstOrThrow({
      where: { academyStudentId: other.id },
    });
    const k = (await collect(w.ownerB, other.id, 100)).receipt.collectionId;
    const plan = await plans.create(w.ownerB, {
      name: 'x',
      groupId: w.B.gA.id,
      type: 'MONTHLY',
      amountCents: 100,
    });
    expect(await refusal(fees.summary(w.owner, other.id))).toBe('STUDENT_NOT_FOUND');
    expect(await refusal(collect(w.owner, other.id, 100))).toBe('STUDENT_NOT_FOUND');
    expect(await refusal(fees.receipt(w.owner, k))).toBe('COLLECTION_NOT_FOUND');
    expect(await refusal(fees.reverse(w.owner, k, 'هجوم'))).toBe('COLLECTION_NOT_FOUND');
    expect(
      await refusal(
        fees.adjust(w.owner, ch.id, {
          requestKey: key(),
          kind: 'DISCOUNT',
          amountCents: 1,
          reason: 'هجوم',
        }),
      ),
    ).toBe('CHARGE_NOT_FOUND');
    expect(await refusal(fees.voidCharge(w.owner, ch.id, 'هجوم'))).toBe('CHARGE_NOT_FOUND');
    expect(await refusal(plans.update(w.owner, plan.id, { amountCents: 1 }))).toBe(
      'PLAN_NOT_FOUND',
    );
    expect(
      await refusal(
        plans.create(w.owner, { name: 'x', groupId: w.B.gA.id, type: 'MONTHLY', amountCents: 100 }),
      ),
    ).toBe('GROUP_NOT_FOUND');
    expect(
      (await prisma.centerCollection.findUniqueOrThrow({ where: { id: k } })).reversedAt,
    ).toBeNull();
  });

  it('mass assignment: server-owned fields are refused; bad amounts too', async () => {
    const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
    const meta = { type: 'body' as const, metatype: CollectDto };
    const base = { requestKey: 'abcdefgh1234', amountCents: 100, method: 'CASH' };
    for (const extra of [
      { academyId: 'x' },
      { receivedBy: 'x' },
      { receivedAt: new Date().toISOString() },
      { receiptNumber: '2026-000001' },
      { status: 'PAID' },
      { balanceAfterCents: 0 },
      { reversedAt: new Date().toISOString() },
      { createdBy: 'x' },
      { currency: 'USD' },
    ])
      await expect(pipe.transform({ ...base, ...extra }, meta)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    for (const amountCents of [0, -100, 1.5, Number.NaN, 100_000_001, '100'])
      await expect(pipe.transform({ ...base, amountCents }, meta)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    await expect(pipe.transform({ ...base, method: 'WALLET' }, meta)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(pipe.transform({ ...base, requestKey: 'x' }, meta)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C4 — attendance never depends on money', () => {
  it('a learner who owes and is overdue still checks in at the desk and on the class sheet', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await owing(w, [EGP(500)], 'مديون'); // due 2026-01-10 → overdue
    await stint(w.A.acad.id, w.A.gA.id, s.studentId, new Date(Date.now() - 86_400_000));
    expect((await fees.summary(w.owner, s.id)).overdueCents).toBe(EGP(500));
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
    expect(await owed(w, s.id)).toBe(EGP(500));
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C4 — platform money untouched', () => {
  it('every C4 flow above left Payment, ledger, wallet, payouts, Live purchases and terms byte-identical', async () => {
    if (!guard()) return;
    expect(await platformHash()).toEqual(platformBefore);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C4 — scale', () => {
  it('10,000 learners with monthly charges and collections: the reads and a collection stay quick', async () => {
    // C4_SCALE=0 skips it (the mutation run, where only correctness counts).
    if (!guard() || process.env.C4_SCALE === '0') return;
    const w = await world();
    const N = 10_000;
    const users = await prisma.user.createManyAndReturn({
      data: Array.from({ length: N }, (_, i) => ({ role: 'STUDENT' as const, fullName: `s${i}` })),
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
        academyId: w.A.acad.id,
        studentId: p.id,
        code: code[i],
        fullName: `طالب ${i}`,
        source: 'IMPORT' as const,
      })),
      select: { id: true, studentId: true },
    });
    await prisma.groupMembership.createMany({
      data: recs.map((r) => ({
        groupId: w.A.gA.id,
        studentId: r.studentId,
        academyId: w.A.acad.id,
        addedAt: new Date('2025-01-01T00:00:00Z'),
      })),
    });
    const plan = await oldPlan(w, w.A.gA.id, 'MONTHLY', EGP(500));
    const t = Date.now();
    for (const m of ['2026-01-15', '2026-02-15', '2026-03-15'])
      await plans.generatePlan(plan, { today: m });
    const genMs = Date.now() - t;
    expect(await prisma.centerCharge.count({ where: { planId: plan.id } })).toBe(3 * N);
    for (let i = 0; i < 2_000; i++) await collect(w.reception, recs[i].id, EGP(250));
    const time = async (f: () => Promise<unknown>) => {
      const s = process.hrtime.bigint();
      await f();
      return Number(process.hrtime.bigint() - s) / 1e6;
    };
    const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const sumMs: number[] = [];
    const colMs: number[] = [];
    const stMs: number[] = [];
    for (let i = 0; i < 15; i++) {
      sumMs.push(await time(() => fees.summary(w.reception, recs[5_000 + i].id)));
      stMs.push(await time(() => fees.statement(w.reception, recs[5_000 + i].id)));
      colMs.push(await time(() => collect(w.reception, recs[6_000 + i].id, EGP(100))));
    }
    const outMs = await time(() => fees.outstanding(w.owner, { status: 'OVERDUE' }));
    const dayMs = await time(() => fees.day(w.owner, undefined));
    console.log(
      `C4 scale (${N} learners, ${3 * N} charges, ~2k collections): generate 3 months ${genMs} ms; ` +
        `summary ${med(sumMs).toFixed(1)} ms, statement ${med(stMs).toFixed(1)} ms, collect ${med(colMs).toFixed(1)} ms, ` +
        `who-owes page ${outMs.toFixed(0)} ms, the day ${dayMs.toFixed(0)} ms`,
    );
    expect(med(sumMs)).toBeLessThan(300);
    expect(med(colMs)).toBeLessThan(800);
    expect(outMs).toBeLessThan(5_000);
  }, 600_000);
});
