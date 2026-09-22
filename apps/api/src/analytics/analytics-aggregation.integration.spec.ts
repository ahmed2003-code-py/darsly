import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Does the database compute the same numbers the application used to?
 *
 * The Tier-1 conversion replaced four kinds of in-memory arithmetic with SQL:
 * `rows.reduce(sum)` became `aggregate`, `new Set(rows.map(id)).size` and
 * `distinct + .length` became `groupBy`, and `rows.filter(...).length` became
 * `count`. Each of those is *obviously* equivalent right up until it is not —
 * NULLs, soft-deleted rows and duplicate pairs are exactly where the two
 * disagree, and a mocked Prisma will agree with whatever the code believes.
 *
 * So the numbers are computed both ways, against a real Postgres, on data
 * built to contain the awkward cases: a payment with a null `netCents`, a
 * student enrolled in two courses, and a soft-deleted enrollment.
 */
const prisma = new PrismaService();
let available = true;

const madeUsers: string[] = [];
const madeCourses: string[] = [];
let tenantId = '';
let academyId = '';

async function seed() {
  // A teacher, with an academy of the same id — the convention `tenantId ===
  // academyId` for a PERSONAL workspace.
  const teacherUser = await prisma.user.create({
    data: { role: 'TEACHER', fullName: 'QA Teacher', email: `qa-t-${randomUUID()}@example.test` },
  });
  madeUsers.push(teacherUser.id);
  const teacher = await prisma.teacherProfile.create({
    data: { userId: teacherUser.id, slug: `qa-${randomUUID().slice(0, 8)}`, status: 'APPROVED' },
  });
  tenantId = teacher.id;
  academyId = teacher.id;

  const courses = [];
  for (const title of ['A', 'B']) {
    const c = await prisma.course.create({
      data: { tenantId, academyId, title: `QA ${title}`, priceCents: 1000, status: 'PUBLISHED' },
    });
    madeCourses.push(c.id);
    courses.push(c);
  }

  // Two students; the first takes both courses, so distinct-student and
  // enrollment counts must differ. The third enrollment is soft-deleted and
  // must be invisible to every figure.
  const students = [];
  for (const n of ['One', 'Two']) {
    const u = await prisma.user.create({
      data: { role: 'STUDENT', fullName: `QA ${n}`, email: `qa-s-${randomUUID()}@example.test` },
    });
    madeUsers.push(u.id);
    students.push(await prisma.studentProfile.create({ data: { userId: u.id } }));
  }

  const mk = (studentId: string, courseId: string, status: any) =>
    prisma.enrollment.create({ data: { studentId, courseId, tenantId, academyId, status } });

  await mk(students[0].id, courses[0].id, 'ACTIVE');
  await mk(students[0].id, courses[1].id, 'ACTIVE');
  await mk(students[1].id, courses[0].id, 'PENDING_PAYMENT');
  const doomed = await prisma.enrollment.create({
    data: { studentId: students[1].id, courseId: courses[1].id, tenantId, academyId, status: 'ACTIVE' },
  });
  await prisma.enrollment.delete({ where: { id: doomed.id } }); // soft delete

  // One payment carries netCents, one does not — the `netCents ?? amountCents`
  // branch the split aggregate has to reproduce.
  await prisma.payment.create({
    data: {
      studentId: students[0].id, courseId: courses[0].id, tenantId, academyId,
      amountCents: 1000, netCents: 800, status: 'PAID', method: 'WALLET', paidAt: new Date(),
    },
  });
  await prisma.payment.create({
    data: {
      studentId: students[1].id, courseId: courses[0].id, tenantId, academyId,
      amountCents: 500, netCents: null, status: 'PAID', method: 'WALLET', paidAt: new Date(),
    },
  });
}

beforeAll(async () => {
  try {
    await prisma.$connect();
    await prisma.enrollment.count();
    await seed();
  } catch {
    available = false;
  }
}, 30_000);

afterAll(async () => {
  if (available) {
    await prisma.course.deleteMany({ where: { id: { in: madeCourses } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: madeUsers } } }).catch(() => undefined);
  }
  await prisma.$disconnect().catch(() => undefined);
});

const guard = () => {
  if (!available) {
    // eslint-disable-next-line no-console
    console.warn('skipping: no database reachable at DATABASE_URL');
  }
  return available;
};

