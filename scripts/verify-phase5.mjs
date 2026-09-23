#!/usr/bin/env node
/**
 * Real end-to-end verification for the SaaS Evolution Phase 5 work: academy
 * enrollment modes (AUTOMATIC/MANUAL/DEMO), the free-course approval queue,
 * and DEMO enrollment. Hits a real running API and a real (disposable,
 * local-only) Postgres — not unit tests with Prisma mocked out.
 *
 * This is the financial-invariant test: every DEMO/approval assertion reads
 * actual ledger rows before and after, not just an HTTP status code.
 *
 *   CONFIRM_TEST_DB=yes DATABASE_URL=postgresql://...localhost:PORT/darsly node scripts/verify-phase5.mjs
 */
import { PrismaClient } from '@prisma/client';

const DB = process.env.DATABASE_URL ?? '';
const PORT = process.env.API_PORT ?? '41000';
const PASSWORD = 'Darsly@123';

if (process.env.CONFIRM_TEST_DB !== 'yes') {
  console.error('REFUSED: set CONFIRM_TEST_DB=yes.');
  process.exit(2);
}
if (!DB) {
  console.error('REFUSED: DATABASE_URL is not set.');
  process.exit(2);
}
if (/railway|prod|amazonaws|supabase|neon\.tech|render\.com/i.test(DB)) {
  console.error('REFUSED: DATABASE_URL looks hosted.');
  process.exit(2);
}

let pass = 0,
  fail = 0;
const check = (n, ok, d = '') => {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  (${d})` : ''}`);
  if (ok) pass++;
  else fail++;
};

