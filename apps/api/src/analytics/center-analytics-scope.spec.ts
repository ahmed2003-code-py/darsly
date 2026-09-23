import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

const ctx = (over: Record<string, unknown> = {}) =>
  ({
    academyId: 'centerA',
    userId: 'tA',
    role: 'OWNER',
    status: 'ACTIVE',
    isPlatformAdmin: false,
    can: () => true,
    ...over,
  }) as any;
const auditSvc: any = { listForAcademy: jest.fn(async () => ({ items: [], nextCursor: null })) };
const user = { sub: 'tA', role: 'TEACHER', tenantId: 'tpA', sessionId: 's' } as any;

describe("AnalyticsController — academy-wide analytics are the owner's; a member gets their own slice", () => {
  const svc: any = new Proxy({}, { get: (_t, name) => jest.fn(async () => ({ called: name })) });
  const c = new AnalyticsController(svc, auditSvc);

  it.each([
    ['overview', (c: AnalyticsController, x: any) => c.overview(x)],
    ['students', (c: AnalyticsController, x: any) => c.students(x, '30')],
    ['growth', (c: AnalyticsController, x: any) => c.growth(x, '30')],
    ['enrollments', (c: AnalyticsController, x: any) => c.enrollments(x)],
    ['attendance', (c: AnalyticsController, x: any) => c.attendance(x, '30')],
    ['groups', (c: AnalyticsController, x: any) => c.groups(x)],
    ['scheduling', (c: AnalyticsController, x: any) => c.scheduling(x, '30')],
    ['courses', (c: AnalyticsController, x: any) => c.courses(x)],
    ['teachers', (c: AnalyticsController, x: any) => c.teachers(x)],
    ['financial', (c: AnalyticsController, x: any) => c.financial(x, '30')],
    ['center', (c: AnalyticsController, x: any) => c.center(x)],
    ['activity', (c: AnalyticsController, x: any) => c.activity(x)],
  ])(
    '%s: TEACHER member → 403, OWNER → served, platform admin (synthetic OWNER) → served',
    async (_n, call) => {
      // The gate throws before any service call — synchronously, on purpose.
      await expect((async () => call(c, ctx({ role: 'TEACHER' })))()).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect((async () => call(c, ctx({ role: 'ASSISTANT' })))()).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect((async () => call(c, ctx()))()).resolves.toBeDefined();
      await expect((async () => call(c, ctx({ isPlatformAdmin: true })))()).resolves.toBeDefined();
    },
  );

  it('me: any analytics.read holder, scoped to their own identity + the active academy', async () => {
    const s: any = { myTeaching: jest.fn(async () => ({})) };
    await new AnalyticsController(s, auditSvc).me(user, ctx({ role: 'TEACHER' }), '30');
    expect(s.myTeaching).toHaveBeenCalledWith(
      expect.objectContaining({ academyId: 'centerA', userId: 'tA' }),
      'tpA',
      30,
    );
  });

  it('activity: scoped strictly to ctx.academyId, never a client-supplied one; forwards cursor/take', async () => {
    const s: any = {};
    const a: any = {
      listForAcademy: jest.fn(async () => ({ items: [{ id: 'log1' }], nextCursor: 'log1' })),
    };
    const out = await new AnalyticsController(s, a).activity(
      ctx({ academyId: 'centerA' }),
      'cursorX',
      '10',
    );
    expect(a.listForAcademy).toHaveBeenCalledWith('centerA', { cursor: 'cursorX', take: 10 });
    expect(out.items).toHaveLength(1);
  });
});

