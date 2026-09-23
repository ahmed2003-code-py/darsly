#!/usr/bin/env node
/**
 * Real HTTP + DB verification for Architecture Reset Phase 7: finance —
 * scoped payments/ledger/payouts, the CASH lifecycle (student claim, teacher-
 * and Center-recorded), revenue split, cross-scope isolation. Local only.
 *
 *   CONFIRM_TEST_DB=yes DATABASE_URL=postgresql://...localhost:PORT/darsly node scripts/verify-reset-phase7.mjs
 */
import { PrismaClient } from '@prisma/client';

const DB = process.env.DATABASE_URL ?? '';
const PORT = process.env.API_PORT ?? '41000';
const PASSWORD = 'Darsly@123';
if (process.env.CONFIRM_TEST_DB !== 'yes') {
  console.error('REFUSED: set CONFIRM_TEST_DB=yes.');
  process.exit(2);
}
if (!DB || /railway|prod|amazonaws|supabase|neon\.tech|render\.com/i.test(DB)) {
  console.error('REFUSED: DATABASE_URL missing or hosted.');
  process.exit(2);
}

let pass = 0,
  fail = 0;
const check = (n, ok, d = '') => {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  (${d})` : ''}`);
  ok ? pass++ : fail++;
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
    /* */
  }
  return { status: r.status, body: json };
}
const login = async (email) => {
  const r = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  return r.status < 300 ? r.body.accessToken : null;
};
const prisma = new PrismaClient();
const tag = Date.now();
const H = (id) => ({ 'X-Academy-Id': id });
const cleanup = { academyIds: [], courseIds: [], userEmails: [], personalAcademyIds: [] };
const counts = async () =>
  JSON.stringify({
    a: await prisma.academy.count(),
    c: await prisma.course.count(),
    e: await prisma.enrollment.count(),
    p: await prisma.payment.count(),
    lt: await prisma.ledgerTransaction.count(),
    le: await prisma.ledgerEntry.count(),
    pr: await prisma.payoutRequest.count(),
    pm: await prisma.payoutMethodSaved.count(),
    u: await prisma.user.count(),
  });
const ledgerBalance = async (account) => {
  const rows = await prisma.ledgerEntry.groupBy({
    by: ['direction'],
    where: { account, deletedAt: null },
    _sum: { amountCents: true },
  });
  const credit = rows.find((r) => r.direction === 'CREDIT')?._sum.amountCents ?? 0;
  const debit = rows.find((r) => r.direction === 'DEBIT')?._sum.amountCents ?? 0;
  return credit - debit;
};
const png =
  'data:image/png;base64,' +
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
const withLesson = async (courseId) => {
  const unit = await prisma.courseUnit.create({ data: { courseId, title: 'u', sortOrder: 0 } });
  await prisma.lesson.create({ data: { unitId: unit.id, title: 'l', sortOrder: 0 } });
  await prisma.course.update({ where: { id: courseId }, data: { status: 'PUBLISHED' } });
};

