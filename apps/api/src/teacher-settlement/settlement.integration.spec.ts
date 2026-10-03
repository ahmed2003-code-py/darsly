import { ForbiddenException, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'crypto';
import { JwtPayload, Role } from '@darsly/shared-types';
import { AcademyContext } from '../academy/academy-context';
import { AcademyService } from '../academy/academy.service';
import { AcademyMembershipGuard } from '../academy/guards/academy-membership.guard';
import { PermissionGuard } from '../academy/guards/permission.guard';
import { AcademyOpsAccessService } from '../academy-ops/academy-ops-access.service';
import { SessionsService } from '../academy-ops/sessions.service';
import { AuditService } from '../audit/audit.service';
import { CenterFeesService } from '../center-fees/center-fees.service';
import { FeePlansService } from '../center-fees/fee-plans.service';
import { generateStudentCode } from '../center-students/student-code';
import { ClassAttendanceService } from '../class-ops/class-attendance.service';
import { ClassScheduleService } from '../class-ops/class-schedule.service';
import { addDays } from '../class-ops/zoned-time';
import { VALIDATION_PIPE_OPTIONS } from '../common/errors/validation-exception.factory';
import { databaseReady } from '../common/testing/db-available';
import { FeatureFlagGuard } from '../feature-flags/guards/feature-flag.guard';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { PrismaService } from '../prisma/prisma.service';
import { AdjustDto, CreateAgreementDto, FinalizeDto, PayDto } from './dto';
import { TeacherSettlementController } from './settlement.controller';
import { TeacherSettlementService } from './settlement.service';

/**
 * Center Operations C8 against a real PostgreSQL: who taught a class comes
 * from the class's own snapshot; per-class pay counts only held classes
 * (attendance closed), across a rate change on its exact date; fixed monthly
 * pay is prorated; percent pay counts only money really collected for the
 * agreement's groups; a finalized settlement is frozen (later changes are
 * drift, corrected by adjustments); payments never exceed what is owed, even
 * racing; the database keeps every rule; and nothing outside C8 is written.
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
const plans = new FeePlansService(prisma, schedule, audit);
const svc = new TeacherSettlementService(prisma, schedule, fees, academy, audit);

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
const C4 = [
  'CenterCharge',
  'CenterCollection',
  'CenterAllocation',
  'CenterAdjustment',
  'CenterFeePlan',
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
  ready = await databaseReady(prisma, ['teacherAgreement', 'teacherSettlement', 'groupSession']);
});
afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
});
const guard = () => ready;
const jwt = (sub: string, role: Role) => ({ sub, role, sessionId: 's' }) as JwtPayload;
const ctxOf = async (userId: string, role: Role, academyId: string): Promise<AcademyContext> =>
  (await academy.buildContext(userId, academyId, role))!;
const key = () => randomUUID().replace(/-/g, '');
const usedCodes = new Set<string>();
const freshCode = () => {
  let c = generateStudentCode();
  while (usedCodes.has(c)) c = generateStudentCode();
  usedCodes.add(c);
  return c;
};
async function refusal(p: Promise<unknown>) {
  try {
    await p;
    return 'NO REFUSAL';
  } catch (e: any) {
    return e?.response?.code ?? e?.code ?? e?.message;
  }
}

async function world() {
  const k = randomUUID().slice(0, 8);
  const owner = await prisma.user.create({
    data: { role: 'STAFF', fullName: `Owner ${k}`, email: `c8-o-${k}@it.test` },
  });
  const acad = await prisma.academy.create({
    data: {
      slug: `c8-${k}`,
      name: `C8 ${k}`,
      ownerUserId: owner.id,
      kind: 'CENTER',
      timezone: 'Etc/UTC',
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
    'teacherSettlement',
  ] as const)
    await flags.setFlag(acad.id, f, true, owner.id);
  const teacher = async (tag: string) => {
    const u = await prisma.user.create({
      data: { role: 'TEACHER', fullName: `أ/ ${tag} ${k}`, email: `c8-${tag}-${k}@it.test` },
    });
    await prisma.teacherProfile.create({
      data: { userId: u.id, slug: `c8-${tag}-${k}`, status: 'APPROVED' },
    });
    await prisma.academyMembership.create({
      data: {
        userId: u.id,
        academyId: acad.id,
        role: 'TEACHER',
        status: 'ACTIVE',
        courseScope: 'ALL',
      },
    });
    return u.id;
  };
  const staff = async (tag: string, permissions: string[]) => {
    const u = await prisma.user.create({
      data: { role: 'STAFF', fullName: `${tag} ${k}`, email: `c8-${tag}-${k}@it.test` },
    });
    await prisma.academyMembership.create({
      data: {
        userId: u.id,
        academyId: acad.id,
        role: 'ASSISTANT',
        status: 'ACTIVE',
        courseScope: 'ALL',
        permissions,
      },
    });
    return u.id;
  };
  const t1 = await teacher('t1');
  const t2 = await teacher('t2');
  const viewerId = await staff('v', ['settlement.view']);
  const receptionId = await staff('r', [
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
  const gA = await prisma.group.create({ data: { academyId: acad.id, name: 'فيزياء أ' } });
  const gB = await prisma.group.create({ data: { academyId: acad.id, name: 'كيمياء ب' } });
  for (const [g, t] of [
    [gA, t1],
    [gB, t2],
  ] as const)
    await prisma.groupAssignment.create({
      data: { groupId: g.id, userId: t, role: 'TEACHER', academyId: acad.id },
    });
  const other = await prisma.academy.create({
    data: {
      slug: `c8x-${k}`,
      name: `C8 other ${k}`,
      ownerUserId: owner.id,
      kind: 'CENTER',
      timezone: 'Etc/UTC',
    },
  });
  return {
    acad,
    other,
    gA,
    gB,
    t1,
    t2,
    ownerId: owner.id,
    viewerId,
    receptionId,
    owner: await ctxOf(owner.id, Role.STAFF, acad.id),
    teacher1: await ctxOf(t1, Role.TEACHER, acad.id),
    viewer: await ctxOf(viewerId, Role.STAFF, acad.id),
  };
}
type World = Awaited<ReturnType<typeof world>>;
async function learner(w: World, name: string, groupId = w.gA.id) {
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
      groupId,
      studentId: sp.id,
      addedAt: new Date('2025-12-01T00:00:00Z'),
    },
  });
  return { id: rec.id, studentId: sp.id };
}
/** A class on a past date at 12:00 UTC, taught by `teacher`. */
const cls = (
  w: World,
  date: string,
  teacher: string | null,
  extra: Record<string, unknown> = {},
  groupId = w.gA.id,
) =>
  prisma.groupSession.create({
    data: {
      academyId: w.acad.id,
      groupId,
      startAt: new Date(`${date}T12:00:00Z`),
      endAt: new Date(`${date}T13:00:00Z`),
      locationType: 'CENTER',
      createdBy: w.ownerId,
      teacherUserId: teacher,
      ...extra,
    },
  });
const agree = (w: World, dto: Partial<CreateAgreementDto>) =>
  svc.createAgreement(w.owner, {
    requestKey: key(),
    teacherUserId: w.t1,
    method: 'PER_SESSION',
    rateCents: 20_000,
    effectiveFrom: '2026-01-01',
    ...dto,
  } as CreateAgreementDto);
const finalize = async (
  w: World,
  from: string,
  to: string,
  teacher = w.t1,
  ctx = w.owner,
  requestKey = key(),
) => {
  const p = await svc.preview(ctx, teacher, from, to);
  return svc.finalize(ctx, {
    requestKey,
    teacherUserId: teacher,
    from,
    to,
    expectedGrossCents: p.grossCents,
  } as FinalizeDto);
};

// ───────────────────────────────────────────────────────────────────────────
describe('C8 — the database keeps the rules', () => {
  it('agreements never edited or deleted, never overlapping, ended once; settlements frozen; lines once; money adds up', async () => {
    if (!guard()) return;
    const w = await world();
    const a = (await agree(w, {})).agreement;
    await expect(
      prisma.teacherAgreement.update({ where: { id: a.id }, data: { rateCents: 1 } }),
    ).rejects.toThrow(/never edited/);
    await expect(prisma.teacherAgreement.delete({ where: { id: a.id } })).rejects.toThrow(
      /never deleted/,
    );
    expect(await refusal(agree(w, { effectiveFrom: '2026-02-01', rateCents: 30_000 }))).toBe(
      'AGREEMENT_OVERLAP',
    );
    // A different method may run alongside; disjoint group scopes of one method too.
    await agree(w, { method: 'FIXED_PERIOD', rateCents: 100_000 });
    await agree(w, { teacherUserId: w.t2, groupIds: [w.gA.id] });
    await agree(w, { teacherUserId: w.t2, groupIds: [w.gB.id], rateCents: 15_000 });
    expect(
      await refusal(agree(w, { teacherUserId: w.t2, groupIds: [w.gB.id], rateCents: 1 })),
    ).toBe('AGREEMENT_OVERLAP');
    await svc.endAgreement(w.owner, a.id, '2026-03-31');
    expect(await refusal(svc.endAgreement(w.owner, a.id, '2026-03-15'))).toBe('AGREEMENT_ENDED');
    // Settlement rows.
    await cls(w, '2026-02-10', w.t1).then((c) => classes.close(w.owner, c.id));
    const s = (await finalize(w, '2026-02-01', '2026-02-28')).settlement;
    await expect(
      prisma.teacherSettlement.update({ where: { id: s.id }, data: { grossCents: 1 } }),
    ).rejects.toThrow(/keeps its teacher/);
    await expect(prisma.teacherSettlement.delete({ where: { id: s.id } })).rejects.toThrow(
      /never deleted/,
    );
    await expect(
      prisma.teacherSettlement.update({
        where: { id: s.id },
        data: { paidCents: s.payableCents + 1, status: 'PARTIALLY_PAID' },
      }),
    ).rejects.toThrow(/shape/);
    const line = await prisma.teacherSettlementLine.findFirstOrThrow({
      where: { settlementId: s.id },
    });
    await expect(
      prisma.teacherSettlementLine.update({ where: { id: line.id }, data: { amountCents: 1 } }),
    ).rejects.toThrow(/history/);
    await expect(
      prisma.teacherSettlementLine.create({
        data: {
          academyId: w.acad.id,
          settlementId: s.id,
          teacherUserId: w.t1,
          kind: line.kind,
          sourceId: line.sourceId,
          agreementId: line.agreementId,
          amountCents: 1,
          detail: {},
        },
      }),
    ).rejects.toThrow(/Unique|once/);
    await svc.pay(w.owner, s.id, { requestKey: key(), amountCents: 100, method: 'CASH' } as PayDto);
    const p = await prisma.teacherSettlementPayment.findFirstOrThrow({
      where: { settlementId: s.id },
    });
    await expect(
      prisma.teacherSettlementPayment.update({ where: { id: p.id }, data: { amountCents: 1 } }),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.teacherSettlementPayment.delete({ where: { id: p.id } })).rejects.toThrow(
      /append-only/,
    );
    await expect(
      prisma.teacherSettlement.update({
        where: { id: s.id },
        data: { paidCents: 0, status: 'FINALIZED' },
      }),
    ).rejects.toThrow(/never taken back/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C8 — per-class pay', () => {
  it('only held classes of this teacher count, at the rate of their own date; pending ones are shown, never paid', async () => {
    if (!guard()) return;
    const w = await world();
    await agree(w, { rateCents: 20_000, effectiveFrom: '2026-01-01', effectiveTo: '2026-03-15' });
    await agree(w, { rateCents: 25_000, effectiveFrom: '2026-03-16' });
    const held1 = await cls(w, '2026-03-10', w.t1);
    const held2 = await cls(w, '2026-03-20', w.t1);
    const empty = await cls(w, '2026-03-12', w.t1); // nobody came: still held
    const open = await cls(w, '2026-03-14', w.t1); // attendance never closed
    const cancelled = await cls(w, '2026-03-16', w.t1, { status: 'CANCELLED' });
    const online = await cls(w, '2026-03-17', w.t1, { mode: 'ONLINE' });
    const other = await cls(w, '2026-03-18', w.t2);
    const unattributed = await cls(w, '2026-03-19', null);
    const l = await learner(w, 'أحمد');
    await classes.mark(w.owner, held1.id, {
      records: [{ studentId: l.studentId, status: 'PRESENT' }],
    } as any);
    for (const c of [held1, held2, empty, other]) await classes.close(w.owner, c.id);
    void cancelled;
    void online;
    void unattributed;
    const p = await svc.preview(w.owner, w.t1, '2026-03-01', '2026-03-31');
    expect(p.lines.map((x) => [x.sourceId, x.amountCents])).toEqual([
      [held1.id, 20_000],
      [empty.id, 20_000],
      [held2.id, 25_000],
    ]);
    expect(p.grossCents).toBe(65_000);
    expect(p.pending).toEqual([
      expect.objectContaining({ sessionId: open.id, why: 'ATTENDANCE_OPEN' }),
    ]);
    // The teacher's assignment to the group ends: history does not move.
    await prisma.groupAssignment.deleteMany({ where: { userId: w.t1, groupId: w.gA.id } });
    expect((await svc.preview(w.owner, w.t1, '2026-03-01', '2026-03-31')).grossCents).toBe(65_000);
  });

  it('who taught a started class: the teacher cannot change it, the owner can (a substitute) — and a finalized settlement then shows drift, never a rewrite', async () => {
    if (!guard()) return;
    const w = await world();
    await agree(w, { rateCents: 20_000 });
    await prisma.groupAssignment.create({
      data: { groupId: w.gA.id, userId: w.t2, role: 'TEACHER', academyId: w.acad.id },
    });
    const c = await cls(w, '2026-03-10', w.t1);
    await classes.close(w.owner, c.id);
    const sessions = new SessionsService(prisma, access, audit, academy);
    expect(await refusal(sessions.update(w.teacher1, c.id, { teacherUserId: w.t2 } as any))).toBe(
      'SESSION_TEACHER_LOCKED',
    );
    const s = (await finalize(w, '2026-03-01', '2026-03-31')).settlement;
    expect(s.grossCents).toBe(20_000);
    await sessions.update(w.owner, c.id, { teacherUserId: w.t2 } as any);
    const after = await svc.get(w.owner, s.id);
    expect(after.grossCents).toBe(20_000); // frozen
    expect(after.drift).toMatchObject({
      removed: [expect.objectContaining({ sourceId: c.id })],
      deltaCents: -20_000,
    });
    await svc.adjust(w.owner, s.id, {
      requestKey: key(),
      kind: 'CORRECTION',
      amountCents: -20_000,
      reason: 'الحصة دي درّسها بديل',
    } as AdjustDto);
    const fixed = await svc.get(w.owner, s.id);
    expect(fixed).toMatchObject({ payableCents: 0, adjustCents: -20_000 });
    const log = await prisma.auditLog.findMany({
      where: { academyId: w.acad.id, action: 'settlement.adjust' },
    });
    expect(JSON.stringify(log.map((x) => x.meta))).not.toMatch(/بديل/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C8 — fixed monthly and percent of collections', () => {
  it('fixed monthly: a full month is exact, a part month prorated half-up by days', async () => {
    if (!guard()) return;
    const w = await world();
    await agree(w, { method: 'FIXED_PERIOD', rateCents: 310_000, effectiveFrom: '2026-02-01' });
    const feb = await svc.preview(w.owner, w.t1, '2026-02-01', '2026-02-28');
    expect(feb.lines).toEqual([
      expect.objectContaining({
        amountCents: 310_000,
        detail: expect.objectContaining({ coveredDays: 28, daysInMonth: 28 }),
      }),
    ]);
    const part = await svc.preview(w.owner, w.t1, '2026-03-10', '2026-03-31');
    expect(part.grossCents).toBe(220_000); // 310000 × 22 / 31
    const odd = await svc.preview(w.owner, w.t1, '2026-04-01', '2026-04-07');
    expect(odd.grossCents).toBe(72_333); // 310000 × 7 / 30 = 72333.33 → 72333
  });

  it("percent: only money really collected for the agreement's groups, never reversed, never one-time; half-up per allocation", async () => {
    if (!guard()) return;
    const w = await world();
    const today = (await schedule.academyClock(w.acad.id)).today;
    await agree(w, {
      method: 'PERCENT_OF_COLLECTIONS',
      percentBps: 1_500,
      groupIds: [w.gA.id],
      effectiveFrom: addDays(today, -40),
    });
    const [a, b] = await Promise.all([learner(w, 'منى'), learner(w, 'سارة')]);
    const c = await learner(w, 'عمر', w.gB.id);
    for (const g of [w.gA, w.gB])
      await plans.create(w.owner, {
        name: `شهري ${g.name}`,
        groupId: g.id,
        type: 'MONTHLY',
        amountCents: 50_000,
      } as any);
    await fees.oneTime(w.owner, a.id, {
      requestKey: key(),
      description: 'ملزمة',
      amountCents: 9_999,
      dueOn: today,
    });
    const before = await hashOf(PLATFORM);
    const pay = (id: string, amountCents: number) =>
      fees.collect(w.owner, id, { requestKey: key(), amountCents, method: 'CASH' });
    // a pays 3333 on the monthly plan (oldest first: the plan charge is due first? use explicit allocation).
    const planCharge = async (sid: string) =>
      (
        await prisma.centerCharge.findFirstOrThrow({
          where: { academyStudentId: sid, kind: 'MONTHLY' },
        })
      ).id;
    const oneTime = (
      await prisma.centerCharge.findFirstOrThrow({
        where: { academyStudentId: a.id, kind: 'ONE_TIME' },
      })
    ).id;
    await fees.collect(w.owner, a.id, {
      requestKey: key(),
      amountCents: 3_333,
      method: 'CASH',
      allocations: [{ chargeId: await planCharge(a.id), amountCents: 3_333 }],
    });
    await fees.collect(w.owner, a.id, {
      requestKey: key(),
      amountCents: 9_999,
      method: 'CASH',
      allocations: [{ chargeId: oneTime, amountCents: 9_999 }],
    });
    const rb = (await fees.collect(w.owner, b.id, {
      requestKey: key(),
      amountCents: 20_000,
      method: 'CASH',
      allocations: [{ chargeId: await planCharge(b.id), amountCents: 20_000 }],
    })) as any;
    await fees.collect(w.owner, c.id, {
      requestKey: key(),
      amountCents: 50_000,
      method: 'CASH',
      allocations: [{ chargeId: await planCharge(c.id), amountCents: 50_000 }],
    });
    void pay;
    let p = await svc.preview(w.owner, w.t1, addDays(today, -3), today);
    // 3333 × 15% = 499.95 → 500; 20000 × 15% = 3000; one-time and the other group never count.
    expect(p.lines.map((l) => l.amountCents).sort((x, y) => x - y)).toEqual([500, 3_000]);
    await fees.reverse(w.owner, rb.receipt.collectionId, 'اتسجل غلط');
    p = await svc.preview(w.owner, w.t1, addDays(today, -3), today);
    expect(p.lines.map((l) => l.amountCents)).toEqual([500]);
    expect(await hashOf(PLATFORM)).toEqual(before);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C8 — finalize, adjust, pay', () => {
  it('finalize is frozen, idempotent, never overlapping, refused when the figures moved; agreements cannot reach into it', async () => {
    if (!guard()) return;
    const w = await world();
    const a = (await agree(w, { rateCents: 20_000 })).agreement;
    for (const d of ['2026-03-03', '2026-03-04'])
      await cls(w, d, w.t1).then((c) => classes.close(w.owner, c.id));
    const p = await svc.preview(w.owner, w.t1, '2026-03-01', '2026-03-31');
    expect(
      await refusal(
        svc.finalize(w.owner, {
          requestKey: key(),
          teacherUserId: w.t1,
          from: '2026-03-01',
          to: '2026-03-31',
          expectedGrossCents: p.grossCents + 1,
        } as FinalizeDto),
      ),
    ).toBe('SETTLEMENT_PREVIEW_CHANGED');
    const k = key();
    const twice = await Promise.all(
      [1, 2].map(() =>
        svc.finalize(w.owner, {
          requestKey: k,
          teacherUserId: w.t1,
          from: '2026-03-01',
          to: '2026-03-31',
          expectedGrossCents: p.grossCents,
        } as FinalizeDto),
      ),
    );
    expect(twice.map((t) => t.created).sort()).toEqual([false, true]);
    expect(await prisma.teacherSettlement.count({ where: { academyId: w.acad.id } })).toBe(1);
    // Two different finalizations of overlapping periods at once: one.
    const race = await Promise.allSettled([
      finalize(w, '2026-02-01', '2026-03-10'),
      finalize(w, '2026-02-15', '2026-02-20'),
    ]);
    expect(race.every((r) => r.status === 'rejected')).toBe(true); // both overlap March's settlement
    // A late class in the settled period changes nothing frozen — it is drift.
    await cls(w, '2026-03-05', w.t1).then((c) => classes.close(w.owner, c.id));
    const s = await svc.get(w.owner, twice[0].settlement.id);
    expect(s.grossCents).toBe(40_000);
    expect(s.drift).toMatchObject({
      added: [expect.objectContaining({ amountCents: 20_000 })],
      deltaCents: 20_000,
    });
    expect(
      await refusal(
        agree(w, { method: 'FIXED_PERIOD', rateCents: 100, effectiveFrom: '2026-03-20' }),
      ),
    ).toBe('AGREEMENT_IN_SETTLED_PERIOD');
    expect(await refusal(svc.endAgreement(w.owner, a.id, '2026-03-20'))).toBe(
      'AGREEMENT_IN_SETTLED_PERIOD',
    );
    expect(
      await refusal(
        svc.finalize(w.owner, {
          requestKey: key(),
          teacherUserId: w.t1,
          from: '2026-03-01',
          to: addDays((await schedule.academyClock(w.acad.id)).today, 1),
          expectedGrossCents: 0,
        } as FinalizeDto),
      ),
    ).toBe('PERIOD_IN_FUTURE');
    expect(await refusal(finalize(w, '2026-01-01', '2026-01-31'))).toBe('SETTLEMENT_EMPTY');
  });

  it('payments: partial, then final; never more than owed — not with a retry, not racing; adjustments never below what was paid; void only unpaid', async () => {
    if (!guard()) return;
    const w = await world();
    await agree(w, { rateCents: 30_000 });
    for (const d of ['2026-03-03', '2026-03-04'])
      await cls(w, d, w.t1).then((c) => classes.close(w.owner, c.id));
    const s = (await finalize(w, '2026-03-01', '2026-03-31')).settlement; // 60000
    const before = { platform: await hashOf(PLATFORM), c4: await hashOf(C4) };
    const k = key();
    const dup = await Promise.all(
      [1, 2].map(() =>
        svc.pay(w.owner, s.id, { requestKey: k, amountCents: 20_000, method: 'CASH' } as PayDto),
      ),
    );
    expect(dup.map((d) => d.replayed).sort()).toEqual([false, true]);
    expect(await svc.get(w.owner, s.id)).toMatchObject({
      status: 'PARTIALLY_PAID',
      paidCents: 20_000,
      remainingCents: 40_000,
    });
    expect(
      await refusal(
        svc.pay(w.owner, s.id, { requestKey: k, amountCents: 25_000, method: 'CASH' } as PayDto),
      ),
    ).toBe('SETTLEMENT_KEY_REUSED');
    // Two payments race for the remaining 40000: 30000 + 30000 → exactly one lands.
    const race = await Promise.allSettled(
      [1, 2].map(() =>
        svc.pay(w.owner, s.id, {
          requestKey: key(),
          amountCents: 30_000,
          method: 'BANK_TRANSFER',
          reference: 'TRX-1',
        } as PayDto),
      ),
    );
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (race.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.response.code,
    ).toBe('SETTLEMENT_OVERPAYMENT');
    expect(
      await refusal(
        svc.adjust(w.owner, s.id, {
          requestKey: key(),
          kind: 'DEDUCTION',
          amountCents: -20_000,
          reason: 'خصم',
        } as AdjustDto),
      ),
    ).toBe('SETTLEMENT_ADJUST_BELOW_PAID');
    expect(
      await refusal(
        svc.adjust(w.owner, s.id, {
          requestKey: key(),
          kind: 'BONUS',
          amountCents: -1,
          reason: 'غلط',
        } as AdjustDto),
      ),
    ).toBe('ADJUSTMENT_SIGN_INVALID');
    await svc.adjust(w.owner, s.id, {
      requestKey: key(),
      kind: 'BONUS',
      amountCents: 5_000,
      reason: 'مكافأة',
    } as AdjustDto);
    await svc.pay(w.owner, s.id, {
      requestKey: key(),
      amountCents: 15_000,
      method: 'CASH',
    } as PayDto);
    expect(await svc.get(w.owner, s.id)).toMatchObject({
      status: 'PAID',
      payableCents: 65_000,
      paidCents: 65_000,
      remainingCents: 0,
    });
    expect(
      await refusal(
        svc.pay(w.owner, s.id, { requestKey: key(), amountCents: 1, method: 'CASH' } as PayDto),
      ),
    ).toBe('SETTLEMENT_OVERPAYMENT');
    expect(await refusal(svc.voidSettlement(w.owner, s.id, 'غلط'))).toBe('SETTLEMENT_HAS_PAYMENTS');
    // Center-to-teacher money never touched platform money or the students' fee books.
    expect(await hashOf(PLATFORM)).toEqual(before.platform);
    expect(await hashOf(C4)).toEqual(before.c4);
    const log = JSON.stringify(
      (
        await prisma.auditLog.findMany({
          where: { academyId: w.acad.id, action: { startsWith: 'settlement.' } },
        })
      ).map((x) => x.meta),
    );
    expect(log).not.toMatch(/مكافأة|TRX-1/);
    // An unpaid settlement can be voided and the period settled again.
    const w2 = await world();
    await agree(w2, { rateCents: 10_000 });
    await cls(w2, '2026-03-03', w2.t1).then((c) => classes.close(w2.owner, c.id));
    const s2 = (await finalize(w2, '2026-03-01', '2026-03-31')).settlement;
    await svc.voidSettlement(w2.owner, s2.id, 'الفترة غلط');
    expect((await finalize(w2, '2026-03-01', '2026-03-31')).settlement.grossCents).toBe(10_000);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C8 — who may do what', () => {
  async function viaGuards(
    user: JwtPayload,
    academyId: string,
    method: keyof TeacherSettlementController,
  ) {
    const req: any = { user, headers: { 'x-academy-id': academyId }, params: {} };
    const exec: any = {
      getHandler: () => TeacherSettlementController.prototype[method],
      getClass: () => TeacherSettlementController,
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
  const READ = ['teachers', 'groups', 'preview', 'list', 'get', 'statement'] as const;
  const WRITE = [
    'createAgreement',
    'endAgreement',
    'finalize',
    'voidSettlement',
    'adjust',
    'pay',
  ] as const;

  it('owner all; a viewer only reads; teacher, Reception, another academy nothing; flag off nothing', async () => {
    if (!guard()) return;
    const w = await world();
    for (const m of [...READ, ...WRITE]) {
      expect(await outcome(viaGuards(jwt(w.ownerId, Role.STAFF), w.acad.id, m))).toBe('ALLOWED');
      expect(await outcome(viaGuards(jwt(w.t1, Role.TEACHER), w.acad.id, m))).toBe('FORBIDDEN');
      expect(await outcome(viaGuards(jwt(w.receptionId, Role.STAFF), w.acad.id, m))).toBe(
        'FORBIDDEN',
      );
      expect(await outcome(viaGuards(jwt(w.ownerId, Role.STAFF), w.other.id, m))).not.toBe(
        'ALLOWED',
      );
    }
    for (const m of READ)
      expect(await outcome(viaGuards(jwt(w.viewerId, Role.STAFF), w.acad.id, m))).toBe('ALLOWED');
    for (const m of WRITE)
      expect(await outcome(viaGuards(jwt(w.viewerId, Role.STAFF), w.acad.id, m))).toBe('FORBIDDEN');
    await flags.setFlag(w.acad.id, 'teacherSettlement', false, w.ownerId);
    expect(await outcome(viaGuards(jwt(w.ownerId, Role.STAFF), w.acad.id, 'preview'))).toBe(
      'FORBIDDEN',
    );
  });

  it("tenancy: another academy's settlement is not found; mass assignment and bad money refused", async () => {
    if (!guard()) return;
    const w = await world();
    await agree(w, { rateCents: 10_000 });
    await cls(w, '2026-03-03', w.t1).then((c) => classes.close(w.owner, c.id));
    const s = (await finalize(w, '2026-03-01', '2026-03-31')).settlement;
    const w2 = await world();
    expect(await refusal(svc.get(w2.owner, s.id))).toBe('SETTLEMENT_NOT_FOUND');
    expect(
      await refusal(
        svc.pay(w2.owner, s.id, { requestKey: key(), amountCents: 1, method: 'CASH' } as PayDto),
      ),
    ).toBe('SETTLEMENT_NOT_FOUND');
    expect(
      await refusal(
        svc.createAgreement(w2.owner, {
          requestKey: key(),
          teacherUserId: w.t1,
          method: 'PER_SESSION',
          rateCents: 1,
          effectiveFrom: '2026-01-01',
        } as CreateAgreementDto),
      ),
    ).toBe('TEACHER_NOT_MEMBER');
    const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
    const bad = (metatype: any, value: object) =>
      pipe.transform(value, { type: 'body', metatype }).then(
        () => 'ACCEPTED',
        () => 'REFUSED',
      );
    const base = { requestKey: key(), amountCents: 100, method: 'CASH' };
    expect(await bad(PayDto, base)).toBe('ACCEPTED');
    for (const x of [
      { amountCents: 0 },
      { amountCents: -5 },
      { amountCents: 1.5 },
      { amountCents: 1e12 },
      { status: 'PAID' },
      { paidCents: 1 },
      { academyId: 'x' },
      { recordedBy: 'x' },
      { method: 'WALLET' },
    ])
      expect(await bad(PayDto, { ...base, ...x })).toBe('REFUSED');
    expect(
      await bad(FinalizeDto, {
        requestKey: key(),
        teacherUserId: 'x',
        from: '2026-03-01',
        to: '2026-03-31',
        expectedGrossCents: 0,
        grossCents: 1,
      }),
    ).toBe('REFUSED');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C8 — scale', () => {
  it('a year of a busy teacher (31 groups, weekly, ≈ 1,600 classes), stale statistics: a quarter previews, finalizes and loads quickly', async () => {
    if (!guard() || process.env.C8_SCALE === '0') return;
    const w = await world();
    const a = w.acad.id;
    await prisma.$executeRawUnsafe(
      'ANALYZE "GroupSession", "AttendanceSession", "TeacherSettlementLine", "CenterAllocation"',
    );
    await agree(w, { rateCents: 20_000 });
    const groups = await prisma.group.createManyAndReturn({
      data: Array.from({ length: 30 }, (_, i) => ({ academyId: a, name: `G${i}` })),
      select: { id: true },
    });
    await prisma.$executeRawUnsafe(
      `
      INSERT INTO "GroupSession"(id, "academyId", "groupId", "startAt", "endAt", "locationType", "createdBy", status, "updatedAt", "teacherUserId")
      SELECT 'gs' || md5(g.id || d::text), $1, g.id, timestamp '2025-10-01 06:00' + (d || ' days')::interval + g.rn * interval '30 minutes', timestamp '2025-10-01 06:25' + (d || ' days')::interval + g.rn * interval '30 minutes', 'CENTER', $2, 'COMPLETED', now(), $3
      FROM (SELECT id, row_number() OVER (ORDER BY id) rn FROM "Group" WHERE "academyId" = $1) g, generate_series(0, 360, 7) d`,
      a,
      w.ownerId,
      w.t1,
    );
    await prisma.$executeRawUnsafe(
      `
      INSERT INTO "AttendanceSession"(id, "academyId", "groupId", date, "groupSessionId", "createdBy", "closedAt", "closedBy")
      SELECT 'as' || gs.id, gs."academyId", gs."groupId", gs."startAt"::date, gs.id, $2, gs."endAt", $2 FROM "GroupSession" gs WHERE gs."academyId" = $1`,
      a,
      w.ownerId,
    );
    void groups;
    let t = Date.now();
    const p = await svc.preview(w.owner, w.t1, '2026-01-01', '2026-03-31');
    const previewMs = Date.now() - t;
    t = Date.now();
    await svc.finalize(w.owner, {
      requestKey: key(),
      teacherUserId: w.t1,
      from: '2026-01-01',
      to: '2026-03-31',
      expectedGrossCents: p.grossCents,
    } as FinalizeDto);
    const finalizeMs = Date.now() - t;
    t = Date.now();
    const s = await prisma.teacherSettlement.findFirstOrThrow({ where: { academyId: a } });
    await svc.get(w.owner, s.id);
    const getMs = Date.now() - t;
    console.log(
      `C8 scale: ${p.lines.length} classes in the quarter; preview ${previewMs} ms; finalize ${finalizeMs} ms; settlement with drift check ${getMs} ms`,
    );
    expect(previewMs).toBeLessThan(1500);
    expect(finalizeMs).toBeLessThan(3000);
    expect(getMs).toBeLessThan(1500);
  }, 600_000);
});
