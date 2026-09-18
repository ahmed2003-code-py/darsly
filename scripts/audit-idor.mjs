#!/usr/bin/env node
/**
 * Can one account reach another account's data?
 *
 * The previous phase spot-checked two cases and passed. This is the sweep: for
 * each resource class, find a row that genuinely belongs to somebody else and
 * ask for it with the wrong credentials — as the other student, as the other
 * teacher, and as nobody at all.
 *
 *   DATABASE_URL=... API_URL=... node scripts/audit-idor.mjs
 *
 * Read-only apart from logging in, and the write probes are aimed at other
 * people's rows: if one of them succeeds that IS the finding, and the run says
 * so loudly. Nothing of the caller's own is modified.
 *
 * What counts as a pass: 401 unauthenticated, and 403 or 404 authenticated.
 * 404 is not a weaker answer than 403 here — for a resource the caller has no
 * business knowing exists, refusing to confirm it exists is the better one.
 * What counts as a failure is a 2xx, or a body carrying the other party's data.
 */
const API = process.env.API_URL ?? 'http://127.0.0.1:3077/api/v1';
const PASSWORD = 'Darsly@123';

let pass = 0, fail = 0;
const findings = [];

function check(resource, probe, ok, detail) {
  if (ok) { pass++; return; }
  fail++;
  findings.push({ resource, probe, detail });
  console.log(`   FAIL  ${resource} — ${probe}  (${detail})`);
}

async function api(path, { token, method = 'GET', body } = {}) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}

async function login(email) {
  const r = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  if (r.status >= 300) throw new Error(`login ${email}: ${r.status}`);
  return r.body.accessToken;
}

/**
 * One probe: ask for somebody else's resource three ways.
 *
 * `leak` is given the response body and returns true if it contains something
 * that identifies the resource — a status alone can be misleading, since an
 * endpoint may answer 200 with an empty list rather than refusing outright.
 */
async function probe(resource, path, { asOther, asTeacher, anon = true, method = 'GET', body, leak } = {}) {
  if (anon) {
    const r = await api(path, { method, body });
    check(resource, 'unauthenticated', r.status === 401 || r.status === 403 || r.status === 404, `HTTP ${r.status}`);
  }
  if (asOther) {
    const r = await api(path, { token: asOther, method, body });
    const bad = r.status < 300 && (leak ? leak(r.body) : true);
    check(resource, 'as the other student', !bad, `HTTP ${r.status}${bad ? ' — RETURNED DATA' : ''}`);
  }
  if (asTeacher) {
    const r = await api(path, { token: asTeacher, method, body });
    const bad = r.status < 300 && (leak ? leak(r.body) : true);
    check(resource, 'as the other teacher', !bad, `HTTP ${r.status}${bad ? ' — RETURNED DATA' : ''}`);
  }
}

const { PrismaClient } = await import('@prisma/client');
const prisma = new PrismaClient();

// ── two students in different academies, two teachers, one admin ───────────
const enrolments = await prisma.enrollment.findMany({
  where: { status: 'ACTIVE' }, take: 200,
  include: { student: { include: { user: true } }, course: true },
});
const byTenant = new Map();
for (const e of enrolments) if (!byTenant.has(e.tenantId)) byTenant.set(e.tenantId, e);
const [eA, eB] = [...byTenant.values()];
if (!eA || !eB) throw new Error('need active enrolments in two different academies — seed the database');

const A = { student: eA.student, token: await login(eA.student.user.email), tenantId: eA.tenantId, course: eA.course, enrolment: eA };
const B = { student: eB.student, token: await login(eB.student.user.email), tenantId: eB.tenantId, course: eB.course, enrolment: eB };

const tA = await prisma.teacherProfile.findUnique({ where: { id: A.tenantId }, include: { user: true } });
const tB = await prisma.teacherProfile.findUnique({ where: { id: B.tenantId }, include: { user: true } });
const teacherA = { profile: tA, token: await login(tA.user.email) };
const teacherB = { profile: tB, token: await login(tB.user.email) };

console.log(`student A  ${A.student.user.email}   academy ${A.tenantId.slice(0, 10)}`);
console.log(`student B  ${B.student.user.email}   academy ${B.tenantId.slice(0, 10)}`);
console.log(`teacher A  ${tA.user.email}`);
console.log(`teacher B  ${tB.user.email}`);
console.log('\nprobing… only failures are printed\n');

