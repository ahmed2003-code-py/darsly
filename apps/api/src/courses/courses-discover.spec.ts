import { SubjectExclusivityService } from '../catalog/subject-exclusivity.service';
import { PrismaService } from '../prisma/prisma.service';
import { StudentPriceService } from '../payments/student-price.service';
import { CoursesService } from './courses.service';

/**
 * Course discovery.
 *
 * The catalogue had a detail endpoint and no listing, so a published course was
 * reachable only by someone who already knew its teacher. A teacher could
 * publish, look for their work on the platform, and not find it — which is what
 * this is here to stop happening again.
 *
 * The other half is that every filter has to resolve in SQL. The teacher
 * directory filters price and rating in memory over the whole table; the same
 * approach here would load the entire catalogue to show ten cards.
 */

function build(rows: unknown[] = [], total = rows.length) {
  const calls: { where?: unknown; orderBy?: unknown; skip?: number; take?: number } = {};
  const prisma = {
    course: {
      count: jest.fn().mockResolvedValue(total),
      findMany: jest.fn(async (args: Record<string, unknown>) => {
        Object.assign(calls, args);
        return rows;
      }),
    },
    review: { groupBy: jest.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;
  const price = {
    applyToMany: jest.fn(async (items: unknown[]) => items),
  } as unknown as StudentPriceService;
  // Nothing is hidden here: exclusivity has its own suite, and letting it
  // return anything would make every assertion below depend on it.
  const openToEveryone = { hiddenTeacherIds: jest.fn().mockResolvedValue([]) } as unknown as SubjectExclusivityService;
  return { service: new CoursesService(prisma, price, openToEveryone), prisma, calls };
}

const course = (over: Record<string, unknown> = {}) => ({
  id: 'c1', tenantId: 't1', title: 'test', description: '', thumbnailUrl: null,
  subject: null, grade: null, pricingModel: 'ONE_TIME', priceCents: 10000, currency: 'EGP',
  createdAt: new Date(0),
  units: [{ lessons: [{ durationSec: 600, isFreePreview: true }] }],
  _count: { enrollments: 3 },
  teacher: { id: 't1', slug: 'ahmed', language: 'ar', verifiedAt: new Date(0), user: { fullName: 'Ahmed', avatarUrl: null } },
  ...over,
});

describe('a published course is findable', () => {
  it('returns it with everything a card needs', async () => {
    const { service } = build([course()]);
    const res = await service.discover({});
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      id: 'c1',
      title: 'test',
      lessonsCount: 1,
      totalDurationSec: 600,
      freePreviewCount: 1,
      studentsCount: 3,
      teacher: { slug: 'ahmed', fullName: 'Ahmed', verified: true },
    });
  });

  it('never leaks the tenant id to a student', async () => {
    const { service } = build([course()]);
    const res = await service.discover({});
    expect(res.items[0]).not.toHaveProperty('tenantId');
  });

  it('shows only published, undeleted courses', async () => {
    const { service, calls } = build();
    await service.discover({});
    expect(calls.where).toMatchObject({ status: 'PUBLISHED', deletedAt: null });
  });

  it('takes the teacher\'s catalogue with them when they are suspended', async () => {
    const { service, calls } = build();
    await service.discover({});
    expect(calls.where).toMatchObject({ teacher: { status: 'APPROVED', user: { isActive: true } } });
  });
});

describe('every filter resolves in the database', () => {
  const whereFor = async (q: Parameters<CoursesService['discover']>[0]) => {
    const { service, calls } = build();
    await service.discover(q);
    return calls.where as Record<string, unknown>;
  };

  it('filters subject, grade and teacher', async () => {
    expect(await whereFor({ subjectId: 's1', gradeId: 'g1', teacherId: 't9' })).toMatchObject({
      subjectId: 's1', gradeId: 'g1', tenantId: 't9',
    });
  });

  it('filters teaching language through the teacher', async () => {
    expect(await whereFor({ language: 'en' })).toMatchObject({ teacher: { language: 'en' } });
  });

  it('searches the title, the description and the teacher\'s name', async () => {
    const where = await whereFor({ q: ' algebra ' });
    expect(where.OR).toHaveLength(3);
    expect(JSON.stringify(where.OR)).toContain('algebra');
    // Trimmed, and case-insensitive — a student typing "Algebra" finds it.
    expect(JSON.stringify(where.OR)).not.toContain(' algebra ');
    expect(JSON.stringify(where.OR)).toContain('insensitive');
  });

  it('ignores an empty search rather than matching everything against ""', async () => {
    expect(await whereFor({ q: '   ' })).not.toHaveProperty('OR');
  });

  it('filters a price range', async () => {
    expect(await whereFor({ priceMinCents: 1000, priceMaxCents: 5000 })).toMatchObject({
      priceCents: { gte: 1000, lte: 5000 },
    });
  });

  it('lets free override the range rather than contradict it', async () => {
    expect(await whereFor({ free: true, priceMinCents: 1000 })).toMatchObject({ priceCents: { equals: 0 } });
  });

  it('finds courses that let you watch something first', async () => {
    const where = await whereFor({ hasPreview: true });
    expect(JSON.stringify(where.units)).toContain('isFreePreview');
  });
});

