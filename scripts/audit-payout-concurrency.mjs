#!/usr/bin/env node
/**
 * Can a teacher withdraw the same earnings twice?
 *
 * The payout path has always been SERIALIZABLE, with a comment saying why —
 * and until now that was a claim about the source, never a measurement. It is
 * the same hazard the student wallet had: read the balance, check it, insert a
 * row against it. Two requests that overlap can both read the same balance.
 *
 *   CONFIRM_TEST_DB=yes DATABASE_URL=... API_URL=... node scripts/audit-payout-concurrency.mjs
 *
 * Money is created only in the ledger of a disposable database, and the teacher
 * used is a throwaway academy created and deleted by this script.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

const API = process.env.API_URL ?? 'http://127.0.0.1:3077/api/v1';
const DB = process.env.DATABASE_URL ?? '';
const PASSWORD = 'Darsly@123';

if (process.env.CONFIRM_TEST_DB !== 'yes') { console.error('REFUSED: set CONFIRM_TEST_DB=yes.'); process.exit(2); }
if (!DB) { console.error('REFUSED: DATABASE_URL is not set.'); process.exit(2); }
if (/railway|prod|amazonaws|supabase|neon\.tech|render\.com/i.test(DB)) {
  console.error('REFUSED: DATABASE_URL looks hosted.'); process.exit(2);
}

const prisma = new PrismaClient();
const tag = `payout-${Date.now()}`;
const money = (c) => `${(c / 100).toFixed(2)} EGP`;
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  (${d})` : ''}`); ok ? pass++ : fail++; };

async function api(path, { token, method = 'GET', body } = {}) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

const made = { users: [], teachers: [], academies: [] };
let teacher, token;

try {
  // ── a throwaway teacher with a known, seeded balance ────────────────────
  const existing = await prisma.teacherProfile.findFirst({
    where: { status: 'APPROVED' }, include: { user: true },
  });
  if (!existing) throw new Error('no approved teacher to model — seed the database first');

  const user = await prisma.user.create({
    data: {
      email: `${tag}@test.invalid`, fullName: 'Payout Race Teacher',
      passwordHash: await argon2.hash(PASSWORD), role: 'TEACHER', isActive: true,
    },
  });
  made.users.push(user.id);
  teacher = await prisma.teacherProfile.create({
    data: {
      userId: user.id, status: 'APPROVED', slug: `${tag}`,
      subjectId: existing.subjectId, language: existing.language ?? 'ar',
    },
  });
  made.teachers.push(teacher.id);

  // Earnings, booked through the ledger so the balance is the real one the
  // payout path reads.
  const BALANCE = 50000; // 500 EGP
  const txn = await prisma.ledgerTransaction.create({ data: { description: `${tag} seed earnings` } });
  await prisma.ledgerEntry.createMany({
    data: [
      { transactionId: txn.id, account: 'platform:cash', direction: 'DEBIT', amountCents: BALANCE, tenantId: teacher.id },
      { transactionId: txn.id, account: `teacher:${teacher.id}:balance`, direction: 'CREDIT', amountCents: BALANCE, tenantId: teacher.id },
    ],
  });
  // Every approved teacher is provisioned an academy at registration, and the
  // payout routes resolve the acting academy from it — without one the request
  // never reaches the balance check at all.
  // Provisioning gives the academy the SAME id as the teacher profile — that is
  // why serviceFee looks an academy up by course.tenantId, and why the payout
  // route's fallback resolution (JWT tenantId == academyId) finds it at all.
  const academy = await prisma.academy.create({
    data: { id: teacher.id, slug: `${tag}-academy`, name: 'Payout Race Academy', ownerUserId: user.id, status: 'ACTIVE' },
  });
  made.academies.push(academy.id);
  // The payout routes resolve their academy through AcademyMembershipGuard,
  // which requires an ACTIVE membership — owning the row is not enough.
  await prisma.academyMembership.create({
    data: { userId: user.id, academyId: academy.id, role: 'OWNER', status: 'ACTIVE', joinedAt: new Date() },
  });

  const method = await prisma.payoutMethodSaved.create({
    data: { tenantId: teacher.id, method: 'VODAFONE_CASH', details: { walletPhone: '01000000000' }, isDefault: true },
  });

  const lr = await api('/auth/login', { method: 'POST', body: { email: user.email, password: PASSWORD } });
  if (lr.status >= 300) throw new Error(`teacher login failed: ${lr.status} ${JSON.stringify(lr.body).slice(0, 140)}`);
  token = lr.body.accessToken;

  const balanceNow = async () => {
    const acct = `teacher:${teacher.id}:balance`;
    const [cr, dr] = await Promise.all([
      prisma.ledgerEntry.aggregate({ where: { account: acct, direction: 'CREDIT' }, _sum: { amountCents: true } }),
      prisma.ledgerEntry.aggregate({ where: { account: acct, direction: 'DEBIT' }, _sum: { amountCents: true } }),
    ]);
    return (cr._sum.amountCents ?? 0) - (dr._sum.amountCents ?? 0);
  };
  const pendingTotal = async () => {
    const a = await prisma.payoutRequest.aggregate({
      where: { tenantId: teacher.id, status: { in: ['REQUESTED', 'APPROVED', 'PROCESSING'] } },
      _sum: { amountCents: true },
    });
    return a._sum.amountCents ?? 0;
  };

  console.log(`teacher seeded with ${money(BALANCE)} withdrawable\n`);

  // ── the race: two withdrawals of the FULL balance, fired together ───────
  console.log('=== TWO SIMULTANEOUS WITHDRAWALS OF THE FULL BALANCE ===');
  {
    const [a, b] = await Promise.all([
      api('/teacher/payouts', { method: 'POST', token, body: { amountCents: BALANCE, methodId: method.id } }),
      api('/teacher/payouts', { method: 'POST', token, body: { amountCents: BALANCE, methodId: method.id } }),
    ]);
    const ok = [a, b].filter((r) => r.status < 300).length;
    const pending = await pendingTotal();
    check('exactly one withdrawal was accepted', ok === 1, `${ok} accepted (${a.status}, ${b.status})`);
    check('neither request produced a server error', a.status < 500 && b.status < 500, `${a.status}, ${b.status}`);
    check('pending payouts do not exceed the balance', pending <= BALANCE, `${money(pending)} pending of ${money(BALANCE)}`);
    if (ok !== 1) console.log(`      bodies: ${JSON.stringify(a.body).slice(0, 160)} | ${JSON.stringify(b.body).slice(0, 160)}`);
  }

  // ── three at once, for the same reason the wallet gate tries three ──────
  console.log('\n=== THREE SIMULTANEOUS WITHDRAWALS OF THE REMAINING BALANCE ===');
  {
    await prisma.payoutRequest.deleteMany({ where: { tenantId: teacher.id } });
    const [a, b, c] = await Promise.all([
      api('/teacher/payouts', { method: 'POST', token, body: { amountCents: BALANCE, methodId: method.id } }),
      api('/teacher/payouts', { method: 'POST', token, body: { amountCents: BALANCE, methodId: method.id } }),
      api('/teacher/payouts', { method: 'POST', token, body: { amountCents: BALANCE, methodId: method.id } }),
    ]);
    const ok = [a, b, c].filter((r) => r.status < 300).length;
    const pending = await pendingTotal();
    check('exactly one of three was accepted', ok === 1, `${ok} accepted (${a.status}, ${b.status}, ${c.status})`);
    check('no server errors', [a, b, c].every((r) => r.status < 500), `${a.status}, ${b.status}, ${c.status}`);
    check('pending still within the balance', pending <= BALANCE, `${money(pending)} pending`);
  }

  // ── asking for more than is there ───────────────────────────────────────
  console.log('\n=== OVER-WITHDRAWAL AND MALFORMED AMOUNTS ===');
  {
    await prisma.payoutRequest.deleteMany({ where: { tenantId: teacher.id } });
    const cases = [
      ['more than the balance', BALANCE + 1],
      ['a negative amount', -10000],
      ['zero', 0],
      ['an absurd amount', 999_999_999_99],
    ];
    for (const [label, amountCents] of cases) {
      const r = await api('/teacher/payouts', { method: 'POST', token, body: { amountCents, methodId: method.id } });
      check(`${label} is refused`, r.status >= 400 && r.status < 500, `HTTP ${r.status}`);
    }
    const pending = await pendingTotal();
    check('nothing was queued by any of them', pending === 0, `${money(pending)} pending`);
  }

  // ── another teacher's method, and another teacher's money ───────────────
  console.log('\n=== CROSS-TENANT PAYOUT ===');
  {
    const otherMethod = await prisma.payoutMethodSaved.findFirst({
      where: { tenantId: { not: teacher.id }, deletedAt: null },
    });
    if (!otherMethod) {
      console.log('   SKIP  no other academy has a saved payout method');
    } else {
      const r = await api('/teacher/payouts', {
        method: 'POST', token, body: { amountCents: 1000, methodId: otherMethod.id },
      });
      check("another academy's payout method cannot be used", r.status >= 400, `HTTP ${r.status}`);
      const landed = await prisma.payoutRequest.count({ where: { tenantId: otherMethod.tenantId, amountCents: 1000 } });
      check("and nothing was queued against that academy", landed === 0, `${landed} queued`);
    }
  }

  console.log('\n=== FINAL LEDGER STATE ===');
  {
    const bal = await balanceNow();
    check('the balance never went negative', bal >= 0, money(bal));
  }
} catch (e) {
  console.error('\nERROR:', e.message);
  fail++;
} finally {
  if (teacher) {
    await prisma.payoutRequest.deleteMany({ where: { tenantId: teacher.id } }).catch(() => {});
    await prisma.payoutMethodSaved.deleteMany({ where: { tenantId: teacher.id } }).catch(() => {});
    await prisma.ledgerEntry.deleteMany({ where: { account: { contains: `teacher:${teacher.id}:` } } }).catch(() => {});
    await prisma.teacherProfile.delete({ where: { id: teacher.id } }).catch(() => {});
  }
  for (const id of made.academies) await prisma.academy.delete({ where: { id } }).catch(() => {});
  for (const id of made.users) await prisma.user.delete({ where: { id } }).catch(() => {});
  await prisma.ledgerTransaction.deleteMany({ where: { description: { startsWith: tag } } }).catch(() => {});
  await prisma.$disconnect();
}

console.log(`\n${fail === 0 ? 'PAYOUT GATE PASS' : `PAYOUT GATE — ${fail} FAILURE(S)`}  —  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