async function api(p, { token, method = 'GET', body, headers } = {}) {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/v1${p}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(headers ?? {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: r.status, body: json };
}
const login = async (email) => {
  const r = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  if (r.status >= 300) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
};

const prisma = new PrismaClient();
const cleanup = [];

/** Every financial fact this phase must leave untouched, read the same way
 *  LedgerService itself defines these accounts — not re-derived arithmetic. */
async function ledgerSnapshot(academyId) {
  const [net, fee, gross, paymentCount, ledgerTxnCount] = await Promise.all([
    prisma.ledgerEntry.aggregate({
      where: { tenantId: academyId, account: `teacher:${academyId}:balance`, direction: 'CREDIT' },
      _sum: { amountCents: true },
    }),
    prisma.ledgerEntry.aggregate({
      where: { tenantId: academyId, account: 'platform:commission', direction: 'CREDIT' },
      _sum: { amountCents: true },
    }),
    prisma.ledgerEntry.aggregate({
      where: { account: 'platform:cash', direction: 'DEBIT' },
      _sum: { amountCents: true },
    }),
    prisma.payment.count({ where: { tenantId: academyId } }),
    prisma.ledgerTransaction.count(),
  ]);
  return {
    academyNetCents: net._sum.amountCents ?? 0,
    platformFeeCents: fee._sum.amountCents ?? 0,
    platformGrossCents: gross._sum.amountCents ?? 0,
    paymentRowCount: paymentCount,
    ledgerTransactionCount: ledgerTxnCount,
  };
}
function assertSnapshotsEqual(before, after, label) {
  const keys = Object.keys(before);
  const diffs = keys.filter((k) => before[k] !== after[k]);
  check(
    `${label}: zero financial delta`,
    diffs.length === 0,
    diffs.length ? diffs.map((k) => `${k}: ${before[k]}→${after[k]}`).join(', ') : '',
  );
}

async function main() {
  console.log('== Phase 5 verification: Enrollment Modes (AUTOMATIC/MANUAL/DEMO) ==\n');

  const teacherA = await prisma.teacherProfile.findFirst({
    where: { status: 'APPROVED' },
    include: { user: { select: { id: true, email: true } } },
  });
  const others = await prisma.teacherProfile.findMany({
    where: { status: 'APPROVED', id: { not: teacherA.id } },
    take: 1,
    include: { user: { select: { id: true, email: true } } },
  });
  const teacherB = others[0];
  const teacherC = (
    await prisma.teacherProfile.findMany({
      where: { status: 'APPROVED', id: { notIn: [teacherA.id, teacherB.id] } },
      take: 1,
      include: { user: { select: { email: true } } },
    })
  )[0];
  const academy1 = teacherA.id;
  const paidCourse = await prisma.course.findFirst({
    where: { tenantId: academy1, status: 'PUBLISHED', priceCents: { gt: 0 } },
  });
  const tokenA = await login(teacherA.user.email);
  const tokenB = await login(teacherB.user.email);
  const adminToken = await login('admin@darsly.app');

  // Fixture: a genuinely FREE course under academy1 for the approval-queue tests.
  const freeCourse = await prisma.course.create({
    data: {
      tenantId: academy1,
      title: 'Verify Phase5 Free Course',
      priceCents: 0,
      status: 'PUBLISHED',
      pricingModel: 'ONE_TIME',
    },
  });
  cleanup.push(() =>
    prisma.enrollment
      .deleteMany({ where: { courseId: freeCourse.id } })
      .then(() => prisma.course.delete({ where: { id: freeCourse.id } }))
      .catch(() => {}),
  );

  // A generous, distinct pool for the FREE course — it's brand new, so any of
  // these students is safe there (nothing in seed data could already have
  // touched it). freeCourse-only roles.
  const pool = await prisma.studentProfile.findMany({
    take: 8,
    include: { user: { select: { id: true, email: true } } },
  });
  const [
    studentAuto,
    studentX,
    studentY,
    studentZ,
    studentDemoFree,
    studentRace,
    studentFlagFallback,
  ] = pool;

  // paidCourse is real seed data with scattered pre-existing enrollments —
  // every student who will touch it needs its own guaranteed-fresh pick
  // (eligible for its year restriction, not already enrolled), not just an
  // index into the general pool.
  const admittedGradeIds = (
    await prisma.courseGrade.findMany({
      where: { courseId: paidCourse.id },
      select: { gradeId: true },
    })
  ).map((g) => g.gradeId);
  const usedForPaidCourse = new Set();
  async function freshStudentForPaidCourse() {
    const s = await prisma.studentProfile.findFirst({
      where: {
        id: { notIn: [...usedForPaidCourse] },
        ...(admittedGradeIds.length ? { gradeId: { in: admittedGradeIds } } : {}),
        enrollments: { none: { courseId: paidCourse.id } },
      },
      include: { user: { select: { id: true, email: true } } },
    });
    if (!s)
      throw new Error(
        'No more eligible, unenrolled students for paidCourse — check seed data / raise the pool size',
      );
    usedForPaidCourse.add(s.id);
    return s;
  }
  const paidTestStudent = await freshStudentForPaidCourse();
  const studentDemoPaid = await freshStudentForPaidCourse();
  const studentGuard = await freshStudentForPaidCourse();
  const cleanupEnrollment = (studentId, courseId) =>
    cleanup.push(() =>
      prisma.enrollment.deleteMany({ where: { studentId, courseId } }).catch(() => {}),
    );

  // ── Mode migration / backward compatibility ─────────────────────────────
  console.log('-- Mode migration / backward compatibility --');
  const academyRow = await prisma.academy.findUnique({
    where: { id: academy1 },
    select: { enrollmentMode: true },
  });
  check(
    "academy1 starts as AUTOMATIC (this run's starting state)",
    academyRow.enrollmentMode === 'AUTOMATIC',
  );
  const allAutomatic = await prisma.academy.count({
    where: { enrollmentMode: { not: 'AUTOMATIC' } },
  });
  check(
    'every academy in this DB defaults to AUTOMATIC unless explicitly changed',
    allAutomatic === 0,
  );
  const activeEnrollmentCount = await prisma.enrollment.count({ where: { status: 'ACTIVE' } });
  check(
    'existing ACTIVE enrollments are untouched by this migration (sanity: still > 0)',
    activeEnrollmentCount > 0,
  );

  // ── AUTOMATIC: regression — behavior must be byte-for-byte unchanged ────
  console.log('\n-- AUTOMATIC: regression --');
  const before1 = await ledgerSnapshot(academy1);
  const freeAuto = await api('/enrollments', {
    token: await login(studentAuto.user.email),
    method: 'POST',
    body: { courseId: freeCourse.id },
  });
  check(
    'AUTOMATIC: free course still activates instantly',
    freeAuto.status < 300 && freeAuto.body?.status === 'ACTIVE',
  );
  cleanupEnrollment(studentAuto.id, freeCourse.id);
  const paidAuto = await api('/enrollments', {
    token: await login(paidTestStudent.user.email),
    method: 'POST',
    body: { courseId: paidCourse.id },
  });
  check(
    'AUTOMATIC: paid course still returns PAYMENT_REQUIRED, not instant access',
    paidAuto.status === 400 && paidAuto.body?.code === 'PAYMENT_REQUIRED',
    `status=${paidAuto.status} body=${JSON.stringify(paidAuto.body)}`,
  );
  const after1 = await ledgerSnapshot(academy1);
  assertSnapshotsEqual(
    before1,
    after1,
    'AUTOMATIC free-course enroll (no money involved, nothing should move)',
  );

  // ── Switch to MANUAL mode ────────────────────────────────────────────────
  console.log('\n-- Enrollment mode setting --');
  const academySlug = await prisma.academy.findUnique({
    where: { id: academy1 },
    select: { slug: true },
  });
  const setManual = await api(`/academies/${academySlug.slug}/settings`, {
    token: tokenA,
    method: 'PATCH',
    body: { enrollmentMode: 'MANUAL' },
  });
  check(
    'OWNER sets enrollmentMode=MANUAL: 2xx',
    setManual.status < 300 && setManual.body?.enrollmentMode === 'MANUAL',
  );
  cleanup.push(() =>
    prisma.academy
      .update({ where: { id: academy1 }, data: { enrollmentMode: 'AUTOMATIC' } })
      .catch(() => {}),
  );

  const membershipB = await prisma.academyMembership.create({
    data: { userId: teacherB.user.id, academyId: academy1, role: 'TEACHER', status: 'ACTIVE' },
  });
  cleanup.push(() =>
    prisma.academyMembership.delete({ where: { id: membershipB.id } }).catch(() => {}),
  );
  const bSetsMode = await api(`/academies/${academySlug.slug}/settings`, {
    token: tokenB,
    headers: { 'X-Academy-Id': academy1 },
    method: 'PATCH',
    body: { enrollmentMode: 'DEMO' },
  });
  check('a TEACHER (not OWNER) cannot change the academy enrollmentMode', bSetsMode.status === 403);

  // ── MANUAL: free-course approval queue ──────────────────────────────────
  console.log('\n-- MANUAL: approval queue --');
  const reqX = await api('/enrollments', {
    token: await login(studentX.user.email),
    method: 'POST',
    body: { courseId: freeCourse.id },
  });
  check(
    'MANUAL: free-course request goes to PENDING_APPROVAL, not ACTIVE',
    reqX.status < 300 && reqX.body?.status === 'PENDING_APPROVAL',
  );
  const enrollmentXId = reqX.body.id;

  const dupReq = await api('/enrollments', {
    token: await login(studentX.user.email),
    method: 'POST',
    body: { courseId: freeCourse.id },
  });
  check('a second request while one is pending is refused', dupReq.status === 409);

  const listPending = await api('/teacher/enrollments', {
    token: tokenA,
    headers: { 'X-Academy-Id': academy1 },
  });
  // no query param filtering test needed beyond generic status — reuse the same list endpoint the codebase already had
  check('teacher enrollment list is reachable', listPending.status === 200);

  const before2 = await ledgerSnapshot(academy1);
  const approve = await api(`/teacher/enrollments/${enrollmentXId}/approve`, {
    token: tokenA,
    headers: { 'X-Academy-Id': academy1 },
    method: 'PATCH',
  });
  check(
    'approve: 2xx, status ACTIVE, source MANUAL_APPROVAL',
    approve.status < 300 &&
      approve.body?.status === 'ACTIVE' &&
      approve.body?.source === 'MANUAL_APPROVAL',
  );
  const after2 = await ledgerSnapshot(academy1);
  assertSnapshotsEqual(before2, after2, 'MANUAL approval of a free-course request');

  const reApprove = await api(`/teacher/enrollments/${enrollmentXId}/approve`, {
    token: tokenA,
    headers: { 'X-Academy-Id': academy1 },
    method: 'PATCH',
  });
  check(
    'idempotency: approving an already-ACTIVE enrollment again is refused, not double-applied',
    reApprove.status === 400,
  );

  // reject path with a different student
  const reqY = await api('/enrollments', {
    token: await login(studentY.user.email),
    method: 'POST',
    body: { courseId: freeCourse.id },
  });
  const enrollmentYId = reqY.body.id;
  const reject = await api(`/teacher/enrollments/${enrollmentYId}/reject`, {
    token: tokenA,
    headers: { 'X-Academy-Id': academy1 },
    method: 'PATCH',
    body: { reason: 'not eligible' },
  });
  check('reject: 2xx, status REJECTED', reject.status < 300 && reject.body?.status === 'REJECTED');
  const canRerequestAfterReject = await api('/enrollments', {
    token: await login(studentY.user.email),
    method: 'POST',
    body: { courseId: freeCourse.id },
  });
  check(
    'a rejected student can submit a fresh request',
    canRerequestAfterReject.status < 300 &&
      canRerequestAfterReject.body?.status === 'PENDING_APPROVAL',
  );
  const enrollmentY2Id = canRerequestAfterReject.body.id;

  // ── Concurrency: two simultaneous approvals ─────────────────────────────
  console.log('\n-- Concurrency --');
  const [c1, c2] = await Promise.all([
    api(`/teacher/enrollments/${enrollmentY2Id}/approve`, {
      token: tokenA,
      headers: { 'X-Academy-Id': academy1 },
      method: 'PATCH',
    }),
    api(`/teacher/enrollments/${enrollmentY2Id}/approve`, {
      token: tokenA,
      headers: { 'X-Academy-Id': academy1 },
      method: 'PATCH',
    }),
  ]);
  const succeeded = [c1, c2].filter((r) => r.status < 300);
  check(
    'exactly one of two concurrent approvals on the same request succeeds',
    succeeded.length === 1,
    `statuses=${c1.status},${c2.status}`,
  );
  const finalCount = await prisma.enrollment.count({
    where: { id: enrollmentY2Id, status: 'ACTIVE' },
  });
  check('no duplicate activation resulted from the race', finalCount === 1);

  // ── Security / IDOR on approval ─────────────────────────────────────────
  console.log('\n-- Security / IDOR: approval queue --');
  const reqZ = await api('/enrollments', {
    token: await login(studentZ.user.email),
    method: 'POST',
    body: { courseId: freeCourse.id },
  });
  const enrollmentZId = reqZ.body.id;
  const tokenC = await login(teacherC.user.email);
  const cApprove = await api(`/teacher/enrollments/${enrollmentZId}/approve`, {
    token: tokenC,
    method: 'PATCH',
  });
  check(
    "an unrelated academy owner cannot approve academy1's request (their own context, foreign id)",
    cApprove.status === 404,
  );

  const studentToken = await login(studentZ.user.email);
  const studentApprove = await api(`/teacher/enrollments/${enrollmentZId}/approve`, {
    token: studentToken,
    method: 'PATCH',
  });
  check(
    'a student cannot approve their own request',
    [401, 403, 404].includes(studentApprove.status),
  );

  // ── DEMO mode ─────────────────────────────────────────────────────────────
  console.log('\n-- DEMO mode --');
  const setDemo = await api(`/academies/${academySlug.slug}/settings`, {
    token: tokenA,
    method: 'PATCH',
    body: { enrollmentMode: 'DEMO' },
  });
  check('OWNER sets enrollmentMode=DEMO: 2xx', setDemo.status < 300);

  const beforeDemoFree = await ledgerSnapshot(academy1);
  const demoFree = await api('/teacher/enrollments/demo', {
    token: tokenA,
    method: 'POST',
    body: { studentUserId: studentDemoFree.user.id, courseId: freeCourse.id },
  });
  check(
    'demoEnroll (free course): 2xx, status ACTIVE, source DEMO',
    demoFree.status < 300 && demoFree.body?.status === 'ACTIVE' && demoFree.body?.source === 'DEMO',
  );
  cleanupEnrollment(studentDemoFree.id, freeCourse.id);
  const afterDemoFree = await ledgerSnapshot(academy1);
  assertSnapshotsEqual(beforeDemoFree, afterDemoFree, 'DEMO enrollment, free course');

  const beforeDemoPaid = await ledgerSnapshot(academy1);
  const demoPaid = await api('/teacher/enrollments/demo', {
    token: tokenA,
    method: 'POST',
    body: { studentUserId: studentDemoPaid.user.id, courseId: paidCourse.id },
  });
  check(
    'demoEnroll (PAID course): 2xx — bypasses price entirely',
    demoPaid.status < 300 && demoPaid.body?.status === 'ACTIVE',
  );
  cleanupEnrollment(studentDemoPaid.id, paidCourse.id);
  const afterDemoPaid = await ledgerSnapshot(academy1);
  assertSnapshotsEqual(
    beforeDemoPaid,
    afterDemoPaid,
    'DEMO enrollment, PAID course — the critical financial-safety assertion',
  );
  check(
    'demoEnroll never created a Payment row for the paid-course grant',
    afterDemoPaid.paymentRowCount === beforeDemoPaid.paymentRowCount,
  );

  // idempotency: re-demo an already active enrollment
  const reDemo = await api('/teacher/enrollments/demo', {
    token: tokenA,
    method: 'POST',
    body: { studentUserId: studentDemoPaid.user.id, courseId: paidCourse.id },
  });
  check(
    're-demo-enrolling an already-active student is refused, not duplicated',
    reDemo.status === 409,
  );

  // guard: pending payment blocks demo enroll
  const guardPayment = await prisma.payment.create({
    data: {
      studentId: studentGuard.id,
      courseId: paidCourse.id,
      tenantId: academy1,
      amountCents: paidCourse.priceCents,
      status: 'PENDING',
      method: 'INSTAPAY',
    },
  });
  cleanup.push(() => prisma.payment.delete({ where: { id: guardPayment.id } }).catch(() => {}));
  const blockedByPending = await api('/teacher/enrollments/demo', {
    token: tokenA,
    method: 'POST',
    body: { studentUserId: studentGuard.user.id, courseId: paidCourse.id },
  });
  check(
    'demoEnroll refuses when a PENDING payment already exists for this student+course',
    blockedByPending.status === 409 && blockedByPending.body?.code === 'PAYMENT_PENDING',
    `status=${blockedByPending.status} body=${JSON.stringify(blockedByPending.body)}`,
  );

  // ── Concurrency: two simultaneous demo enrollments ──────────────────────
  console.log('\n-- Concurrency: demo enrollment --');
  const raceStudent = studentRace;
  cleanupEnrollment(raceStudent.id, freeCourse.id);
  const [d1, d2] = await Promise.all([
    api('/teacher/enrollments/demo', {
      token: tokenA,
      method: 'POST',
      body: { studentUserId: raceStudent.user.id, courseId: freeCourse.id },
    }),
    api('/teacher/enrollments/demo', {
      token: tokenA,
      method: 'POST',
      body: { studentUserId: raceStudent.user.id, courseId: freeCourse.id },
    }),
  ]);
  const demoSucceeded = [d1, d2].filter((r) => r.status < 300);
  check(
    'exactly one of two concurrent demo-enroll calls for the same pair succeeds',
    demoSucceeded.length === 1,
    `statuses=${d1.status},${d2.status}`,
  );
  const raceCount = await prisma.enrollment.count({
    where: { studentId: raceStudent.id, courseId: freeCourse.id, status: 'ACTIVE' },
  });
  check('no duplicate enrollment row resulted', raceCount === 1);

  // ── Security / IDOR: DEMO ────────────────────────────────────────────────
  console.log('\n-- Security / IDOR: demo enrollment --');
  // teacherC's own academy is still AUTOMATIC (never changed), so the
  // mode-mismatch check refuses this before ever resolving academy1's
  // course/student — a 400, not a 404, but a refusal either way: teacherC's
  // token can never reach academy1's data through this endpoint.
  const cDemo = await api('/teacher/enrollments/demo', {
    token: tokenC,
    method: 'POST',
    body: { studentUserId: studentX.user.id, courseId: freeCourse.id },
  });
  check(
    "an unrelated academy owner's demoEnroll call cannot touch academy1's course",
    [400, 404].includes(cDemo.status),
    `status=${cDemo.status}`,
  );

  const studentDemo = await api('/teacher/enrollments/demo', {
    token: studentToken,
    headers: { 'X-Academy-Id': academy1 },
    method: 'POST',
    body: { studentUserId: studentX.user.id, courseId: freeCourse.id },
  });
  check('a student cannot demo-enroll anyone', [401, 403, 404].includes(studentDemo.status));

  // demoEnroll refuses outright when academy is AUTOMATIC
  await api(`/academies/${academySlug.slug}/settings`, {
    token: tokenA,
    method: 'PATCH',
    body: { enrollmentMode: 'AUTOMATIC' },
  });
  const demoUnderAutomatic = await api('/teacher/enrollments/demo', {
    token: tokenA,
    method: 'POST',
    body: { studentUserId: studentX.user.id, courseId: freeCourse.id },
  });
  check(
    'demoEnroll refuses outright while the academy is AUTOMATIC',
    demoUnderAutomatic.status === 400 &&
      demoUnderAutomatic.body?.code === 'ENROLLMENT_MODE_MISMATCH',
  );
  await api(`/academies/${academySlug.slug}/settings`, {
    token: tokenA,
    method: 'PATCH',
    body: { enrollmentMode: 'DEMO' },
  });

  // ── Feature flag integration ─────────────────────────────────────────────
  console.log('\n-- Feature flag integration --');
  await api(`/admin/academies/${academy1}/feature-flags/enrollmentApprovalMode`, {
    token: adminToken,
    method: 'PATCH',
    body: { enabled: false },
  });
  const blockedByFlag = await api('/teacher/enrollments/demo', {
    token: tokenA,
    method: 'POST',
    body: { studentUserId: studentX.user.id, courseId: freeCourse.id },
  });
  check(
    'enrollmentApprovalMode flag disabled — even the OWNER is 403d on demoEnroll',
    blockedByFlag.status === 403,
  );
  const modeChangeStillWorks = await api(`/academies/${academySlug.slug}/settings`, {
    token: tokenA,
    method: 'PATCH',
    body: { enrollmentMode: 'MANUAL' },
  });
  check(
    'the enrollmentMode SETTING itself is still changeable while the action flag is off (not the same switch)',
    modeChangeStillWorks.status < 300,
  );
  const freeEnrollFallsBack = await api('/enrollments', {
    token: await login(studentFlagFallback.user.email),
    method: 'POST',
    body: { courseId: freeCourse.id },
  });
  check(
    'with the flag off, a MANUAL-mode free-course enroll falls back to instant ACTIVE — never strands a student',
    freeEnrollFallsBack.status < 300 && freeEnrollFallsBack.body?.status === 'ACTIVE',
    `status=${freeEnrollFallsBack.status} body=${JSON.stringify(freeEnrollFallsBack.body)}`,
  );
  cleanupEnrollment(studentFlagFallback.id, freeCourse.id);
  await api(`/admin/academies/${academy1}/feature-flags/enrollmentApprovalMode`, {
    token: adminToken,
    method: 'PATCH',
    body: { enabled: true },
  });
  await api(`/academies/${academySlug.slug}/settings`, {
    token: tokenA,
    method: 'PATCH',
    body: { enrollmentMode: 'AUTOMATIC' },
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  for (const fn of cleanup.reverse())
    await fn().catch((e) => console.error('cleanup error:', e.message));
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error('FATAL', e);
  for (const fn of cleanup.reverse()) await fn().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