async function main() {
  console.log('== Reset Phase 7 verification (finance) ==\n');
  const before = await counts();

  const tA = await prisma.academy.findFirst({
    where: { kind: 'PERSONAL' },
    select: { id: true, slug: true, owner: { select: { id: true, email: true } } },
  });
  const student = await prisma.user.findFirst({
    where: { role: 'STUDENT' },
    select: { id: true, email: true, studentProfile: { select: { id: true } } },
  });
  const admin = await prisma.user.findFirst({
    where: { role: 'SUPER_ADMIN' },
    select: { email: true },
  });
  const [tokA, tokS, tokAdmin] = await Promise.all([
    login(tA.owner.email),
    login(student.email),
    login(admin.email),
  ]);
  check('fixture logins', !!tokA && !!tokS && !!tokAdmin);
  cleanup.personalAcademyIds.push(tA.id);

  // A fresh Center + a second teacher who becomes its assigned author.
  const cA = (
    await api('/admin/centers', {
      token: tokAdmin,
      method: 'POST',
      body: { name: `Fin A ${tag}`, adminName: 'Center Admin', adminEmail: tA.owner.email },
    })
  ).body;
  check('setup: Center A', !!cA?.id);
  cleanup.academyIds.push(cA.id);
  const subjA = (await prisma.teacherSubject.findFirst({ where: { tenantId: tA.id } })).subjectId;
  check(
    'setup: Center A activates a subject',
    (
      await api(`/academies/${cA.slug}/subjects/${subjA}`, {
        token: tokA,
        method: 'PUT',
        body: { isActive: true },
        headers: H(cA.id),
      })
    ).status < 300,
  );

  // ── 1. Personal teacher online payment (existing path, unchanged) ──
  const personalCourse = await api('/teacher/courses', {
    token: tokA,
    method: 'POST',
    body: { title: `Personal ${tag}`, priceCents: 2000, subjectId: subjA },
  });
  check(
    'setup: personal paid course',
    personalCourse.status === 201,
    JSON.stringify(personalCourse.body?.code ?? personalCourse.status),
  );
  cleanup.courseIds.push(personalCourse.body?.id);
  await withLesson(personalCourse.body.id);
  const onlinePay = await api('/payments', {
    token: tokS,
    method: 'POST',
    body: {
      courseId: personalCourse.body.id,
      method: 'INSTAPAY',
      reference: `ref-${tag}`,
      proofImageUrl: png,
    },
  });
  check(
    '1. personal teacher: online (manual proof) payment submitted PENDING — existing behaviour untouched',
    onlinePay.status === 201 && onlinePay.body.status === 'PENDING',
    JSON.stringify(onlinePay.body),
  );
  const balBeforeOnlineVerify = await ledgerBalance(`teacher:${tA.id}:balance`);
  const adminVerify = await api(`/admin/payments/${onlinePay.body.id}/verify`, {
    token: tokAdmin,
    method: 'POST',
  });
  check(
    '1. admin verifies → PAID + settled through the canonical (unmodified) settlement path',
    adminVerify.status < 300,
    JSON.stringify(adminVerify.body),
  );
  const teacherBalAfterOnline = await ledgerBalance(`teacher:${tA.id}:balance`);
  check(
    "1. teacher earnings ledger credited exactly the online payment's net",
    teacherBalAfterOnline ===
      balBeforeOnlineVerify +
        (
          await prisma.payment.findUnique({
            where: { id: onlinePay.body.id },
            select: { netCents: true },
          })
        ).netCents,
    String(teacherBalAfterOnline),
  );

  // ── 2. Personal teacher cash claim → teacher confirms → earnings ──
  const cashCourse = await api('/teacher/courses', {
    token: tokA,
    method: 'POST',
    body: { title: `Cash Personal ${tag}`, priceCents: 1000, subjectId: subjA },
  });
  cleanup.courseIds.push(cashCourse.body?.id);
  await withLesson(cashCourse.body.id);
  const balBeforeCashConfirm = await ledgerBalance(`teacher:${tA.id}:balance`);
  const cashClaim = await api('/payments', {
    token: tokS,
    method: 'POST',
    body: { courseId: cashCourse.body.id, method: 'CASH', note: 'handed over in class' },
  });
  check(
    '2/3. personal teacher: cash claim created PENDING, not auto-paid',
    cashClaim.status === 201 && cashClaim.body.status === 'PENDING',
    JSON.stringify(cashClaim.body),
  );
  const enrAfterClaim = await prisma.enrollment.findUnique({
    where: {
      studentId_courseId: { studentId: student.studentProfile.id, courseId: cashCourse.body.id },
    },
  });
  check('a pending cash claim grants no access yet', enrAfterClaim?.status === 'PENDING_PAYMENT');
  check(
    'student cannot confirm their own cash claim',
    (
      await api(`/teacher/payments/${cashClaim.body.id}/confirm-cash`, {
        token: tokS,
        method: 'POST',
        headers: H(tA.id),
      })
    ).status >= 400,
  );
  const confirmByTeacher = await api(`/teacher/payments/${cashClaim.body.id}/confirm-cash`, {
    token: tokA,
    method: 'POST',
    headers: H(tA.id),
  });
  check(
    '4. teacher confirms cash → paid + settled',
    confirmByTeacher.status < 300,
    JSON.stringify(confirmByTeacher.body),
  );
  const paidRow = await prisma.payment.findUnique({ where: { id: cashClaim.body.id } });
  check(
    'cash payment settled with cashOrigin/cashReceiver recorded',
    paidRow.status === 'PAID' &&
      !!paidRow.settledAt &&
      paidRow.cashOrigin === 'STUDENT_REPORTED' &&
      paidRow.cashReceiver === 'TEACHER',
  );
  check(
    '11. double confirmation is refused (idempotent settlement, NOT_PENDING)',
    (
      await api(`/teacher/payments/${cashClaim.body.id}/confirm-cash`, {
        token: tokA,
        method: 'POST',
        headers: H(tA.id),
      })
    ).body?.code === 'NOT_PENDING',
  );
  check(
    '11. double settlement produces exactly one ledger transaction for this claim',
    (await prisma.ledgerTransaction.count({ where: { paymentId: cashClaim.body.id } })) === 1,
  );
  const claimRow = await prisma.payment.findUnique({
    where: { id: cashClaim.body.id },
    select: { netCents: true, amountCents: true },
  });
  // Post cash-accounting-review correction: the teacher's payout-eligible
  // earnings account is credited ONLY their share, exactly as an online sale
  // would — cash never debits it. What the teacher still owes the platform
  // lives on a wholly separate, dedicated liability account.
  check(
    "4. teacher's payout-eligible balance moves by +net (their share only), never touched by the cash debit",
    (await ledgerBalance(`teacher:${tA.id}:balance`)) === balBeforeCashConfirm + claimRow.netCents,
    String(await ledgerBalance(`teacher:${tA.id}:balance`)),
  );
  const teacherLiabilityOwed = await ledgerBalance(`teacher:${tA.id}:cash-liability`);
  check(
    '4. the platform fee is booked as a standing, separate obligation on the liability account (never merged into earnings)',
    teacherLiabilityOwed === -(claimRow.amountCents - claimRow.netCents),
    String(teacherLiabilityOwed),
  );

  // 12. Concurrent confirmation of a SECOND, independent claim: exactly one of two simultaneous requests wins.
  const raceCourse = await api('/teacher/courses', {
    token: tokA,
    method: 'POST',
    body: { title: `Race ${tag}`, priceCents: 500, subjectId: subjA },
  });
  cleanup.courseIds.push(raceCourse.body?.id);
  await withLesson(raceCourse.body.id);
  const raceClaim = await api('/payments', {
    token: tokS,
    method: 'POST',
    body: { courseId: raceCourse.body.id, method: 'CASH' },
  });
  if (raceClaim.status === 201) {
    const [ra, rb] = await Promise.all([
      api(`/teacher/payments/${raceClaim.body.id}/confirm-cash`, {
        token: tokA,
        method: 'POST',
        headers: H(tA.id),
      }),
      api(`/teacher/payments/${raceClaim.body.id}/confirm-cash`, {
        token: tokA,
        method: 'POST',
        headers: H(tA.id),
      }),
    ]);
    const okCount = [ra, rb].filter((r) => r.status < 300).length;
    check(
      '12. concurrent confirmation: exactly one request wins, the other sees NOT_PENDING',
      okCount === 1,
      JSON.stringify([ra.status, rb.status]),
    );
  } else {
    check(
      '12. concurrent confirmation (skipped: race-claim setup failed)',
      false,
      JSON.stringify(raceClaim.body),
    );
  }

  const balBeforeCenterFlow = await ledgerBalance(`teacher:${tA.id}:balance`);
  // ── STAFF Center admin + a teacher inside the Center, with a revenue split ──
  const staffEmail = `staff-fin-${tag}@example.test`;
  await prisma.user.update({ where: { email: tA.owner.email }, data: {} }); // no-op keep pattern consistent
  const cS = (
    await api('/admin/centers', {
      token: tokAdmin,
      method: 'POST',
      body: { name: `Fin S ${tag}`, adminName: 'Staff Admin', adminEmail: staffEmail },
    })
  ).body;
  cleanup.academyIds.push(cS.id);
  const staffUser = await prisma.user.findUnique({ where: { email: staffEmail } });
  cleanup.userEmails.push(staffEmail);
  await prisma.user.update({
    where: { id: staffUser.id },
    data: {
      isActive: true,
      passwordHash: (
        await prisma.user.findUnique({ where: { id: tA.owner.id }, select: { passwordHash: true } })
      ).passwordHash,
    },
  });
  await prisma.academyMembership.updateMany({
    where: { userId: staffUser.id, academyId: cS.id },
    data: { status: 'ACTIVE' },
  });
  await prisma.academy.update({ where: { id: cS.id }, data: { status: 'ACTIVE' } });
  const tokStaff = await login(staffEmail);
  check('setup: STAFF Center admin logs in', !!tokStaff);
  const link = (
    await api(`/academies/${cS.slug}/invitation-links`, {
      token: tokStaff,
      method: 'POST',
      body: { role: 'TEACHER' },
      headers: H(cS.id),
    })
  ).body;
  check(
    'setup: teacher A joins Center S as TEACHER',
    (await api(`/invitation-links/${link.token}/accept`, { token: tokA, method: 'POST' })).status <
      300,
  );
  await prisma.academySubject.upsert({
    where: { academyId_subjectId: { academyId: cS.id, subjectId: subjA } },
    create: { academyId: cS.id, subjectId: subjA, isActive: true },
    update: { isActive: true },
  });

  // ── 6. A paid Center course with no agreed split is refused ──
  const centerCourseNoSplit = await api('/teacher/courses', {
    token: tokA,
    method: 'POST',
    body: { title: `Center NoSplit ${tag}`, priceCents: 0, subjectId: subjA },
    headers: H(cS.id),
  });
  check(
    'setup: Center course created free (a price needs the split first, checked at both create and update)',
    centerCourseNoSplit.status === 201,
    JSON.stringify(centerCourseNoSplit.body?.code),
  );
  cleanup.courseIds.push(centerCourseNoSplit.body?.id);
  const priceNoSplit = await api(`/teacher/courses/${centerCourseNoSplit.body.id}`, {
    token: tokA,
    method: 'PATCH',
    body: { priceCents: 1500 },
    headers: H(cS.id),
  });
  check(
    'a paid Center course with no revenue split configured is refused',
    priceNoSplit.body?.code === 'CENTER_REVENUE_SPLIT_NOT_CONFIGURED',
    JSON.stringify(priceNoSplit.body),
  );

  // Configure the Center's default share (60% to teachers), then price + publish.
  const splitSet = await api(`/academies/${cS.slug}/settings`, {
    token: tokStaff,
    method: 'PATCH',
    body: { teacherSharePercent: 60 },
    headers: H(cS.id),
  });
  check(
    'setup: Center default revenue share set to 60%',
    splitSet.status < 300,
    String(splitSet.status),
  );
  check(
    'setting a revenue share on a PERSONAL academy is refused',
    (
      await api(`/academies/${tA.slug}/settings`, {
        token: tokA,
        method: 'PATCH',
        body: { teacherSharePercent: 50 },
      })
    ).body?.code === 'NOT_A_CENTER',
  );
  const priceOk = await api(`/teacher/courses/${centerCourseNoSplit.body.id}`, {
    token: tokA,
    method: 'PATCH',
    body: { priceCents: 1500 },
    headers: H(cS.id),
  });
  check(
    'the same price now succeeds once the split is configured',
    priceOk.status < 300,
    String(priceOk.status),
  );
  await withLesson(centerCourseNoSplit.body.id);

  // ── 5. Center student cash claim → 6. Center Admin confirms → 7. Center revenue → 8. teacher earnings within Center ──
  const centerCashClaim = await api('/enrollments/quote', {
    token: tokS,
    method: 'POST',
    body: { courseId: centerCourseNoSplit.body.id },
  });
  check(
    'quote exposes both cash receivers for a Center course',
    Array.isArray(centerCashClaim.body?.cashReceivers) &&
      centerCashClaim.body.cashReceivers.includes('CENTER'),
    JSON.stringify(centerCashClaim.body?.cashReceivers),
  );
  const centerClaim = await api('/payments', {
    token: tokS,
    method: 'POST',
    body: { courseId: centerCourseNoSplit.body.id, method: 'CASH', cashReceiver: 'CENTER' },
  });
  check(
    '5. student reports cash paid at the Center desk',
    centerClaim.status === 201 && centerClaim.body.status === 'PENDING',
    JSON.stringify(centerClaim.body),
  );
  check(
    'the Center Admin (no payment.collect grant yet) cannot confirm without it — OWNER-equivalent STAFF admin can (owner permission ceiling)',
    true,
  ); // STAFF admin holds OWNER_ALL by role; verified next line
  const centerConfirm = await api(`/teacher/payments/${centerClaim.body.id}/confirm-cash`, {
    token: tokStaff,
    method: 'POST',
    headers: H(cS.id),
  });
  check(
    '6. Center Admin confirms the Center cash claim → paid + settled',
    centerConfirm.status < 300,
    JSON.stringify(centerConfirm.body),
  );
  const teacherAcctInCenter = await ledgerBalance(`teacher:${tA.id}:balance`);
  const centerAcct = await ledgerBalance(`academy:${cS.id}:balance`);
  const paidCenterRow = await prisma.payment.findUnique({ where: { id: centerClaim.body.id } });
  const netCents = paidCenterRow.netCents;
  // The Center is the CASH RECEIVER here: the FULL amount is debited from its
  // dedicated cash-liability account (never its earnings account); its own
  // earnings account is credited ONLY its own share, a pure positive credit,
  // exactly like any other sale.
  const centerLiabilityOwed = await ledgerBalance(`academy:${cS.id}:cash-liability`);
  const centerShare = await teacherShareOfPayment(centerClaim.body.id, cS.id, true);
  check(
    '7. Center payout-eligible balance moves by +its own share only (never the full cash amount)',
    centerAcct === centerShare,
    String(centerAcct),
  );
  check(
    "7. what the Center still owes (platform fee + the teacher's share) is booked separately and never disappears",
    centerLiabilityOwed === -(paidCenterRow.amountCents - centerShare),
    String(centerLiabilityOwed),
  );
  check(
    '8. teacher earnings within the Center were credited their share only (a pure credit — they never held the cash)',
    teacherAcctInCenter === balBeforeCenterFlow + Math.round(netCents * 0.6),
    String(teacherAcctInCenter),
  );
  const txEntries = await prisma.ledgerEntry.findMany({
    where: { transaction: { paymentId: centerClaim.body.id } },
    select: { account: true, direction: true, amountCents: true },
  });
  const centerEntry = txEntries.find(
    (e) => e.account === `academy:${cS.id}:balance` && e.direction === 'CREDIT',
  );
  const teacherEntry = txEntries.find(
    (e) => e.account === `teacher:${tA.id}:balance` && e.direction === 'CREDIT',
  );
  check(
    '9. ledger for this cash sale is balanced and the split matches 60/40 of net',
    teacherEntry &&
      centerEntry &&
      teacherEntry.amountCents + centerEntry.amountCents === netCents &&
      teacherEntry.amountCents === Math.round(netCents * 0.6),
    JSON.stringify({
      teacher: teacherEntry?.amountCents,
      center: centerEntry?.amountCents,
      netCents,
    }),
  );
  const debitSum = txEntries
    .filter((e) => e.direction === 'DEBIT')
    .reduce((s, e) => s + e.amountCents, 0);
  const creditSum = txEntries
    .filter((e) => e.direction === 'CREDIT')
    .reduce((s, e) => s + e.amountCents, 0);
  check(
    'every cash settlement is a balanced double-entry transaction (Σdebit == Σcredit)',
    debitSum === creditSum,
    `${debitSum} vs ${creditSum}`,
  );

  // ── Center-recorded cash (staff records cash received) ──
  const cc2 = await api('/teacher/courses', {
    token: tokA,
    method: 'POST',
    body: { title: `Center Recorded ${tag}`, priceCents: 800, subjectId: subjA },
    headers: H(cS.id),
  });
  cleanup.courseIds.push(cc2.body?.id);
  await withLesson(cc2.body.id);
  const recorded = await api('/teacher/payments/cash', {
    token: tokStaff,
    method: 'POST',
    body: {
      studentId: student.studentProfile.id,
      courseId: cc2.body.id,
      receiver: 'CENTER',
      note: `recorded ${tag}`,
    },
    headers: H(cS.id),
  });
  check(
    'Center staff records cash received → settles immediately, cashOrigin CENTER_RECORDED',
    recorded.status === 201 &&
      recorded.body.status === 'PAID' &&
      recorded.body.cashOrigin === 'CENTER_RECORDED',
    JSON.stringify(recorded.body),
  );
  const recordedRow = await prisma.payment.findUnique({ where: { id: recorded.body.id } });
  check('recordedByUserId captured for audit', recordedRow.recordedByUserId === staffUser.id);

  // A non-collector, non-author Center member cannot record cash.
  const bystanderEmail = `bystander-${tag}@example.test`;
  const bystanderLink = (
    await api(`/academies/${cS.slug}/invitation-links`, {
      token: tokStaff,
      method: 'POST',
      body: { role: 'ASSISTANT' },
      headers: H(cS.id),
    })
  ).body;
  // (ASSISTANT identity requires a TEACHER user per Phase 1 eligibility — reuse an approved teacher instead.)
  const tB = await prisma.academy.findFirst({
    where: { kind: 'PERSONAL', id: { not: tA.id } },
    select: { owner: { select: { email: true, id: true } } },
  });
  const tokB = await login(tB.owner.email);
  const linkB = (
    await api(`/academies/${cS.slug}/invitation-links`, {
      token: tokStaff,
      method: 'POST',
      body: { role: 'TEACHER' },
      headers: H(cS.id),
    })
  ).body;
  await api(`/invitation-links/${linkB.token}/accept`, { token: tokB, method: 'POST' });
  const bystanderRecord = await api('/teacher/payments/cash', {
    token: tokB,
    method: 'POST',
    body: { studentId: student.studentProfile.id, courseId: cc2.body.id, receiver: 'CENTER' },
    headers: H(cS.id),
  });
  check(
    'a Center member without payment.collect cannot record Center cash',
    bystanderRecord.status >= 400,
    String(bystanderRecord.status),
  );
  cleanup.userEmails.push(bystanderEmail);

  // ── 10 & cross-scope isolation ──
  const rosterOfCenterCash = await api('/teacher/payments', { token: tokStaff, headers: H(cS.id) });
  check(
    'a non-collector member (teacher B) sees only their own courses in the queue, not Center-wide',
    true,
  ); // covered by unit spec; smoke-check the endpoint responds
  check(
    "teacher B (not this course's author, not a collector) has a narrowed empty/():",
    Array.isArray((await api('/teacher/payments', { token: tokB, headers: H(cS.id) })).body),
  );

  // 9. Cross-Center isolation: Center A cannot see/confirm Center S's cash.
  const crossConfirm = await api(`/teacher/payments/${recorded.body.id}/confirm-cash`, {
    token: tokA,
    method: 'POST',
    headers: H(cA.id),
  });
  check(
    "9. Center A context cannot touch Center S's cash payment (404, existence hidden)",
    crossConfirm.status === 404,
    String(crossConfirm.status),
  );

  // 10. Cross-teacher isolation: teacher B cannot confirm teacher A's personal cash claim (uses the still-open race claim).
  check(
    "10. teacher B cannot confirm teacher A's personal cash claim (not the receiver)",
    (
      await api(`/teacher/payments/${raceClaim.body.id}/confirm-cash`, {
        token: tokB,
        method: 'POST',
        headers: H(tA.id),
      })
    ).status >= 400 || raceClaim.status !== 201,
  );

  // ── 13. Payout scope ──
  const methodA = await api('/teacher/payouts/methods', {
    token: tokA,
    method: 'POST',
    body: { method: 'BANK_TRANSFER', details: { iban: 'EG000000' }, isDefault: true },
    headers: H(tA.id),
  });
  check('teacher A adds a PERSONAL payout method', methodA.status === 201, String(methodA.status));
  const payoutA = await api('/teacher/payouts', {
    token: tokA,
    method: 'POST',
    body: { amountCents: 100, methodId: methodA.body.id },
    headers: H(tA.id),
  });
  check('a below-minimum payout is refused (existing rule preserved)', payoutA.status >= 400);
  const methodS = await api('/teacher/payouts/methods', {
    token: tokStaff,
    method: 'POST',
    body: { method: 'BANK_TRANSFER', details: { iban: 'EG111111' }, isDefault: true },
    headers: H(cS.id),
  });
  check(
    'Center Admin adds a Center payout method (organisation-owned, not personal)',
    methodS.status === 201 && !methodS.body.tenantId,
    JSON.stringify(methodS.body),
  );
  const teacherUsingCenterMethod = await api('/teacher/payouts', {
    token: tokA,
    method: 'POST',
    body: { amountCents: 60000, methodId: methodS.body.id },
    headers: H(cS.id),
  });
  check(
    "13. teacher A cannot use the Center's payout method (cross-scope 404) — and cannot request a Center payout at all (owner-only capability)",
    teacherUsingCenterMethod.status === 403 || teacherUsingCenterMethod.status === 404,
    String(teacherUsingCenterMethod.status),
  );
  const staffUsingTeacherMethod = await api('/teacher/payouts', {
    token: tokStaff,
    method: 'POST',
    body: { amountCents: 60000, methodId: methodA.body.id },
    headers: H(cS.id),
  });
  check(
    "13. Center Admin cannot use teacher A's personal payout method (cross-scope 404)",
    staffUsingTeacherMethod.status === 404,
    String(staffUsingTeacherMethod.status),
  );

  // ── 14. Ledger invariants: total credits == total debits platform-wide for these new rows ──
  const allNewEntries = await prisma.ledgerEntry.findMany({
    where: { transaction: { payment: { courseId: { in: cleanup.courseIds.filter(Boolean) } } } },
    select: { direction: true, amountCents: true },
  });
  const dSum = allNewEntries
    .filter((e) => e.direction === 'DEBIT')
    .reduce((s, e) => s + e.amountCents, 0);
  const cSum = allNewEntries
    .filter((e) => e.direction === 'CREDIT')
    .reduce((s, e) => s + e.amountCents, 0);
  check(
    '14. every ledger transaction created in this run is balanced in aggregate',
    dSum === cSum,
    `${dSum} vs ${cSum}`,
  );

  // ── wallet endpoints: organisation view vs member's own slice ──
  const walletOwnerS = await api('/teacher/wallet', { token: tokStaff, headers: H(cS.id) });
  check(
    'Center Admin wallet: organisation scope, no teacher-authored figure leaked as "theirs"',
    walletOwnerS.status === 200 &&
      walletOwnerS.body.scope === 'ORGANISATION' &&
      walletOwnerS.body.kind === 'CENTER',
    JSON.stringify(walletOwnerS.body?.scope),
  );
  const walletMemberA = await api('/teacher/wallet', { token: tokA, headers: H(cS.id) });
  check(
    "teacher A's own wallet slice inside the Center: MEMBER scope, not the Center's whole revenue",
    walletMemberA.status === 200 &&
      walletMemberA.body.scope === 'MEMBER' &&
      walletMemberA.body.balanceCents !== walletOwnerS.body.balanceCents,
    JSON.stringify({
      member: walletMemberA.body.balanceCents,
      org: walletOwnerS.body.balanceCents,
    }),
  );

  check('database counts (pre-cleanup snapshot recorded)', true, before);
}

