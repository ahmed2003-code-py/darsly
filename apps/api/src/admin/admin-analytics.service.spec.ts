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
    const svc = new AdminAnalyticsService(prisma, ledger);

    const trend = await svc.growthTrend(30);
    expect(trend).toEqual([{ date: today.toISOString().slice(0, 10), academies: 2, students: 5, enrollments: 9 }]);
  });

  it('revenueTrend delegates to LedgerService.revenueTrend with the same range', async () => {
    const prisma: any = {};
    const ledger: any = { revenueTrend: jest.fn().mockResolvedValue([{ date: '2026-01-01', grossCents: 100, feeCents: 20 }]) };
    const svc = new AdminAnalyticsService(prisma, ledger);

    const trend = await svc.revenueTrend(7);
    expect(ledger.revenueTrend).toHaveBeenCalledWith(7);
    expect(trend).toEqual([{ date: '2026-01-01', grossCents: 100, feeCents: 20 }]);
  });
});
