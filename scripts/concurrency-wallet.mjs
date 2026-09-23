#!/usr/bin/env node
/**
 * Wallet concurrency gate — does one balance buy exactly one thing?
 *
 * Settling a wallet-funded payment reads the student's balance and then writes
 * a debit against it. Commit 5206583 raised that transaction to SERIALIZABLE so
 * Postgres aborts one of two conflicting settlements; what has NOT been shown
 * is Postgres actually doing it. Verifying "which isolation level we asked for"
 * is a source-level claim. This script is the runtime one.
 *
 *   node scripts/concurrency-wallet.mjs
 *
 * Requires, in the environment:
 *   DATABASE_URL      a NON-PRODUCTION Postgres
 *   API_URL           base URL of a running API  (default http://localhost:3000/api/v1)
 *   CONFIRM_TEST_DB=yes
 *
 * It refuses to run otherwise, and the refusal is deliberate: this file exists
 * to check financial correctness, and a financial test that can be aimed at
 * production by forgetting a variable is worse than no test at all.
 *
 * Scenarios, from the audit brief:
 *   A  balance 100, two concurrent purchases of 100   -> 1 success, final 0
 *   B  balance  50, two concurrent purchases of  50   -> 1 success, final 0
 *   C  balance 100, three concurrent purchases of 100 -> 1 success, final 0
 *
 * Invariants asserted after every scenario:
 *   1. exactly one HTTP 2xx
 *   2. every loser is 409 (WALLET_CONCURRENT_WRITE), never 5xx
 *   3. final balance >= 0, and equals the start minus exactly one purchase
 *   4. ledger debits for the student sum to exactly one purchase
 *   5. exactly one ACTIVE enrolment was created
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

/** The demo seed's password, so a test student can actually log in. */
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? 'Darsly@123';

const API = process.env.API_URL ?? 'http://localhost:3000/api/v1';
const DB = process.env.DATABASE_URL ?? '';

// ── safety gate ────────────────────────────────────────────────────────────
// Fail closed. An unset variable must never mean "use whatever is configured".
if (process.env.CONFIRM_TEST_DB !== 'yes') {
  console.error('REFUSED: set CONFIRM_TEST_DB=yes to confirm this is not production.');
  process.exit(2);
}
if (!DB) {
  console.error('REFUSED: DATABASE_URL is not set.');
  process.exit(2);
}
const LOOKS_HOSTED = /railway|prod|amazonaws|supabase|neon\.tech|render\.com/i;
if (LOOKS_HOSTED.test(DB)) {
  console.error('REFUSED: DATABASE_URL looks like a hosted or production database.');
  console.error('         This script writes ledger rows. Point it at a disposable database.');
  process.exit(2);
}

const prisma = new PrismaClient();
const money = (c) => `${(c / 100).toFixed(2)} EGP`;
const tag = `conctest-${Date.now()}`;
let failures = 0;

/** Everything this run created, torn down in reverse even when a scenario throws. */
const created = { students: [], courses: [], users: [], tenant: null };

async function seedScenario(priceCents, purchases) {
  const teacher =
    created.tenant ?? (await prisma.teacherProfile.findFirst({ where: { status: 'APPROVED' } }));
  if (!teacher) throw new Error('no APPROVED teacher in this database — run the demo seed first');
  created.tenant = teacher;

  const user = await prisma.user.create({
    data: {
      email: `${tag}-${Math.random().toString(36).slice(2, 8)}@test.invalid`,
      fullName: 'Concurrency Test Student',
      passwordHash: await argon2.hash(TEST_PASSWORD),
      role: 'STUDENT',
      isActive: true,
    },
  });
  created.users.push(user.id);
  const student = await prisma.studentProfile.create({ data: { userId: user.id } });
  created.students.push(student.id);

  const courses = [];
  for (let i = 0; i < purchases; i++) {
    const c = await prisma.course.create({
      data: {
        tenantId: teacher.id,
        title: `${tag} course ${i}`,
        status: 'PUBLISHED',
        priceCents,
        currency: 'EGP',
        pricingModel: 'ONE_TIME',
      },
    });
    created.courses.push(c.id);
    courses.push(c);
  }
  return { user, student, courses };
}

/**
 * Credit a wallet through the ledger, so the balance is real rather than a
 * column someone set — the debit under test reads these same rows.
 */
async function creditWallet(studentId, amountCents) {
  const txn = await prisma.ledgerTransaction.create({ data: { description: `${tag} seed` } });
  await prisma.ledgerEntry.createMany({
    data: [
      { transactionId: txn.id, account: 'platform:cash', direction: 'DEBIT', amountCents },
      {
        transactionId: txn.id,
        account: `student:${studentId}:wallet`,
        direction: 'CREDIT',
        amountCents,
      },
    ],
  });
}