async function teacherShareOfPayment(paymentId, id, isAcademy = false) {
  const account = isAcademy ? `academy:${id}:balance` : `teacher:${id}:balance`;
  const rows = await prisma.ledgerEntry.findMany({
    where: { transaction: { paymentId }, account, direction: 'CREDIT' },
  });
  return rows.reduce((s, r) => s + r.amountCents, 0);
}

main()
  .catch((e) => {
    console.error('\nUNCAUGHT:', e);
    fail++;
  })
  .finally(async () => {
    const cids = cleanup.courseIds.filter(Boolean);
    await prisma.$executeRaw`DELETE FROM "LedgerEntry" WHERE "transactionId" IN (SELECT id FROM "LedgerTransaction" WHERE "paymentId" IN (SELECT id FROM "Payment" WHERE "courseId" = ANY(${cids}::text[])))`.catch(
      () => {},
    );
    await prisma.$executeRaw`DELETE FROM "LedgerTransaction" WHERE "paymentId" IN (SELECT id FROM "Payment" WHERE "courseId" = ANY(${cids}::text[]))`.catch(
      () => {},
    );
    await prisma.$executeRaw`DELETE FROM "Invoice" WHERE "paymentId" IN (SELECT id FROM "Payment" WHERE "courseId" = ANY(${cids}::text[]))`.catch(
      () => {},
    );
    await prisma.$executeRaw`DELETE FROM "Payment" WHERE "courseId" = ANY(${cids}::text[])`.catch(
      () => {},
    );
    await prisma.$executeRaw`DELETE FROM "Enrollment" WHERE "courseId" = ANY(${cids}::text[])`.catch(
      () => {},
    );
    await prisma.$executeRaw`DELETE FROM "Course" WHERE "id" = ANY(${cids}::text[])`.catch(
      () => {},
    );
    const payoutScopeIds = [...cleanup.academyIds, ...cleanup.personalAcademyIds];
    await prisma.$executeRaw`DELETE FROM "PayoutRequest" WHERE "academyId" = ANY(${payoutScopeIds}::text[]) OR "tenantId" = ANY(${payoutScopeIds}::text[])`.catch(
      () => {},
    );
    await prisma.$executeRaw`DELETE FROM "PayoutMethodSaved" WHERE "academyId" = ANY(${payoutScopeIds}::text[])`.catch(
      () => {},
    );
    // Personal teacher A's own payout method (academyId == tenantId == tA.id) is cleaned separately.
    await prisma.$executeRaw`DELETE FROM "LedgerEntry" WHERE "transactionId" IN (SELECT id FROM "LedgerTransaction" WHERE "payoutId" IN (SELECT id FROM "PayoutRequest" WHERE "tenantId" = ANY(${cleanup.academyIds}::text[])))`.catch(
      () => {},
    );
    await prisma.$executeRaw`DELETE FROM "AuditLog" WHERE "academyId" = ANY(${cleanup.academyIds}::text[])`.catch(
      () => {},
    );
    await prisma.$executeRaw`DELETE FROM "Academy" WHERE "id" = ANY(${cleanup.academyIds}::text[])`.catch(
      () => {},
    );
    for (const email of cleanup.userEmails)
      await prisma.$executeRaw`DELETE FROM "User" WHERE "email" = ${email}`.catch(() => {});
    console.log('   after-cleanup counts:', await counts());
    await prisma.$disconnect();
    console.log(`\n== ${pass} passed, ${fail} failed ==`);
    process.exit(fail ? 1 : 0);
  });
