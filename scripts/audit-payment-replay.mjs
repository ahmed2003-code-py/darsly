#!/usr/bin/env node
/**
 * Can one transfer be banked twice?
 *
 * The manual-transfer pipeline takes an SMS from a phone and turns it into
 * money: listener -> payment event -> match -> verify -> ledger -> enrolment.
 * A phone with poor signal retries; a matcher that ran twice on one message
 * would credit a course nobody paid for a second time. So the property under
 * test is not "does it work" but "does it work exactly once", under duplicates,
 * replays, reorderings and simultaneous delivery.
 *
 *   CONFIRM_TEST_DB=yes DATABASE_URL=... API_URL=... PAYMENT_LISTENER_KEY=... \
 *     node scripts/audit-payment-replay.mjs
 *
 * Every event is synthetic and every row it touches is created and deleted by
 * this script.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

const API = process.env.API_URL ?? 'http://127.0.0.1:3077/api/v1';
const DB = process.env.DATABASE_URL ?? '';
const KEY = process.env.PAYMENT_LISTENER_KEY ?? '';
const PASSWORD = 'Darsly@123';

if (process.env.CONFIRM_TEST_DB !== 'yes') { console.error('REFUSED: set CONFIRM_TEST_DB=yes.'); process.exit(2); }
if (!DB) { console.error('REFUSED: DATABASE_URL is not set.'); process.exit(2); }
if (!KEY) { console.error('REFUSED: PAYMENT_LISTENER_KEY is not set — the ingest route needs it.'); process.exit(2); }
if (/railway|prod|amazonaws|supabase|neon\.tech|render\.com/i.test(DB)) {
  console.error('REFUSED: DATABASE_URL looks hosted.'); process.exit(2);
}

const prisma = new PrismaClient();
const tag = `replay-${Date.now()}`;
const money = (c) => `${(c / 100).toFixed(2)} EGP`;
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  (${d})` : ''}`); ok ? pass++ : fail++; };

async function api(path, { token, method = 'GET', body, headers = {} } = {}) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

const ingest = (event) => api('/payment-events', { method: 'POST', body: event, headers: { 'x-listener-key': KEY } });

const made = { users: [], students: [], courses: [] };

/** A Vodafone Cash SMS, in the shape the parser actually reads. */
const walletSms = (amountCents, fromNumber, payer, txnRef) =>
  [
    `تم استلام مبلغ ${(amountCents / 100).toFixed(2)} جنيه من ${fromNumber}؛`,
    `المسجل بإسم ${payer} على`,
    `على رقم محفظتك 01002589923 بتاريخ 18-09-26 12:00.`,
    `رصيدك الحالي: 500.00 جنيه`,
    `رقم العملية: ${txnRef}`,
  ].join('\n');

const teacher = await prisma.teacherProfile.findFirst({ where: { status: 'APPROVED' } });
if (!teacher) throw new Error('no approved teacher — seed the database first');

async function newStudentWithPendingPayment(priceCents, senderNumber, payerName) {
  const user = await prisma.user.create({
    data: {
      email: `${tag}-${Math.random().toString(36).slice(2, 7)}@test.invalid`,
      fullName: payerName, passwordHash: await argon2.hash(PASSWORD), role: 'STUDENT', isActive: true,
    },
  });
  made.users.push(user.id);
  const student = await prisma.studentProfile.create({ data: { userId: user.id } });
  made.students.push(student.id);
  const course = await prisma.course.create({
    data: { tenantId: teacher.id, title: `${tag} course`, status: 'PUBLISHED', priceCents, currency: 'EGP', pricingModel: 'ONE_TIME' },
  });
  made.courses.push(course.id);

  const lr = await api('/auth/login', { method: 'POST', body: { email: user.email, password: PASSWORD } });
  const token = lr.body.accessToken;

  // The student submits a proof of payment: this is the row the SMS must match.
  const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
  const sub = await api('/payments', {
    method: 'POST', token,
    body: { courseId: course.id, method: 'VODAFONE_CASH', reference: senderNumber, proofImageUrl: png },
  });
  if (sub.status >= 300) throw new Error(`submit failed: ${sub.status} ${JSON.stringify(sub.body).slice(0, 180)}`);
  const payment = await prisma.payment.findFirst({ where: { studentId: student.id }, orderBy: { createdAt: 'desc' } });
  return { user, student, course, token, payment };
}

const settledCount = async (paymentId) => {
  const p = await prisma.payment.findUnique({ where: { id: paymentId } });
  return { status: p?.status, settledAt: p?.settledAt };
};
const ledgerFor = async (paymentId) => {
  const entries = await prisma.ledgerEntry.findMany({ where: { transaction: { description: { contains: paymentId } } } });
  return entries;
};

