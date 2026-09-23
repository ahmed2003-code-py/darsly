import { randomUUID } from 'crypto';
import { databaseReady } from '../common/testing/db-available';
import { PrismaService } from './prisma.service';

/**
 * The soft-delete policy, proved against a real database.
 *
 * A mocked Prisma cannot test this at all — the whole behaviour lives in a
 * `$use` middleware rewriting `args.where`, and a stub never runs it.
 *
 * The policy has exactly two halves and they pull in opposite directions:
 *
 *  - **by primary id → hide deleted rows.** "Fetch this thing" must not return
 *    a thing that was deleted. Production held 1,438 soft-deleted rows when
 *    this was written, so ids taken from URLs really did resolve to them.
 *
 *  - **by compound/natural key → show everything.** "Does a row already occupy
 *    this key" has to include deleted rows, because the unique constraint
 *    counts them. Hiding them makes the following `create` hit P2002 and tells
 *    a student re-enrolling after a deleted enrolment that they are already
 *    enrolled.
 *
 * Both halves are asserted, because getting either one backwards is a bug and
 * only one of them is obvious.
 */
const prisma = new PrismaService();
let available = true;
const madeUsers: string[] = [];
const madeCourses: string[] = [];
let academyId = '';

let studentId = '';
let courseId = '';
let deletedCourseId = '';
let teacherId = '';

beforeAll(async () => {
  available = await databaseReady(prisma, ['course', 'enrollment', 'studentProfile', 'user', 'teacherProfile']);
  if (!available) return;
  await prisma.onModuleInit();

  const tUser = await prisma.user.create({
    data: { role: 'TEACHER', fullName: 'SD Teacher', email: `sd-t-${randomUUID()}@example.test` },
  });
  madeUsers.push(tUser.id);
  const teacher = await prisma.teacherProfile.create({
    data: { userId: tUser.id, slug: `sd-${randomUUID().slice(0, 8)}`, status: 'APPROVED' },
  });

  const sUser = await prisma.user.create({
    data: { role: 'STUDENT', fullName: 'SD Student', email: `sd-s-${randomUUID()}@example.test` },
  });
  madeUsers.push(sUser.id);
  studentId = (await prisma.studentProfile.create({ data: { userId: sUser.id } })).id;

  // Course.academyId carries a real FK, so a genuine Academy row is needed.
  academyId = (
    await prisma.academy.create({
      data: { slug: `sd-a-${randomUUID().slice(0, 8)}`, name: 'SD Academy', ownerUserId: tUser.id },
    })
  ).id;

  for (const title of ['SD live', 'SD deleted']) {
    const c = await prisma.course.create({
      data: { tenantId: teacher.id, academyId, title, priceCents: 0, status: 'PUBLISHED' },
    });
    madeCourses.push(c.id);
  }
  [courseId, deletedCourseId] = madeCourses;
  await prisma.course.delete({ where: { id: deletedCourseId } }); // soft delete
}, 30_000);

afterAll(async () => {
  if (available) {
    await prisma.course.deleteMany({ where: { id: { in: madeCourses } } }).catch(() => undefined);
    await prisma.academy.deleteMany({ where: { id: academyId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: madeUsers } } }).catch(() => undefined);
  }
  await prisma.$disconnect().catch(() => undefined);
});

const guard = () => available;

describe('soft delete — lookup by primary id hides deleted rows', () => {
  it('findUnique by id returns a live row', async () => {
    if (!guard()) return;
    expect(await prisma.course.findUnique({ where: { id: courseId } })).not.toBeNull();
  });

  /** The defect this policy closes: an id from a URL resolving to a deleted row. */
  it('findUnique by id does NOT return a deleted row', async () => {
    if (!guard()) return;
    expect(await prisma.course.findUnique({ where: { id: deletedCourseId } })).toBeNull();
  });

  it('findUniqueOrThrow by id throws for a deleted row', async () => {
    if (!guard()) return;
    await expect(prisma.course.findUniqueOrThrow({ where: { id: deletedCourseId } })).rejects.toBeDefined();
  });

  it('an explicit deletedAt still wins, so a restore/trash view can look', async () => {
    if (!guard()) return;
    const row = await prisma.course.findUnique({ where: { id: deletedCourseId, deletedAt: undefined } });
    expect(row?.id).toBe(deletedCourseId);
  });

  it('findFirst keeps hiding deleted rows, as it always did', async () => {
    if (!guard()) return;
    expect(await prisma.course.findFirst({ where: { id: deletedCourseId } })).toBeNull();
  });
});

describe('soft delete — lookup by compound key still sees everything', () => {
  /**
   * The half that is easy to get backwards. The unique constraint counts the
   * deleted row, so a lookup that hid it would report the key free, the
   * create would hit P2002, and the student would be told they are already
   * enrolled in a course they just left.
   */
  it('finds a soft-deleted enrolment by its natural key, so re-enrolment can resurrect it', async () => {
    if (!guard()) return;
    const e = await prisma.enrollment.create({
      data: { studentId, courseId, tenantId: teacherId, academyId, status: 'ACTIVE' },
    });
    await prisma.enrollment.delete({ where: { id: e.id } }); // soft delete

    const viaCompound = await prisma.enrollment.findUnique({
      where: { studentId_courseId: { studentId, courseId } },
    });
    expect(viaCompound?.id).toBe(e.id);
    expect(viaCompound?.deletedAt).not.toBeNull();

    // …while the same row is correctly hidden from a by-id fetch.
    expect(await prisma.enrollment.findUnique({ where: { id: e.id } })).toBeNull();
  });
});
