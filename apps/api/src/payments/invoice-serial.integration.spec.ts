import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from './ledger.service';

/**
 * Invoice serials against a real database.
 *
 * Every other spec mocks `ensureInvoice`. The serial used to be derived from
 * `invoice.count()` — which the soft-delete middleware filters — so once any
 * invoice was soft-deleted the next serials were already taken and issuing
 * failed. That was only ever caught because a long-lived dev database happened
 * to hold deleted invoices; a fresh per-worker test database does not, so the
 * condition is built here on purpose.
 */
const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
let available = true;
let tenantId = '';
let courseId = '';
let studentId = '';
const madeUsers: string[] = [];

beforeAll(async () => {
  try {
    await prisma.onModuleInit();
    await prisma.invoice.count();
  } catch {
    available = false;
    return;
  }
  const user = await prisma.user.create({
    data: {
      role: 'TEACHER',
      fullName: 'QA Invoices',
      email: `qa-inv-${randomUUID()}@example.test`,
    },
  });
  madeUsers.push(user.id);
  const tp = await prisma.teacherProfile.create({
    data: { userId: user.id, slug: `qa-inv-${randomUUID().slice(0, 8)}`, status: 'APPROVED' },
  });
  tenantId = tp.id;
  await prisma.academy.create({
    data: {
      id: tp.id,
      slug: `qa-inv-${randomUUID().slice(0, 8)}`,
      name: 'QA',
      ownerUserId: user.id,
      feeValue: 0,
    },
  });
  // A payment must have exactly one target (Payment_exactly_one_target_check).
  const course = await prisma.course.create({
    data: {
      tenantId,
      academyId: tp.id,
      title: 'QA invoices',
      priceCents: 1000,
      status: 'PUBLISHED',
    },
  });
  courseId = course.id;
  // …and a course payment needs its student (Payment_student_unless_live_check).
  const su = await prisma.user.create({
    data: { role: 'STUDENT', fullName: 'QA Payer', email: `qa-inv-s-${randomUUID()}@example.test` },
  });
  madeUsers.push(su.id);
  studentId = (await prisma.studentProfile.create({ data: { userId: su.id } })).id;
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
});

const guard = () => {
  if (!available) {
    // eslint-disable-next-line no-console
    console.warn('skipping: no database reachable at DATABASE_URL');
  }
  return available;
};

const payment = () =>
  prisma.payment.create({
    data: { tenantId, courseId, studentId, amountCents: 1000, status: 'PAID', paidAt: new Date() },
  });

describe('invoice serials', () => {
  it('soft-deleted invoices keep their serials, and the next one is still issued', async () => {
    if (!guard()) return;
    const made = [];
    for (let i = 0; i < 8; i++) made.push(await ledger.ensureInvoice((await payment()).id));
    // Seven deleted: more than the six attempts a count()-derived serial gets.
    for (const inv of made.slice(0, 7)) await prisma.invoice.delete({ where: { id: inv.id } });

    const next = await ledger.ensureInvoice((await payment()).id);
    const all = await prisma.invoice.findMany({
      where: { serial: { startsWith: next.serial.slice(0, 13) }, deletedAt: undefined },
      select: { serial: true },
    });
    expect(new Set(all.map((i) => i.serial)).size).toBe(all.length);
    expect(next.serial > made[7].serial).toBe(true);
  });

  it('concurrent payments get distinct serials; one payment never gets two', async () => {
    if (!guard()) return;
    const ps = await Promise.all([payment(), payment(), payment(), payment()]);
    const issued = await Promise.all(ps.map((p) => ledger.ensureInvoice(p.id)));
    expect(new Set(issued.map((i) => i.serial)).size).toBe(4);
    const again = await ledger.ensureInvoice(ps[0].id);
    expect(again.id).toBe(issued[0].id);
  });
});