// ── the resources B owns, that A must not reach ───────────────────────────
const bPayment = await prisma.payment.findFirst({ where: { studentId: B.student.id } });
const bCert = await prisma.certificate.findFirst({ where: { studentId: B.student.id } });
const bThread = await prisma.chatThread.findFirst({ where: { studentId: B.student.id } });
const bAttempt = await prisma.quizAttempt.findFirst({ where: { studentId: B.student.id } });
const bTopup = await prisma.walletTopup.findFirst({ where: { studentId: B.student.id } });
const bNote = await prisma.videoNote.findFirst({ where: { studentId: B.student.id } });
const bLesson = await prisma.lesson.findFirst({ where: { unit: { course: { tenantId: B.tenantId } } } });
const bUnit = await prisma.courseUnit.findFirst({ where: { course: { tenantId: B.tenantId } } });
const bLive = await prisma.liveSession.findFirst({ where: { tenantId: B.tenantId } });
/**
 * An attachment on a GATED lesson.
 *
 * The seed puts every attachment on a free-preview lesson, and a preview's
 * handout is downloadable by any signed-in user on purpose — it is the shop
 * window. Probing one of those reports an IDOR that is not one, and leaves the
 * case that matters untested. So the gated case is created here when the data
 * does not already contain one.
 */
let bAttachment = await prisma.attachment.findFirst({
  where: { lesson: { isFreePreview: false, unit: { course: { tenantId: B.tenantId } } } },
});
let madeGatedLesson = null;
if (!bAttachment) {
  const sample = await prisma.attachment.findFirst({
    where: { lesson: { unit: { course: { tenantId: B.tenantId } } } },
  });
  const unit = await prisma.courseUnit.findFirst({ where: { course: { tenantId: B.tenantId } } });
  if (sample && unit) {
    madeGatedLesson = await prisma.lesson.create({
      data: { unitId: unit.id, title: 'IDOR probe — gated lesson', type: 'VIDEO', isFreePreview: false, sortOrder: 9999 },
    });
    bAttachment = await prisma.attachment.create({
      data: {
        lessonId: madeGatedLesson.id, fileName: 'gated.pdf', mimeType: 'application/pdf',
        sizeBytes: sample.sizeBytes, storageKey: sample.storageKey,
      },
    });
  }
}
const bPreviewAttachment = await prisma.attachment.findFirst({
  where: { lesson: { isFreePreview: true, unit: { course: { tenantId: B.tenantId } } } },
});
const bMedia = await prisma.academyMedia?.findFirst?.({ where: { academyId: B.tenantId } }).catch(() => null);
const bPayout = await prisma.payoutRequest.findFirst({ where: { tenantId: B.tenantId } });
const bAcademy = await prisma.academy.findUnique({ where: { id: B.tenantId } });

// ── student-owned resources ───────────────────────────────────────────────
console.log('— student-owned —');
if (bPayment) await probe('payment', `/payments/${bPayment.id}`, { asOther: A.token, asTeacher: teacherA.token, leak: (b) => b?.id === bPayment.id });
if (bCert) await probe('certificate', `/certificates/${bCert.id}`, { asOther: A.token, leak: (b) => b?.id === bCert.id });
if (bThread) {
  await probe('chat thread', `/threads/${bThread.id}`, { asOther: A.token, asTeacher: teacherA.token, leak: (b) => b?.id === bThread.id });
  await probe('chat messages', `/threads/${bThread.id}/messages`, { asOther: A.token, asTeacher: teacherA.token, leak: (b) => Array.isArray(b) && b.length > 0 });
}
if (bAttempt) await probe('quiz attempt', `/quiz-attempts/${bAttempt.id}`, { asOther: A.token, leak: (b) => b?.id === bAttempt.id });
if (bTopup) await probe('wallet top-up', `/wallet/topups/${bTopup.id}`, { asOther: A.token, leak: (b) => b?.id === bTopup.id });
if (bNote) await probe('video note (delete)', `/notes/${bNote.id}`, { asOther: A.token, method: 'DELETE' });
await probe("another student's enrolment (hide)", `/enrollments/${B.enrolment.id}/hide`, { asOther: A.token, method: 'POST' });

// ── teacher / tenant-owned resources ──────────────────────────────────────
console.log('— tenant-owned —');
if (bLesson) {
  await probe('lesson (delete)', `/lessons/${bLesson.id}`, { asTeacher: teacherA.token, method: 'DELETE' });
  await probe('lesson quiz (teacher view)', `/teacher/lessons/${bLesson.id}/quiz`, { asTeacher: teacherA.token, leak: (b) => !!b?.id });
}
if (bUnit) await probe('course unit (delete)', `/units/${bUnit.id}`, { asTeacher: teacherA.token, method: 'DELETE' });
await probe("another academy's course (update)", `/teacher/courses/${B.course.id}`, {
  asTeacher: teacherA.token, method: 'PATCH', body: { title: 'IDOR PROBE — should never land' },
});
await probe("another academy's course (delete)", `/teacher/courses/${B.course.id}`, { asTeacher: teacherA.token, method: 'DELETE' });
if (bLive) {
  await probe('live session detail', `/live/${bLive.id}/detail`, { asOther: A.token, asTeacher: teacherA.token, leak: (b) => b?.id === bLive.id });
  await probe('live session (teacher delete)', `/teacher/live/${bLive.id}`, { asTeacher: teacherA.token, method: 'DELETE' });
}
if (bAttachment) {
  await probe('attachment on a GATED lesson', `/files/attachments/${bAttachment.id}`, { asOther: A.token });
}
if (bPreviewAttachment) {
  // The opposite expectation: a free preview's handout SHOULD be reachable by a
  // signed-in user, and refusing it would be the bug. Asserted so the gated check
  // above can never be "fixed" by locking the shop window.
  const r = await api(`/files/attachments/${bPreviewAttachment.id}`, { token: A.token });
  check('attachment on a FREE PREVIEW lesson', 'stays reachable by design', r.status < 300, `HTTP ${r.status}`);
}
if (bMedia) await probe('academy media', `/academy/media/${bMedia.id}`, { asTeacher: teacherA.token, leak: (b) => b?.id === bMedia.id });
if (bPayout) await probe("another academy's payout", `/teacher/payouts/${bPayout.id}`, { asTeacher: teacherA.token, leak: (b) => b?.id === bPayout.id });

