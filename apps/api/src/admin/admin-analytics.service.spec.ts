import { AdminAnalyticsService, isGrowthRange } from './admin-analytics.service';

describe('isGrowthRange', () => {
  it('accepts only 7, 30, 90', () => {
    expect(isGrowthRange(7)).toBe(true);
    expect(isGrowthRange(30)).toBe(true);
    expect(isGrowthRange(90)).toBe(true);
    expect(isGrowthRange(31)).toBe(false);
    expect(isGrowthRange('30')).toBe(false);
    expect(isGrowthRange(undefined)).toBe(false);
  });
});

describe('AdminAnalyticsService', () => {
  it('growthTrend zero-fills and converts bigint counts to numbers', async () => {
    const today = new Date();
    const prisma: any = { $queryRaw: jest.fn().mockResolvedValue([{ day: today, academies: 2n, students: 5n, enrollments: 9n }]) };
    const ledger: any = {};
    const analytics: any = {};
    const svc = new AdminAnalyticsService(prisma, ledger, analytics);

    const trend = await svc.growthTrend(30);
    expect(trend).toEqual([{ date: today.toISOString().slice(0, 10), academies: 2, students: 5, enrollments: 9 }]);
  });

  it('revenueTrend delegates to LedgerService.revenueTrend with the same range', async () => {
    const prisma: any = {};
    const ledger: any = { revenueTrend: jest.fn().mockResolvedValue([{ date: '2026-01-01', grossCents: 100, feeCents: 20 }]) };
    const analytics: any = {};
    const svc = new AdminAnalyticsService(prisma, ledger, analytics);

    const trend = await svc.revenueTrend(7);
    expect(ledger.revenueTrend).toHaveBeenCalledWith(7);
    expect(trend).toEqual([{ date: '2026-01-01', grossCents: 100, feeCents: 20 }]);
  });

  it('attendanceAggregate delegates to AnalyticsService.attendanceStats with null ctx/tenantId', async () => {
    const prisma: any = {};
    const ledger: any = {};
    const analytics: any = { attendanceStats: jest.fn().mockResolvedValue({ attendanceRatePct: 88 }) };
    const svc = new AdminAnalyticsService(prisma, ledger, analytics);

    const result = await svc.attendanceAggregate(30);
    expect(analytics.attendanceStats).toHaveBeenCalledWith(null, null, 30);
    expect(result).toEqual({ attendanceRatePct: 88 });
  });

  it('financialOverview computes payment conversion from decided submissions only', async () => {
    const prisma: any = {
      payment: {
        groupBy: jest.fn().mockResolvedValue([
          { status: 'PAID', _count: { _all: 6 } },
          { status: 'PENDING', _count: { _all: 3 } },
          { status: 'REJECTED', _count: { _all: 2 } },
        ]),
      },
    };
    const ledger: any = { platformTotals: jest.fn().mockResolvedValue({ grossCents: 1000, commissionCents: 200 }) };
    const analytics: any = {};
    const svc = new AdminAnalyticsService(prisma, ledger, analytics);

    const result = await svc.financialOverview(30);
    // 6 paid / (6 paid + 2 rejected) = 75%, the 3 still-pending submissions
    // excluded from the denominator since they haven't been decided yet.
    expect(result.paymentConversion).toEqual({ paid: 6, pending: 3, rejected: 2, convertedPct: 75 });
    expect(result.grossCents).toBe(1000);
    expect(result.commissionCents).toBe(200);
  });

  it('activeAcademyRate counts only ACTIVE academies with a recent enrollment', async () => {
    const prisma: any = {
      enrollment: {
        findMany: jest.fn().mockResolvedValue([{ tenantId: 'a1' }, { tenantId: 'a2' }]),
      },
      academy: {
        count: jest.fn().mockResolvedValueOnce(5).mockResolvedValueOnce(2),
      },
    };
    const ledger: any = {};
    const analytics: any = {};
    const svc = new AdminAnalyticsService(prisma, ledger, analytics);

    const result = await svc.activeAcademyRate(7);
    expect(result).toEqual({ rangeDays: 7, totalActiveAcademies: 5, academiesWithRecentEnrollment: 2, ratePct: 40 });
  });
});