describe('Tier-1 aggregation — database result equals the old in-memory result', () => {
  it('grossCents: split SUM equals reduce(netCents ?? amountCents)', async () => {
    if (!guard()) return;
    const paid = { tenantId, status: 'PAID' as const };

    const rows = await prisma.payment.findMany({ where: paid, select: { amountCents: true, netCents: true } });
    const inMemory = rows.reduce((s, p) => s + (p.netCents ?? p.amountCents), 0);

    const [net, fallback] = await Promise.all([
      prisma.payment.aggregate({ where: { ...paid, netCents: { not: null } }, _sum: { netCents: true } }),
      prisma.payment.aggregate({ where: { ...paid, netCents: null }, _sum: { amountCents: true } }),
    ]);
    const inDatabase = (net._sum.netCents ?? 0) + (fallback._sum.amountCents ?? 0);

    expect(inDatabase).toBe(inMemory);
    expect(inDatabase).toBe(1300); // 800 (net) + 500 (no net → amount)
  });

  it('activeStudents: groupBy length equals Set(studentId).size', async () => {
    if (!guard()) return;
    const rows = await prisma.enrollment.findMany({
      where: { tenantId, status: 'ACTIVE' },
      select: { studentId: true },
    });
    const inMemory = new Set(rows.map((r) => r.studentId)).size;

    const grouped = await prisma.enrollment.groupBy({ by: ['studentId'], where: { tenantId, status: 'ACTIVE' } });

    expect(grouped.length).toBe(inMemory);
    // The point of the fixture: one student, two active enrollments.
    expect(rows.length).toBe(2);
    expect(grouped.length).toBe(1);
  });

  it('per-course counts reproduce the completion denominator exactly', async () => {
    if (!guard()) return;
    const rows = await prisma.enrollment.findMany({
      where: { tenantId, status: 'ACTIVE' },
      select: { courseId: true },
    });
    const lessonsPerCourse: Record<string, number> = { [madeCourses[0]]: 3, [madeCourses[1]]: 7 };
    const inMemory = rows.reduce((s, e) => s + (lessonsPerCourse[e.courseId] ?? 0), 0);

    const grouped = await prisma.enrollment.groupBy({
      by: ['courseId'],
      where: { tenantId, status: 'ACTIVE' },
      _count: { _all: true },
    });
    const inDatabase = grouped.reduce((s, c) => s + (lessonsPerCourse[c.courseId] ?? 0) * c._count._all, 0);

    expect(inDatabase).toBe(inMemory);
    expect(inDatabase).toBe(10);
  });

  it('totalEnrollments / pendingEnrollments: count equals length and filter().length', async () => {
    if (!guard()) return;
    const rows = await prisma.enrollment.findMany({ where: { tenantId }, select: { status: true } });

    const [total, pending] = await Promise.all([
      prisma.enrollment.count({ where: { tenantId } }),
      prisma.enrollment.count({ where: { tenantId, status: 'PENDING_PAYMENT' } }),
    ]);

    expect(total).toBe(rows.length);
    expect(pending).toBe(rows.filter((r) => r.status === 'PENDING_PAYMENT').length);
  });

  /**
   * The failure mode that would be silent: `groupBy` is a READ_ACTION, so the
   * soft-delete middleware filters it the same way it filtered `findMany`. A
   * `$queryRaw` aggregate would not have been, and the deleted enrollment
   * would have started counting.
   */
  it('groupBy excludes soft-deleted rows, exactly as findMany did', async () => {
    if (!guard()) return;
    const grouped = await prisma.enrollment.groupBy({ by: ['studentId'], where: { tenantId } });
    const visible = await prisma.enrollment.findMany({ where: { tenantId }, select: { studentId: true } });

    expect(grouped.length).toBe(new Set(visible.map((r) => r.studentId)).size);

    // Prove the row really is there and really is hidden.
    const withDeleted = await prisma.enrollment.findMany({
      where: { tenantId, deletedAt: { not: null } },
      select: { id: true },
    });
    expect(withDeleted.length).toBe(1);
    expect(visible.length).toBe(3); // the fourth is soft-deleted
  });

  it('an empty tenant yields zeroes, not NaN or undefined', async () => {
    if (!guard()) return;
    const empty = `tenant-${randomUUID()}`;

    const [sum, grouped, count] = await Promise.all([
      prisma.payment.aggregate({ where: { tenantId: empty, status: 'PAID', netCents: { not: null } }, _sum: { netCents: true } }),
      prisma.enrollment.groupBy({ by: ['studentId'], where: { tenantId: empty } }),
      prisma.enrollment.count({ where: { tenantId: empty } }),
    ]);

    expect(sum._sum.netCents ?? 0).toBe(0);
    expect(grouped.length).toBe(0);
    expect(count).toBe(0);
  });
});