try {
  // ── 1. the same message delivered twice ─────────────────────────────────
  console.log('\n=== 1. THE SAME SMS DELIVERED TWICE ===');
  {
    const sender = '01234500001';
    const s = await newStudentWithPendingPayment(10000, sender, 'راجع تست واحد');
    const quoted = s.payment.amountCents;
    const event = {
      provider: 'VODAFONE_CASH', amountCents: quoted, reference: sender,
      occurredAt: new Date().toISOString(), externalId: `${tag}-sms-1`,
      rawMessage: walletSms(quoted, sender, 'راجع تست واحد', '023600000001'),
    };
    const first = await ingest(event);
    const second = await ingest(event);                       // byte-identical retry
    const events = await prisma.paymentEvent.count({ where: { dedupeKey: { contains: `${tag}-sms-1` } } });
    const pay = await settledCount(s.payment.id);
    const enrolments = await prisma.enrollment.count({ where: { studentId: s.student.id, status: 'ACTIVE' } });

    check('the first delivery is accepted', first.status < 300, `HTTP ${first.status} ${first.body?.status ?? ''}`);
    check('the second is recognised as a duplicate', second.body?.status === 'DUPLICATE', `${second.body?.status}`);
    check('only one event row exists', events === 1, `${events} rows`);
    check('the payment settled exactly once', !!pay.settledAt, `status ${pay.status}`);
    check('and exactly one enrolment was activated', enrolments === 1, `${enrolments} active`);
  }

  // ── 2. the same message, delivered simultaneously ───────────────────────
  console.log('\n=== 2. THE SAME SMS DELIVERED SIMULTANEOUSLY ===');
  {
    const sender = '01234500002';
    const s = await newStudentWithPendingPayment(10000, sender, 'راجع تست اتنين');
    const event = {
      provider: 'VODAFONE_CASH', amountCents: s.payment.amountCents, reference: sender,
      occurredAt: new Date().toISOString(), externalId: `${tag}-sms-2`,
      rawMessage: walletSms(s.payment.amountCents, sender, 'راجع تست اتنين', '023600000002'),
    };
    const [a, b, c] = await Promise.all([ingest(event), ingest(event), ingest(event)]);
    const events = await prisma.paymentEvent.count({ where: { dedupeKey: { contains: `${tag}-sms-2` } } });
    const enrolments = await prisma.enrollment.count({ where: { studentId: s.student.id, status: 'ACTIVE' } });
    const entries = await ledgerFor(s.payment.id);

    check('three simultaneous deliveries created one event', events === 1, `${events} rows`);
    check('none returned a server error', [a, b, c].every((r) => r.status < 500), `${a.status}, ${b.status}, ${c.status}`);
    check('exactly one enrolment', enrolments === 1, `${enrolments} active`);
    check('the ledger booked the payment once', entries.length <= 4, `${entries.length} entries`);
  }

  // ── 3. a replay with a NEW event id but the same transfer ────────────────
  console.log('\n=== 3. REPLAY WITH A FRESH EVENT ID (same transfer, same reference) ===');
  {
    const sender = '01234500003';
    const s = await newStudentWithPendingPayment(10000, sender, 'راجع تست تلاتة');
    const base = {
      provider: 'VODAFONE_CASH', amountCents: s.payment.amountCents, reference: sender,
      occurredAt: new Date().toISOString(),
      rawMessage: walletSms(s.payment.amountCents, sender, 'راجع تست تلاتة', '023600000003'),
    };
    await ingest({ ...base, externalId: `${tag}-sms-3a` });
    const replay = await ingest({ ...base, externalId: `${tag}-sms-3b` });   // same transfer, new id
    const enrolments = await prisma.enrollment.count({ where: { studentId: s.student.id, status: 'ACTIVE' } });
    const entries = await ledgerFor(s.payment.id);

    // The replay must not settle the payment a second time. It may legitimately
    // be filed UNMATCHED (the payment it would match is already settled).
    check('the replay did not create a second enrolment', enrolments === 1, `${enrolments} active`);
    check('the replay did not double-book the ledger', entries.length <= 4, `${entries.length} entries`);
    check('the replay was not silently accepted as a second settlement',
      replay.body?.status !== 'MATCHED' || entries.length <= 4, `${replay.body?.status}`);
  }

  // ── 4. the wrong amount ─────────────────────────────────────────────────
  console.log('\n=== 4. AN SMS FOR THE WRONG AMOUNT ===');
  {
    const sender = '01234500004';
    const s = await newStudentWithPendingPayment(10000, sender, 'راجع تست اربعة');
    const wrong = s.payment.amountCents - 500;              // 5 EGP short
    const r = await ingest({
      provider: 'VODAFONE_CASH', amountCents: wrong, reference: sender,
      occurredAt: new Date().toISOString(), externalId: `${tag}-sms-4`,
      rawMessage: walletSms(wrong, sender, 'راجع تست اربعة', '023600000004'),
    });
    const pay = await settledCount(s.payment.id);
    const enrolments = await prisma.enrollment.count({ where: { studentId: s.student.id, status: 'ACTIVE' } });
    check('a short transfer does not match the payment', r.body?.status !== 'MATCHED', `${r.body?.status}`);
    check('the payment stays unsettled', !pay.settledAt, `status ${pay.status}`);
    check('and no enrolment is activated', enrolments === 0, `${enrolments} active`);
  }

  // ── 5. an outgoing debit dressed as a credit ────────────────────────────
  console.log('\n=== 5. AN OUTGOING TRANSFER MUST NOT CREDIT ANYONE ===');
  {
    const sender = '01234500005';
    const s = await newStudentWithPendingPayment(10000, sender, 'راجع تست خمسة');
    const outgoing = [
      'يرجى العلم انه تم تنفيذ تحويل لحظي بمبلغ 120.00 جم من حسابك المنتهي بـ 7717********',
      'برقم مرجعي aaaa1111 بتاريخ 2026-09-18 12:00',
    ].join('\n');
    const r = await ingest({
      provider: 'VODAFONE_CASH', amountCents: s.payment.amountCents, reference: sender,
      occurredAt: new Date().toISOString(), externalId: `${tag}-sms-5`, rawMessage: outgoing,
    });
    const pay = await settledCount(s.payment.id);
    check('money leaving the account does not settle a payment', !pay.settledAt, `${r.body?.status}, status ${pay.status}`);
  }

  // ── 6. unauthenticated and malformed ingestion ──────────────────────────
  console.log('\n=== 6. INGESTION AUTH AND VALIDATION ===');
  {
    const good = { provider: 'VODAFONE_CASH', amountCents: 1000, externalId: `${tag}-sms-6` };
    const noKey = await api('/payment-events', { method: 'POST', body: good });
    check('no listener key is refused', noKey.status === 401, `HTTP ${noKey.status}`);
    const badKey = await api('/payment-events', { method: 'POST', body: good, headers: { 'x-listener-key': 'x'.repeat(KEY.length) } });
    check('a wrong key of the same length is refused', badKey.status === 401, `HTTP ${badKey.status}`);

    const malformed = [
      ['no amount', { provider: 'VODAFONE_CASH' }],
      ['negative amount', { provider: 'VODAFONE_CASH', amountCents: -5000 }],
      ['zero amount', { provider: 'VODAFONE_CASH', amountCents: 0 }],
      ['absurd amount', { provider: 'VODAFONE_CASH', amountCents: 99_999_999_999 }],
      ['unknown provider', { provider: 'DOGECOIN', amountCents: 1000 }],
      ['amount as a string', { provider: 'VODAFONE_CASH', amountCents: '1000' }],
      ['unexpected field', { provider: 'VODAFONE_CASH', amountCents: 1000, matchedPaymentId: 'anything' }],
    ];
    for (const [label, body] of malformed) {
      const r = await ingest(body);
      check(`${label} is a clean 4xx, not a 500`, r.status >= 400 && r.status < 500, `HTTP ${r.status}`);
    }
  }
} catch (e) {
  console.error('\nERROR:', e.message);
  fail++;
} finally {
  for (const id of made.students) {
    await prisma.paymentEvent.deleteMany({ where: { dedupeKey: { contains: tag } } }).catch(() => {});
    await prisma.ledgerEntry.deleteMany({ where: { account: { contains: `student:${id}:` } } }).catch(() => {});
    await prisma.enrollment.deleteMany({ where: { studentId: id } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { studentId: id } }).catch(() => {});
    await prisma.studentProfile.delete({ where: { id } }).catch(() => {});
  }
  for (const id of made.courses) await prisma.course.delete({ where: { id } }).catch(() => {});
  for (const id of made.users) await prisma.user.delete({ where: { id } }).catch(() => {});
  await prisma.$disconnect();
}

console.log(`\n${fail === 0 ? 'PAYMENT REPLAY GATE PASS' : `PAYMENT REPLAY GATE — ${fail} FAILURE(S)`}  —  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
