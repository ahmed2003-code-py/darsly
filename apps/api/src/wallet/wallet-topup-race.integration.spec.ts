import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * One pending top-up per student — the claim the index makes, not the one the
 * application's SELECT makes.
 *
 * This has to run against Postgres because a partial unique index is the whole
 * mechanism. A mocked Prisma would let both inserts through and agree that the
 * code was correct.
 *
 * What makes it worth enforcing: each top-up carries a transfer receipt an
 * admin approves, so two pending rows for one transfer is a wallet credited
 * twice.
 */
const prisma = new PrismaService();
let available = true;
const madeUsers: string[] = [];

async function makeStudent() {
  const user = await prisma.user.create({
    data: { role: 'STUDENT', fullName: 'QA Topup', email: `qa-w-${randomUUID()}@example.test` },
  });
  madeUsers.push(user.id);
  return prisma.studentProfile.create({ data: { userId: user.id } });
}

const topup = (studentId: string) => ({
  studentId,
  amountCents: 10_000,
  method: 'INSTAPAY' as const,
  proofImageUrl: `proofs/${randomUUID()}.jpg`,
  status: 'PENDING' as const,
});

beforeAll(async () => {
  try {
    await prisma.$connect();
    await prisma.walletTopup.count();
  } catch {
    available = false;
  }
});

afterAll(async () => {
  if (available && madeUsers.length) {
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

describe('WalletTopup — one pending per student', () => {
  it('refuses a second pending top-up', async () => {
    if (!guard()) return;
    const student = await makeStudent();
    await prisma.walletTopup.create({ data: topup(student.id) });

    await expect(prisma.walletTopup.create({ data: topup(student.id) })).rejects.toMatchObject({
      code: 'P2002',
    });
  });

  /**
   * The race the application's SELECT-then-INSERT cannot close.
   */
  it('two simultaneous submits — exactly one survives', async () => {
    if (!guard()) return;
    const student = await makeStudent();

    const results = await Promise.allSettled([
      prisma.walletTopup.create({ data: topup(student.id) }),
      prisma.walletTopup.create({ data: topup(student.id) }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await prisma.walletTopup.count({ where: { studentId: student.id, status: 'PENDING' } }),
    ).toBe(1);
  });

  it('allows a new top-up once the previous one is decided', async () => {
    if (!guard()) return;
    const student = await makeStudent();
    const first = await prisma.walletTopup.create({ data: topup(student.id) });
    await prisma.walletTopup.update({ where: { id: first.id }, data: { status: 'APPROVED' } });

    await expect(prisma.walletTopup.create({ data: topup(student.id) })).resolves.toBeDefined();
  });

  /**
   * The second half of the partial condition. WalletTopup is soft-deleted and
   * every application read is filtered by the middleware, so a deleted pending
   * row must not block a new one — the student would be refused for a reason
   * nobody could see.
   */
  it('a soft-deleted pending top-up does not block a new one', async () => {
    if (!guard()) return;
    const student = await makeStudent();
    const first = await prisma.walletTopup.create({ data: topup(student.id) });
    await prisma.walletTopup.delete({ where: { id: first.id } }); // soft delete

    await expect(prisma.walletTopup.create({ data: topup(student.id) })).resolves.toBeDefined();
  });

  it('two different students are unaffected by each other', async () => {
    if (!guard()) return;
    const [a, b] = [await makeStudent(), await makeStudent()];

    await expect(prisma.walletTopup.create({ data: topup(a.id) })).resolves.toBeDefined();
    await expect(prisma.walletTopup.create({ data: topup(b.id) })).resolves.toBeDefined();
  });
});