describe('paging', () => {
  it('defaults to ten a page', async () => {
    const { service, calls } = build([], 42);
    const res = await service.discover({});
    expect(calls.take).toBe(10);
    expect(calls.skip).toBe(0);
    expect(res).toMatchObject({ page: 1, pageSize: 10, total: 42, pages: 5 });
  });

  it('skips by page', async () => {
    const { calls } = build();
    const { service, calls: c2 } = build();
    await service.discover({ page: 3, pageSize: 10 });
    expect(c2.skip).toBe(20);
    expect(calls).toEqual({});
  });

  it('caps the page size so one request cannot ask for the catalogue', async () => {
    const { service, calls } = build();
    await service.discover({ pageSize: 5000 });
    expect(calls.take).toBe(24);
  });

  it('never returns a page below one', async () => {
    const { service, calls } = build();
    await service.discover({ page: -4 });
    expect(calls.skip).toBe(0);
  });

  it('reports at least one page for an empty catalogue', async () => {
    const { service } = build([], 0);
    expect((await service.discover({})).pages).toBe(1);
  });
});

describe('sorting', () => {
  const orderFor = async (sort: Parameters<CoursesService['discover']>[0]['sort']) => {
    const { service, calls } = build();
    await service.discover({ sort });
    return calls.orderBy;
  };

  it('orders newest first by default', async () => {
    expect(await orderFor(undefined)).toEqual({ createdAt: 'desc' });
  });

  it('orders by price in the database, both ways', async () => {
    expect(await orderFor('priceAsc')).toEqual({ priceCents: 'asc' });
    expect(await orderFor('priceDesc')).toEqual({ priceCents: 'desc' });
  });

  it('orders by enrolment count in the database', async () => {
    expect(await orderFor('popular')).toEqual({ enrollments: { _count: 'desc' } });
  });
});

describe('ratings', () => {
  it('asks for the whole page in one query rather than one per card', async () => {
    const { service, prisma } = build([course({ id: 'a' }), course({ id: 'b' }), course({ id: 'c' })]);
    await service.discover({});
    expect((prisma.review.groupBy as jest.Mock)).toHaveBeenCalledTimes(1);
    expect((prisma.review.groupBy as jest.Mock).mock.calls[0][0].where.courseId.in).toEqual(['a', 'b', 'c']);
  });

  it('asks for nothing at all when the page is empty', async () => {
    const { service, prisma } = build([]);
    await service.discover({});
    expect(prisma.review.groupBy).not.toHaveBeenCalled();
  });
});

describe('prices carry the platform fee', () => {
  it('runs every card through the student price service', async () => {
    const price = jest.fn(async (items: unknown[]) => items);
    const prisma = {
      course: { count: jest.fn().mockResolvedValue(1), findMany: jest.fn().mockResolvedValue([course()]) },
      review: { groupBy: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const service = new CoursesService(
      prisma,
      { applyToMany: price } as unknown as StudentPriceService,
      { hiddenTeacherIds: jest.fn().mockResolvedValue([]) } as unknown as SubjectExclusivityService,
    );
    await service.discover({});
    // The card and the checkout must agree, and the academy's own price must not
    // be derivable by subtracting one from the other.
    expect(price).toHaveBeenCalledTimes(1);
  });
});

/**
 * The rival teachers a student must not be shown.
 *
 * The rule itself is tested in SubjectExclusivityService; what matters here is
 * that its answer reaches the SQL, and that it composes with the filter a
 * student is most likely to have on at the time.
 */
describe('a student is not shown the catalogues of their teacher\'s rivals', () => {
  function buildWith(hidden: string[]) {
    const calls: { where?: Record<string, unknown> } = {};
    const prisma = {
      course: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn(async (args: Record<string, unknown>) => {
          Object.assign(calls, args);
          return [];
        }),
      },
      review: { groupBy: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const service = new CoursesService(
      prisma,
      { applyToMany: jest.fn(async (i: unknown[]) => i) } as unknown as StudentPriceService,
      { hiddenTeacherIds: jest.fn().mockResolvedValue(hidden) } as unknown as SubjectExclusivityService,
    );
    return { service, calls };
  }

  it('excludes them from the query', async () => {
    const { service, calls } = buildWith(['rival_a', 'rival_b']);
    await service.discover({}, 'u1');
    expect(calls.where?.tenantId).toEqual({ notIn: ['rival_a', 'rival_b'] });
  });

  it('adds no clause at all when there is nobody to hide', async () => {
    // The common case — anonymous visitors and new students — must not pay for
    // a filter, and `notIn: []` is not a filter worth generating.
    const { service, calls } = buildWith([]);
    await service.discover({}, 'u1');
    expect(calls.where?.tenantId).toBeUndefined();
  });

  it('still narrows to one teacher when asked for that teacher', async () => {
    // Both conditions land on `tenantId`. Spread separately, the second silently
    // drops the first and "this teacher's courses" quietly becomes "everyone
    // except the rivals".
    const { service, calls } = buildWith(['rival_a']);
    await service.discover({ teacherId: 'mine' }, 'u1');
    expect(calls.where?.tenantId).toEqual({ equals: 'mine', notIn: ['rival_a'] });
  });
});