// ── academy console, by slug ───────────────────────────────────────────────
if (bAcademy) {
  console.log('— academy console —');
  for (const p of ['console', 'settings', 'members', 'manage/courses']) {
    await probe(`academy ${p}`, `/academies/${bAcademy.slug}/${p}`, { asTeacher: teacherA.token, asOther: A.token, leak: (b) => !!b && !b.message });
  }
}

// ── admin surface, from every non-admin seat ──────────────────────────────
console.log('— admin surface —');
for (const p of ['/admin/payment-events', '/admin/wallet/topups', '/admin/payments', '/admin/users', '/admin/academies']) {
  const r1 = await api(p, { token: A.token });
  check('admin route', `${p} as a student`, r1.status === 401 || r1.status === 403 || r1.status === 404, `HTTP ${r1.status}`);
  const r2 = await api(p, { token: teacherA.token });
  check('admin route', `${p} as a teacher`, r2.status === 401 || r2.status === 403 || r2.status === 404, `HTTP ${r2.status}`);
}

// ── tenant scoping on list endpoints: does A's list contain B's rows? ─────
console.log('— list scoping —');
{
  const mine = await api('/enrollments/mine', { token: A.token });
  const rows = Array.isArray(mine.body) ? mine.body : mine.body?.items ?? [];
  const foreign = rows.filter((e) => e.studentId && e.studentId !== A.student.id).length;
  check('enrolment list', 'contains only my own rows', foreign === 0, `${foreign} foreign rows`);

  const tCourses = await api('/teacher/courses', { token: teacherA.token });
  const cRows = Array.isArray(tCourses.body) ? tCourses.body : tCourses.body?.items ?? [];
  const otherTenant = cRows.filter((c) => c.tenantId && c.tenantId !== A.tenantId).length;
  check('teacher course list', "contains only this academy's courses", otherTenant === 0, `${otherTenant} foreign courses`);

  const tStudents = await api('/teacher/enrollments', { token: teacherA.token });
  const sRows = Array.isArray(tStudents.body) ? tStudents.body : tStudents.body?.items ?? [];
  const foreignStudents = sRows.filter((e) => e.tenantId && e.tenantId !== A.tenantId).length;
  check('teacher student list', "contains only this academy's students", foreignStudents === 0, `${foreignStudents} foreign`);
}

// ── did the write probes actually change anything? ────────────────────────
console.log('— confirming no write landed —');
{
  const course = await prisma.course.findUnique({ where: { id: B.course.id } });
  check("another academy's course", 'title unchanged by the update probe', course?.title !== 'IDOR PROBE — should never land', course?.title ?? 'gone');
  check("another academy's course", 'still exists after the delete probe', !!course && !course.deletedAt, course?.deletedAt ? 'soft-deleted' : 'present');
  if (bLesson) {
    const l = await prisma.lesson.findUnique({ where: { id: bLesson.id } });
    check("another academy's lesson", 'survived the delete probe', !!l && !l.deletedAt, l?.deletedAt ? 'soft-deleted' : 'present');
  }
  if (bNote) {
    const n = await prisma.videoNote.findUnique({ where: { id: bNote.id } });
    check("another student's note", 'survived the delete probe', !!n && !n.deletedAt, n?.deletedAt ? 'soft-deleted' : 'present');
  }
  const enr = await prisma.enrollment.findUnique({ where: { id: B.enrolment.id } });
  check("another student's enrolment", 'not hidden by the probe', !enr?.hiddenAt, enr?.hiddenAt ? 'HIDDEN' : 'untouched');
}

if (madeGatedLesson) {
  await prisma.attachment.deleteMany({ where: { lessonId: madeGatedLesson.id } }).catch(() => {});
  await prisma.lesson.delete({ where: { id: madeGatedLesson.id } }).catch(() => {});
}
await prisma.$disconnect();
console.log(`\n${fail === 0 ? 'IDOR SWEEP PASS' : `IDOR SWEEP — ${fail} FAILURE(S)`}  —  ${pass} probes passed, ${fail} failed`);
if (findings.length) {
  console.log('\nfailures:');
  for (const f of findings) console.log(`  ${f.resource} — ${f.probe} — ${f.detail}`);
}
process.exit(fail === 0 ? 0 : 1);
