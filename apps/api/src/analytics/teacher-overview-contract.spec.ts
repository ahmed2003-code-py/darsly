import { AnalyticsService } from './analytics.service';

/**
 * The response contract of `teacherOverview`, which had no test before it was
 * rewritten.
 *
 * The rewrite replaced four unbounded table reads with SUM/COUNT/GROUP BY.
 * That is an internal change by intent, so the thing most worth asserting is
 * that it stayed internal: the same keys, the same types, and — the part a
 * refactor is most likely to get wrong — the same *meaning*. `grossCents` and
 * `totalEnrollments` are all-time figures and must not quietly become
 * six-month figures just because the charts beside them are.
 */
function makePrisma(over: Record<string, unknown> = {}) {
  const prisma: any = {
    payment: {
      aggregate: jest
        .fn()
        .mockResolvedValueOnce({ _sum: { netCents: 800 } }) // rows that carry a net
        .mockResolvedValueOnce({ _sum: { amountCents: 500 } }), // rows that do not
      findMany: jest.fn().mockResolvedValue([]),
    },
    enrollment: {
      count: jest.fn().mockResolvedValueOnce(9).mockResolvedValueOnce(2),
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest
        .fn()
        .mockResolvedValueOnce([{ studentId: 's1' }, { studentId: 's2' }]) // distinct active students
        .mockResolvedValueOnce([{ courseId: 'c1', _count: { _all: 2 } }]), // active per course
    },
    review: { aggregate: jest.fn().mockResolvedValue({ _avg: { rating: 4.26 }, _count: 7 }) },
    quizAttempt: { count: jest.fn().mockResolvedValueOnce(10).mockResolvedValueOnce(6) },
    lessonProgress: { count: jest.fn().mockResolvedValue(4), groupBy: jest.fn().mockResolvedValue([]) },
    courseUnit: { findMany: jest.fn().mockResolvedValue([{ courseId: 'c1', _count: { lessons: 5 } }]) },
    lesson: { groupBy: jest.fn().mockResolvedValue([]), findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    ...over,
  };
  return prisma;
}

const svc = (prisma: any) =>
  new AnalyticsService(prisma, {} as any, {} as any, {} as any, {} as any);

describe('teacherOverview — response contract', () => {
  it('returns every documented key, with the expected types', async () => {
    const prisma = makePrisma();
    const out = await svc(prisma).teacherOverview('tenant1');

    expect(Object.keys(out).sort()).toEqual(
      [
        'activeStudents',
        'avgRating',
        'completionRatePct',
        'enrollmentsByMonth',
        'grossCents',
        'pendingEnrollments',
        'quizPassRatePct',
        'reviewsCount',
        'revenueByMonth',
        'topLessons',
        'totalEnrollments',
      ].sort(),
    );
    expect(typeof out.grossCents).toBe('number');
    expect(typeof out.activeStudents).toBe('number');
    expect(Array.isArray(out.revenueByMonth)).toBe(true);
    expect(out.revenueByMonth).toHaveLength(6);
    expect(out.enrollmentsByMonth).toHaveLength(6);
  });

  it('grossCents adds the net-bearing rows to the fallback rows', async () => {
    const prisma = makePrisma();
    const out = await svc(prisma).teacherOverview('tenant1');

    expect(out.grossCents).toBe(1300); // 800 + 500
  });

  /**
   * The behavioural guarantee that was explicitly agreed: the charts show six
   * months, the totals do not. A totals query that grew a date filter would be
   * a silent change to what a teacher believes they have earned.
   */
  it('totals are all-time — the count queries carry no date filter', async () => {
    const prisma = makePrisma();
    await svc(prisma).teacherOverview('tenant1');

    for (const call of prisma.enrollment.count.mock.calls) {
      expect(JSON.stringify(call[0])).not.toContain('createdAt');
    }
    for (const call of prisma.payment.aggregate.mock.calls) {
      expect(JSON.stringify(call[0])).not.toContain('paidAt');
      expect(JSON.stringify(call[0])).not.toContain('createdAt');
    }
  });

  it('the series queries ARE windowed, so they never read the whole table', async () => {
    const prisma = makePrisma();
    await svc(prisma).teacherOverview('tenant1');

    expect(JSON.stringify(prisma.payment.findMany.mock.calls[0][0])).toContain('gte');
    expect(JSON.stringify(prisma.enrollment.findMany.mock.calls[0][0])).toContain('gte');
  });

  it('a teacher with no data gets zeroes rather than NaN', async () => {
    const prisma = makePrisma({
      payment: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { netCents: null, amountCents: null } }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      enrollment: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      review: { aggregate: jest.fn().mockResolvedValue({ _avg: { rating: null }, _count: 0 }) },
      quizAttempt: { count: jest.fn().mockResolvedValue(0) },
    });

    const out = await svc(prisma).teacherOverview('tenant1');

    expect(out.grossCents).toBe(0);
    expect(out.activeStudents).toBe(0);
    expect(out.completionRatePct).toBe(0);
    expect(out.quizPassRatePct).toBe(0);
    expect(out.avgRating).toBeNull();
    expect(Number.isNaN(out.completionRatePct)).toBe(false);
  });

  it('quizPassRatePct is passed ÷ attempted, counted in the database', async () => {
    const prisma = makePrisma();
    const out = await svc(prisma).teacherOverview('tenant1');

    expect(out.quizPassRatePct).toBe(60); // 6 of 10
  });
});