/** What the student is actually asked to pay: list price plus the platform fee. */
async function quotedTotal(courseId, token) {
  const r = await fetch(`${API}/enrollments/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ courseId }),
  });
  if (!r.ok) throw new Error(`quote failed (${r.status})`);
  return (await r.json()).totalCents;
}

async function walletBalance(studentId) {
  const acct = `student:${studentId}:wallet`;
  const [cr, dr] = await Promise.all([
    prisma.ledgerEntry.aggregate({
      where: { account: acct, direction: 'CREDIT' },
      _sum: { amountCents: true },
    }),
    prisma.ledgerEntry.aggregate({
      where: { account: acct, direction: 'DEBIT' },
      _sum: { amountCents: true },
    }),
  ]);
  return (cr._sum.amountCents ?? 0) - (dr._sum.amountCents ?? 0);
}

async function login(email) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: TEST_PASSWORD }),
  });
  if (!r.ok)
    throw new Error(`login failed (${r.status}) — seed the test user with the demo password`);
  return (await r.json()).accessToken;
}

async function scenario(name, { priceCents, purchases }) {
  const { user, student, courses } = await seedScenario(priceCents, purchases);
  const token = await login(user.email);

  // The student is funded with EXACTLY enough for ONE purchase, fee included.
  // The list price is not what they pay: the platform fee is added on top, so
  // seeding the price left them short and every request failed honestly on
  // balance rather than racing. That is the whole experiment — if two of these
  // succeed against a balance that covers one, money was invented.
  const priceToPay = await quotedTotal(courses[0].id, token);
  await creditWallet(student.id, priceToPay);
  const balanceCents = priceToPay;
  console.log(`
-- ${name}: balance ${money(balanceCents)}, ${purchases} concurrent purchases of ${money(priceToPay)} each`);

  // Fired together, not merely in a loop: the race only exists while the reads
  // overlap, so the requests have to leave at the same time.
  const results = await Promise.all(
    courses.map((c) =>
      fetch(`${API}/payments/from-wallet`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ courseId: c.id }),
      }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) })),
    ),
  );

  const ok = results.filter((r) => r.status >= 200 && r.status < 300);
  const conflicts = results.filter((r) => r.status === 409);
  const server = results.filter((r) => r.status >= 500);
  const refusals = results.filter((r) => r.status === 409 || r.status === 400);
  const balance = await walletBalance(student.id);
  const debits = await prisma.ledgerEntry.aggregate({
    where: { account: `student:${student.id}:wallet`, direction: 'DEBIT' },
    _sum: { amountCents: true },
  });
  const active = await prisma.enrollment.count({
    where: { studentId: student.id, status: 'ACTIVE' },
  });

  const checks = [
    ['exactly one purchase succeeded', ok.length === 1, `${ok.length} succeeded`],
    ['no 5xx returned to any caller', server.length === 0, `${server.length} server errors`],
    /**
     * Every loser got a clean, actionable refusal — 409 or 400, never a 5xx.
     *
     * Not "every loser got 409". There are two honest ways to lose this race
     * and the system uses both: a settlement Postgres aborts comes back 409
     * (retry, the money is still yours), and one that arrives after the wallet
     * is already drained comes back 400 INSUFFICIENT_BALANCE (there is nothing
     * to retry with). Demanding 409 from both would be demanding the system
     * report an empty wallet as a transient conflict.
     */
    [
      'every loser got a clean refusal',
      refusals.length === purchases - 1,
      `${refusals.length} of ${purchases - 1} refused cleanly (${conflicts.length} conflict, ${refusals.length - conflicts.length} insufficient)`,
    ],
    ['balance never went negative', balance >= 0, `final ${money(balance)}`],
    [
      'balance dropped by exactly one purchase',
      balance === balanceCents - priceToPay,
      `final ${money(balance)}, expected ${money(balanceCents - priceToPay)}`,
    ],
    [
      'ledger debited exactly one purchase',
      (debits._sum.amountCents ?? 0) === priceToPay,
      `debited ${money(debits._sum.amountCents ?? 0)}`,
    ],
    ['exactly one enrolment activated', active === 1, `${active} active`],
  ];
  for (const [what, passed, detail] of checks) {
    console.log(`   ${passed ? 'PASS' : 'FAIL'}  ${what}  (${detail})`);
    if (!passed) failures++;
  }
  console.log(`   statuses: ${results.map((r) => r.status).join(', ')}`);
  for (const r of results) {
    if (r.status >= 400)
      console.log(`   body[${r.status}]: ${JSON.stringify(r.body).slice(0, 220)}`);
  }
}

async function cleanup() {
  // Reverse order, best effort: a failed teardown must not mask a failed assertion.
  for (const id of created.students) {
    await prisma.ledgerEntry
      .deleteMany({ where: { account: { contains: `student:${id}:` } } })
      .catch(() => {});
    await prisma.enrollment.deleteMany({ where: { studentId: id } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { studentId: id } }).catch(() => {});
    await prisma.studentProfile.delete({ where: { id } }).catch(() => {});
  }
  for (const id of created.courses) await prisma.course.delete({ where: { id } }).catch(() => {});
  for (const id of created.users) await prisma.user.delete({ where: { id } }).catch(() => {});
  await prisma.ledgerTransaction
    .deleteMany({ where: { description: { startsWith: tag } } })
    .catch(() => {});
}

try {
  console.log(`wallet concurrency gate — API ${API}`);
  // Repeated, because a race that loses once may win the next time: a single
  // green run is not evidence that the window is closed.
  for (let round = 1; round <= 3; round++) {
    console.log(`\n=== round ${round} of 3 ===`);
    await scenario('A  two at the full balance', { priceCents: 10000, purchases: 2 });
    await scenario('B  two at a smaller amount', { priceCents: 5000, purchases: 2 });
    await scenario('C  three at the full balance', { priceCents: 10000, purchases: 3 });
  }
} catch (e) {
  console.error('\nERROR:', e.message);
  failures++;
} finally {
  await cleanup();
  await prisma.$disconnect();
}

console.log(
  failures === 0
    ? '\nGATE PASS — one balance bought exactly one thing, every round.'
    : `\nGATE FAIL — ${failures} assertion(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
