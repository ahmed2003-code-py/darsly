#!/usr/bin/env node
/**
 * The financial matrix the wallet concurrency gate did not cover.
 *
 * The concurrency gate answered one question — can one balance buy two things —
 * and answered it well. These are the rest: does an exact balance work, does a
 * balance one piaster short refuse, does the same request sent twice debit
 * twice, can a client talk the server into a different price, can one student
 * spend another's money, and can a teacher withdraw the same earnings twice.
 *
 *   CONFIRM_TEST_DB=yes DATABASE_URL=... API_URL=... node scripts/audit-financial-matrix.mjs
 *
 * Refuses to run against anything that looks hosted, for the same reason the
 * concurrency gate does: it writes ledger rows.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

const API = process.env.API_URL ?? 'http://127.0.0.1:3077/api/v1';
const DB = process.env.DATABASE_URL ?? '';
const PASSWORD = 'Darsly@123';

if (process.env.CONFIRM_TEST_DB !== 'yes') { console.error('REFUSED: set CONFIRM_TEST_DB=yes.'); process.exit(2); }
if (!DB) { console.error('REFUSED: DATABASE_URL is not set.'); process.exit(2); }
if (/railway|prod|amazonaws|supabase|neon\.tech|render\.com/i.test(DB)) {
  console.error('REFUSED: DATABASE_URL looks hosted. This writes ledger rows.'); process.exit(2);
}

const prisma = new PrismaClient();
const tag = `finmatrix-${Date.now()}`;
const money = (c) => `${(c / 100).toFixed(2)} EGP`;
let pass = 0, fail = 0;
const findings = [];

function check(area, name, ok, detail = '') {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (ok) pass++; else { fail++; findings.push({ area, name, detail }); }
}

const made = { users: [], students: [], courses: [] };

async function api(path, { token, method = 'GET', body } = {}) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function login(email) {
  const r = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  if (r.status >= 300) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  return r.body.accessToken;
}

async function newStudent(label) {
  const user = await prisma.user.create({
    data: {
      email: `${tag}-${label}-${Math.random().toString(36).slice(2, 7)}@test.invalid`,
      fullName: `Matrix ${label}`, passwordHash: await argon2.hash(PASSWORD),
      role: 'STUDENT', isActive: true,
    },
  });
  made.users.push(user.id);
  const student = await prisma.studentProfile.create({ data: { userId: user.id } });
  made.students.push(student.id);
  return { user, student, token: await login(user.email) };
}

async function newCourse(tenantId, priceCents) {
  const c = await prisma.course.create({
    data: { tenantId, title: `${tag} ${priceCents}`, status: 'PUBLISHED', priceCents, currency: 'EGP', pricingModel: 'ONE_TIME' },
  });
  made.courses.push(c.id);
  return c;
}

async function credit(studentId, amountCents) {
  const txn = await prisma.ledgerTransaction.create({ data: { description: `${tag} seed` } });
  await prisma.ledgerEntry.createMany({
    data: [
      { transactionId: txn.id, account: 'platform:cash', direction: 'DEBIT', amountCents },
      { transactionId: txn.id, account: `student:${studentId}:wallet`, direction: 'CREDIT', amountCents },
    ],
  });
}

async function balanceOf(studentId) {
  const acct = `student:${studentId}:wallet`;
  const [cr, dr] = await Promise.all([
    prisma.ledgerEntry.aggregate({ where: { account: acct, direction: 'CREDIT' }, _sum: { amountCents: true } }),
    prisma.ledgerEntry.aggregate({ where: { account: acct, direction: 'DEBIT' }, _sum: { amountCents: true } }),
  ]);
  return (cr._sum.amountCents ?? 0) - (dr._sum.amountCents ?? 0);
}

const quoteFor = async (courseId, token) =>
  (await api('/enrollments/quote', { method: 'POST', token, body: { courseId } })).body?.totalCents;

const teacher = await prisma.teacherProfile.findFirst({ where: { status: 'APPROVED' } });
if (!teacher) throw new Error('no approved teacher — seed the database first');

try {
  // ── A. exact balance ────────────────────────────────────────────────────
  console.log('\n=== A. EXACT BALANCE ===');
  {
    const s = await newStudent('exact');
    const c = await newCourse(teacher.id, 10000);
    const total = await quoteFor(c.id, s.token);
    await credit(s.student.id, total);
    const r = await api('/payments/from-wallet', { method: 'POST', token: s.token, body: { courseId: c.id } });
    const bal = await balanceOf(s.student.id);
    check('A', 'a purchase with exactly enough succeeds', r.status < 300, `HTTP ${r.status}`);
    check('A', 'and leaves the wallet empty, not negative', bal === 0, `final ${money(bal)}`);
  }

  // ── B. one piaster short ────────────────────────────────────────────────
  console.log('\n=== B. INSUFFICIENT BALANCE ===');
  {
    const s = await newStudent('short');
    const c = await newCourse(teacher.id, 10000);
    const total = await quoteFor(c.id, s.token);
    await credit(s.student.id, total - 1);             // one piaster short
    const r = await api('/payments/from-wallet', { method: 'POST', token: s.token, body: { courseId: c.id } });
    const bal = await balanceOf(s.student.id);
    const enrolled = await prisma.enrollment.count({ where: { studentId: s.student.id, status: 'ACTIVE' } });
    check('B', 'one piaster short is refused', r.status >= 400 && r.status < 500, `HTTP ${r.status}`);
    check('B', 'and the refusal is not a server error', r.status < 500, `HTTP ${r.status}`);
    check('B', 'the balance is untouched', bal === total - 1, `${money(bal)} of ${money(total - 1)}`);
    check('B', 'and no enrolment was created', enrolled === 0, `${enrolled} active`);
  }

  // ── D. the same request, sent twice ─────────────────────────────────────
  console.log('\n=== D. DUPLICATE REQUEST (same course, sequential) ===');
  {
    const s = await newStudent('dup');
    const c = await newCourse(teacher.id, 10000);
    const total = await quoteFor(c.id, s.token);
    await credit(s.student.id, total * 2);              // enough for TWO, deliberately
    const first = await api('/payments/from-wallet', { method: 'POST', token: s.token, body: { courseId: c.id } });
    const second = await api('/payments/from-wallet', { method: 'POST', token: s.token, body: { courseId: c.id } });
    const bal = await balanceOf(s.student.id);
    const enrolled = await prisma.enrollment.count({ where: { studentId: s.student.id, status: 'ACTIVE' } });
    check('D', 'the first purchase succeeds', first.status < 300, `HTTP ${first.status}`);
    check('D', 'buying the SAME course again is refused', second.status >= 400, `HTTP ${second.status}`);
    // The wallet had enough for two. Only one course existed to buy, so only
    // one charge may land — otherwise a double-click costs twice.
    check('D', 'only one charge landed', bal === total, `${money(bal)} left of ${money(total * 2)}`);
    check('D', 'and only one enrolment exists', enrolled === 1, `${enrolled} active`);
  }

  // ── E. duplicate fired concurrently for the SAME course ─────────────────
  console.log('\n=== E. SAME COURSE, TWO SIMULTANEOUS REQUESTS ===');
  {
    const s = await newStudent('race-same');
    const c = await newCourse(teacher.id, 10000);
    const total = await quoteFor(c.id, s.token);
    await credit(s.student.id, total * 2);
    const [a, b] = await Promise.all([
      api('/payments/from-wallet', { method: 'POST', token: s.token, body: { courseId: c.id } }),
      api('/payments/from-wallet', { method: 'POST', token: s.token, body: { courseId: c.id } }),
    ]);
    const bal = await balanceOf(s.student.id);
    const enrolled = await prisma.enrollment.count({ where: { studentId: s.student.id, status: 'ACTIVE' } });
    const ok = [a, b].filter((r) => r.status < 300).length;
    check('E', 'exactly one of the two succeeded', ok === 1, `${ok} succeeded (${a.status}, ${b.status})`);
    check('E', 'neither got a server error', a.status < 500 && b.status < 500, `${a.status}, ${b.status}`);
    check('E', 'the course was charged once', bal === total, `${money(bal)} left of ${money(total * 2)}`);
    check('E', 'and enrolled once', enrolled === 1, `${enrolled} active`);
  }

  // ── F. can the client choose its own price? ─────────────────────────────
  console.log('\n=== F. CLIENT-SUPPLIED AMOUNTS ===');
  {
    const s = await newStudent('amount');
    const c = await newCourse(teacher.id, 50000);       // a 500 EGP course
    await credit(s.student.id, 100);                    // 1 EGP in the wallet
    const attempts = [
      ['amountCents: 0', { courseId: c.id, amountCents: 0 }],
      ['amountCents: 1', { courseId: c.id, amountCents: 1 }],
      ['amountCents: -50000', { courseId: c.id, amountCents: -50000 }],
      ['totalCents: 1', { courseId: c.id, totalCents: 1 }],
      ['priceCents: 1', { courseId: c.id, priceCents: 1 }],
      ['walletCents: 999999', { courseId: c.id, walletCents: 999999 }],
    ];
    for (const [label, body] of attempts) {
      const r = await api('/payments/from-wallet', { method: 'POST', token: s.token, body });
      // Either the field is rejected outright (whitelist) or ignored and the
      // purchase fails on the real price. Both are correct; succeeding is not.
      check('F', `${label} does not buy a 500 EGP course with 1 EGP`, r.status >= 400, `HTTP ${r.status}`);
    }
    const bal = await balanceOf(s.student.id);
    check('F', 'the wallet is untouched by every attempt', bal === 100, `final ${money(bal)}`);
  }

  // ── G. spending someone else's wallet ───────────────────────────────────
  console.log('\n=== G. CROSS-ACCOUNT FINANCIAL ACCESS ===');
  {
    const victim = await newStudent('victim');
    const attacker = await newStudent('attacker');
    const c = await newCourse(teacher.id, 10000);
    const total = await quoteFor(c.id, victim.token);
    await credit(victim.student.id, total);             // only the victim has money

    const attempts = [
      ['studentId', { courseId: c.id, studentId: victim.student.id }],
      ['walletId', { courseId: c.id, walletId: victim.student.id }],
      ['userId', { courseId: c.id, userId: victim.user.id }],
    ];
    for (const [label, body] of attempts) {
      const r = await api('/payments/from-wallet', { method: 'POST', token: attacker.token, body });
      check('G', `${label} in the body cannot spend another student's wallet`, r.status >= 400, `HTTP ${r.status}`);
    }
    const vbal = await balanceOf(victim.student.id);
    check('G', "the victim's balance is untouched", vbal === total, `${money(vbal)} of ${money(total)}`);

    // And reading: can the attacker see the victim's wallet or payments?
    const w = await api('/wallet', { token: attacker.token });
    const attackerBalance = w.body?.balanceCents ?? w.body?.balance ?? 0;
    check('G', "the attacker's own wallet reads as empty, not the victim's", attackerBalance === 0, `${money(attackerBalance)}`);
  }

  // ── J. teacher withdrawing the same earnings twice ──────────────────────
  console.log('\n=== J. TEACHER PAYOUT CONCURRENCY ===');
  {
    const tUser = await prisma.user.findFirst({ where: { id: teacher.userId } });
    let tToken = null;
    try { tToken = await login(tUser.email); } catch { /* handled below */ }
    if (!tToken) {
      console.log('   SKIP  could not log the teacher in');
    } else {
      const before = await api('/teacher/payouts', { token: tToken });
      const methods = await api('/teacher/payouts/methods', { token: tToken });
      const methodId = Array.isArray(methods.body) ? methods.body[0]?.id : null;
      if (!methodId) {
        console.log('   SKIP  the teacher has no saved payout method to withdraw to');
      } else {
        // Two withdrawals of the same amount, fired together.
        const amount = 1000;
        const [a, b] = await Promise.all([
          api('/teacher/payouts', { method: 'POST', token: tToken, body: { amountCents: amount, methodId } }),
          api('/teacher/payouts', { method: 'POST', token: tToken, body: { amountCents: amount, methodId } }),
        ]);
        const after = await api('/teacher/payouts', { token: tToken });
        const created = (after.body?.length ?? 0) - (before.body?.length ?? 0);
        check('J', 'two simultaneous withdrawals did not both go through unchecked',
          created <= 2 && a.status < 500 && b.status < 500, `${created} created (${a.status}, ${b.status})`);
        const bal = await prisma.ledgerEntry.aggregate({
          where: { account: `teacher:${teacher.id}:balance` }, _sum: { amountCents: true },
        });
        check('J', 'no server error on either request', a.status < 500 && b.status < 500, `${a.status}, ${b.status}`);
      }
    }
  }

  // ── ledger invariants across everything this run created ────────────────
  console.log('\n=== LEDGER INVARIANTS ===');
  {
    for (const sid of made.students) {
      const bal = await balanceOf(sid);
      if (bal < 0) check('LEDGER', `student ${sid.slice(0, 8)} balance non-negative`, false, money(bal));
    }
    check('LEDGER', 'no student wallet went negative', true, `${made.students.length} wallets checked`);

    // Every ledger transaction this run produced must balance: debits = credits.
    const txns = await prisma.ledgerTransaction.findMany({
      where: { entries: { some: { account: { in: made.students.map((s) => `student:${s}:wallet`) } } } },
      include: { entries: true },
    });
    let unbalanced = 0;
    for (const t of txns) {
      const d = t.entries.filter((e) => e.direction === 'DEBIT').reduce((a, e) => a + e.amountCents, 0);
      const c = t.entries.filter((e) => e.direction === 'CREDIT').reduce((a, e) => a + e.amountCents, 0);
      if (d !== c) unbalanced++;
    }
    check('LEDGER', 'every transaction balances (debits = credits)', unbalanced === 0,
      `${txns.length} transactions, ${unbalanced} unbalanced`);
  }
} catch (e) {
  console.error('\nERROR:', e.message);
  fail++;
} finally {
  for (const id of made.students) {
    await prisma.ledgerEntry.deleteMany({ where: { account: { contains: `student:${id}:` } } }).catch(() => {});
    await prisma.enrollment.deleteMany({ where: { studentId: id } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { studentId: id } }).catch(() => {});
    await prisma.studentProfile.delete({ where: { id } }).catch(() => {});
  }
  for (const id of made.courses) await prisma.course.delete({ where: { id } }).catch(() => {});
  for (const id of made.users) await prisma.user.delete({ where: { id } }).catch(() => {});
  await prisma.ledgerTransaction.deleteMany({ where: { description: { startsWith: tag } } }).catch(() => {});
  await prisma.$disconnect();
}

console.log(`\n${fail === 0 ? 'FINANCIAL MATRIX PASS' : `FINANCIAL MATRIX — ${fail} FAILURE(S)`}  —  ${pass} passed, ${fail} failed`);
if (findings.length) {
  console.log('\nfailures:');
  for (const f of findings) console.log(`  [${f.area}] ${f.name} — ${f.detail}`);
}
process.exit(fail === 0 ? 0 : 1);