function makePrisma() {
  const count = () => jest.fn().mockResolvedValue(0);
  return {
    academy: { findUnique: jest.fn() },
    academyMembership: { count: count() },
    course: { count: count(), findMany: jest.fn().mockResolvedValue([]) },
    enrollment: {
      count: count(),
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    group: { count: count() },
    groupAssignment: { count: count() },
    groupSession: { count: count() },
    liveSession: { count: count() },
    academySubject: { count: count() },
    auditLog: { findMany: jest.fn().mockResolvedValue([]) },
    payment: { groupBy: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([{ n: 0n, present: 0n, total: 0n }]),
  } as any;
}
const makeLedger = () =>
  ({
    orgEarnings: jest.fn().mockResolvedValue({ netCents: 0 }),
    academyRevenueTrend: jest.fn().mockResolvedValue([]),
  }) as any;
const svcOf = (prisma: any) =>
  new AnalyticsService(prisma, {} as any, {} as any, {} as any, makeLedger());

describe('AnalyticsService — organisation scope is academyId, authorship is tenantId', () => {
  it('centerOverview keys every count on ctx.academyId and reads no financial source', async () => {
    const prisma = makePrisma();
    prisma.academy.findUnique.mockResolvedValue({ kind: 'CENTER', name: 'A' });
    const out = await svcOf(prisma).centerOverview(ctx());
    for (const m of [
      'academyMembership',
      'course',
      'group',
      'groupSession',
      'liveSession',
      'academySubject',
    ]) {
      for (const call of prisma[m].count.mock.calls)
        expect(call[0].where.academyId).toBe('centerA');
    }
    expect(prisma.auditLog.findMany.mock.calls[0][0].where).toEqual({ academyId: 'centerA' });
    expect(prisma.payment.groupBy).not.toHaveBeenCalled();
    expect(JSON.stringify(out)).not.toMatch(/cents|revenue|commission/i);
    expect(out.subjectsActive).toBe(0); // CENTER exposes the count
  });

  it('centerOverview counts only approved TEACHER identities as teachers (a STAFF owner is not one)', async () => {
    const prisma = makePrisma();
    prisma.academy.findUnique.mockResolvedValue({ kind: 'CENTER', name: 'A' });
    await svcOf(prisma).centerOverview(ctx());
    expect(prisma.academyMembership.count.mock.calls[0][0].where).toMatchObject({
      user: { role: 'TEACHER', teacherProfile: { status: 'APPROVED' } },
    });
  });

  it('myTeaching: authored courses need BOTH academyId and tenantId; sessions/groups key on the user', async () => {
    const prisma = makePrisma();
    await svcOf(prisma).myTeaching(ctx({ role: 'TEACHER' }), 'tpA', 30);
    expect(prisma.course.count.mock.calls[0][0].where).toEqual({
      academyId: 'centerA',
      tenantId: 'tpA',
    });
    expect(prisma.enrollment.count.mock.calls[0][0].where).toMatchObject({
      academyId: 'centerA',
      course: { tenantId: 'tpA' },
    });
    expect(prisma.groupAssignment.count.mock.calls[0][0].where).toEqual({
      academyId: 'centerA',
      userId: 'tA',
    });
    for (const call of prisma.groupSession.count.mock.calls)
      expect(call[0].where).toMatchObject({ academyId: 'centerA', teacherUserId: 'tA' });
  });

  it('myTeaching for a STAFF caller (no TeacherProfile) reports zero authored courses without querying by tenantId', async () => {
    const prisma = makePrisma();
    const out = await svcOf(prisma).myTeaching(ctx({ userId: 'staffU' }), undefined, 30);
    expect(out.courses).toBe(0);
    expect(prisma.course.count).not.toHaveBeenCalled();
  });

  it("financialOverview is now organisation-scoped for a Center too (Phase 7) — its own account, not the author's", async () => {
    const prisma = makePrisma();
    prisma.academy.findUnique.mockResolvedValue({ id: 'centerA', kind: 'CENTER' });
    const out = await svcOf(prisma).financialOverview('centerA', 30);
    expect(out.kind).toBe('CENTER');
    expect(prisma.payment.groupBy.mock.calls[0][0].where.academyId).toBe('centerA');
  });

  it('financialOverview 404s for an unknown academy id', async () => {
    const prisma = makePrisma();
    prisma.academy.findUnique.mockResolvedValue(null);
    await expect(svcOf(prisma).financialOverview('ghost', 30)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('enrollmentBreakdown / coursesOverview filter by academyId, never tenantId = ctx.academyId', async () => {
    const prisma = makePrisma();
    await svcOf(prisma).enrollmentBreakdown('centerA');
    for (const call of prisma.enrollment.groupBy.mock.calls) {
      expect(call[0].where.academyId).toBe('centerA');
      expect(call[0].where.tenantId).toBeUndefined();
    }
    await svcOf(prisma).coursesOverview('centerA');
    expect(prisma.course.findMany.mock.calls[0][0].where).toEqual({ academyId: 'centerA' });
  });
});
