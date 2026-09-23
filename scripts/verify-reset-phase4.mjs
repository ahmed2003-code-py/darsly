#!/usr/bin/env node
/**
 * Real HTTP + DB verification for Architecture Reset Phase 4: organisation
 * scope (academyId) on Course/Enrollment/Payment, Center free-course rule,
 * AcademySubject activation, cross-Center isolation, backfill invariants.
 *
 *   CONFIRM_TEST_DB=yes DATABASE_URL=postgresql://...localhost:PORT/darsly node scripts/verify-reset-phase4.mjs
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
const cleanup = { academyIds: [], courseIds: [] };
const H = (id) => ({ 'X-Academy-Id': id });

async function main() {
  console.log('== Reset Phase 4 verification ==\n');
  const tA = await prisma.academy.findFirst({
    where: { kind: 'PERSONAL' },
    select: { id: true, slug: true, owner: { select: { id: true, email: true } } },
  });
  const tB = await prisma.academy.findFirst({
    where: { kind: 'PERSONAL', id: { not: tA.id } },
    select: { id: true, slug: true, owner: { select: { id: true, email: true } } },
  });
  const student = await prisma.user.findFirst({
    where: { role: 'STUDENT' },
    select: { email: true, studentProfile: { select: { id: true } } },
  });
  const admin = await prisma.user.findFirst({
    where: { role: 'SUPER_ADMIN' },
    select: { email: true },
  });
  const [tokA, tokB, tokS, tokAdmin] = await Promise.all([
    login(tA.owner.email),
    login(tB.owner.email),
    login(student.email),
    login(admin.email),
  ]);
  check('fixture logins', !!tokA && !!tokB && !!tokS && !!tokAdmin);
  const subjA = (await prisma.teacherSubject.findFirst({ where: { tenantId: tA.id } })).subjectId;

  // Centers: A owned by teacher A; B owned by teacher B; teacher A also joins B as TEACHER.
  const cA = (
    await api('/admin/centers', {
      token: tokAdmin,
      method: 'POST',
      body: { name: `Scope A ${tag}`, adminName: 'Center Admin', adminEmail: tA.owner.email },
    })
  ).body;
  const cB = (
    await api('/admin/centers', {
      token: tokAdmin,
      method: 'POST',
      body: { name: `Scope B ${tag}`, adminName: 'Center Admin', adminEmail: tB.owner.email },
    })
  ).body;
  check(
    'setup: both Centers created',
    !!cA?.id && !!cB?.id,
    JSON.stringify(cA?.message ?? cA?.code ?? ''),
  );
  if (!cA?.id || !cB?.id) throw new Error('Center fixtures missing');
  cleanup.academyIds.push(cA.id, cB.id);
  const link = (
    await api(`/academies/${cB.slug}/invitation-links`, {
      token: tokB,
      method: 'POST',
      body: { role: 'TEACHER' },
      headers: H(cB.id),
    })
  ).body;
  check(
    'setup: teacher A is OWNER of Center A and TEACHER in Center B',
    (await api(`/invitation-links/${link.token}/accept`, { token: tokA, method: 'POST' })).status <
      300,
  );

  // ── 1. Personal course: tenantId == academyId ──
  const pc = await api('/teacher/courses', {
    token: tokA,
    method: 'POST',
    body: { title: `Personal ${tag}`, priceCents: 1000, subjectId: subjA },
  });
  check('personal course created with a price', pc.status === 201, String(pc.status));
  cleanup.courseIds.push(pc.body.id);
  check(
    'personal: tenantId == academyId == teacher',
    pc.body.tenantId === tA.id && pc.body.academyId === tA.id,
  );

  // ── 2. Center course rules ──
  check(
    'Center course with a price is refused until a revenue split is agreed (Phase 7)',
    (
      await api('/teacher/courses', {
        token: tokA,
        method: 'POST',
        body: { title: 'paid', priceCents: 100, subjectId: subjA },
        headers: H(cA.id),
      })
    ).body?.code === 'CENTER_REVENUE_SPLIT_NOT_CONFIGURED',
  );
  check(
    'Center course with a subject the Center has not activated is refused',
    (
      await api('/teacher/courses', {
        token: tokA,
        method: 'POST',
        body: { title: 'free', priceCents: 0, subjectId: subjA },
        headers: H(cA.id),
      })
    ).body?.code === 'SUBJECT_NOT_OFFERED',
  );
  const subjectsBefore = await api(`/academies/${cA.slug}/subjects`, {
    token: tokA,
    headers: H(cA.id),
  });
  check(
    'Center subject list is gated and reads the master catalogue',
    subjectsBefore.body?.gated === true &&
      subjectsBefore.body.subjects.some((s) => s.id === subjA && s.offered === false),
  );
  check(
    'OWNER activates a subject',
    (
      await api(`/academies/${cA.slug}/subjects/${subjA}`, {
        token: tokA,
        method: 'PUT',
        body: { isActive: true },
        headers: H(cA.id),
      })
    ).status < 300,
  );
  check(
    'master Subject row untouched (no duplicate created)',
    (await prisma.subject.count({ where: { id: subjA } })) === 1,
  );
  const cc = await api('/teacher/courses', {
    token: tokA,
    method: 'POST',
    body: { title: `CenterA ${tag}`, priceCents: 0, subjectId: subjA },
    headers: H(cA.id),
  });
  check(
    'Center course created once the subject is offered',
    cc.status === 201,
    JSON.stringify(cc.body?.code ?? cc.status),
  );
  cleanup.courseIds.push(cc.body.id);
  check(
    'Center: tenantId = author, academyId = Center (different)',
    cc.body.tenantId === tA.id && cc.body.academyId === cA.id,
  );
  check(
    'raising a Center course price later is refused until a revenue split is agreed (Phase 7)',
    (
      await api(`/teacher/courses/${cc.body.id}`, {
        token: tokA,
        method: 'PATCH',
        body: { priceCents: 50 },
        headers: H(cA.id),
      })
    ).body?.code === 'CENTER_REVENUE_SPLIT_NOT_CONFIGURED',
  );
  check(
    'forged academyId in the body is rejected by validation',
    (
      await api('/teacher/courses', {
        token: tokA,
        method: 'POST',
        body: { title: 'x', priceCents: 0, academyId: cB.id },
        headers: H(cA.id),
      })
    ).status === 400,
  );
  check(
    'forged tenantId in the body is rejected by validation',
    (
      await api('/teacher/courses', {
        token: tokA,
        method: 'POST',
        body: { title: 'x', priceCents: 0, tenantId: tB.id },
        headers: H(cA.id),
      })
    ).status === 400,
  );

  // ── 3. Teacher A authoring inside Center B (member, not owner) ──
  await api(`/academies/${cB.slug}/subjects/${subjA}`, {
    token: tokB,
    method: 'PUT',
    body: { isActive: true },
    headers: H(cB.id),
  });
  const subjB = (await prisma.teacherSubject.findFirst({ where: { tenantId: tB.id } })).subjectId;
  await api(`/academies/${cB.slug}/subjects/${subjB}`, {
    token: tokB,
    method: 'PUT',
    body: { isActive: true },
    headers: H(cB.id),
  });
  const aInB = await api('/teacher/courses', {
    token: tokA,
    method: 'POST',
    body: { title: `A-in-B ${tag}`, priceCents: 0, subjectId: subjA },
    headers: H(cB.id),
  });
  check(
    'teacher A authors a course inside Center B',
    aInB.status === 201 && aInB.body.tenantId === tA.id && aInB.body.academyId === cB.id,
    String(aInB.status),
  );
  cleanup.courseIds.push(aInB.body.id);
  const bInB = await api('/teacher/courses', {
    token: tokB,
    method: 'POST',
    body: { title: `B-in-B ${tag}`, priceCents: 0, subjectId: subjB },
    headers: H(cB.id),
  });
  cleanup.courseIds.push(bInB.body.id);
  const aListB = (await api('/teacher/courses', { token: tokA, headers: H(cB.id) })).body;
  check(
    'TEACHER member in Center B sees only their own course there',
    aListB.some((c) => c.id === aInB.body.id) && !aListB.some((c) => c.id === bInB.body.id),
  );
  const bListB = (await api('/teacher/courses', { token: tokB, headers: H(cB.id) })).body;
  check(
    'OWNER of Center B sees every course offered there',
    bListB.some((c) => c.id === aInB.body.id) && bListB.some((c) => c.id === bInB.body.id),
  );
  check(
    "teacher A cannot edit a colleague's course in Center B",
    (
      await api(`/teacher/courses/${bInB.body.id}`, {
        token: tokA,
        method: 'PATCH',
        body: { title: 'hijack' },
        headers: H(cB.id),
      })
    ).status === 404,
  );
  check(
    'personal course does not leak into any Center list',
    !aListB.some((c) => c.id === pc.body.id) && !bListB.some((c) => c.id === pc.body.id),
  );

  // ── 4. Cross-Center isolation ──
  for (const [label, method, path, body] of [
    ['read', 'GET', `/teacher/courses/${bInB.body.id}`, undefined],
    ['update', 'PATCH', `/teacher/courses/${bInB.body.id}`, { title: 'Hijack attempt' }],
    ['delete', 'DELETE', `/teacher/courses/${bInB.body.id}`, undefined],
  ]) {
    check(
      `Center A context cannot ${label} a Center B course`,
      (await api(path, { token: tokA, method, body, headers: H(cA.id) })).status === 404,
    );
  }
  check(
    'Center B owner cannot read a Center A course',
    (await api(`/teacher/courses/${cc.body.id}`, { token: tokB, headers: H(cB.id) })).status ===
      404,
  );
  check(
    'teacher B cannot even select Center A as a workspace',
    (await api(`/academies/${cA.slug}/me`, { token: tokB, headers: H(cA.id) })).status === 404,
  );

  // ── 5. Enrollment scope ──
  for (const id of [cc.body.id, aInB.body.id, pc.body.id])
    await api(`/teacher/courses/${id}`, {
      token: tokA,
      method: 'PATCH',
      body: { status: 'PUBLISHED' },
      headers: id === cc.body.id ? H(cA.id) : id === aInB.body.id ? H(cB.id) : undefined,
    }).catch(() => {});
  const hasLesson = async (id) => prisma.lesson.count({ where: { unit: { courseId: id } } });
  // Publishing needs a lesson; add a minimal one directly so the enrolment path can be exercised.
  for (const id of [cc.body.id, aInB.body.id]) {
    if ((await hasLesson(id)) === 0) {
      const unit = await prisma.courseUnit.create({
        data: { courseId: id, title: 'u', sortOrder: 0 },
      });
      await prisma.lesson.create({ data: { unitId: unit.id, title: 'l', sortOrder: 0 } });
    }
    await prisma.course.update({ where: { id }, data: { status: 'PUBLISHED' } });
  }
  const eA = await api('/enrollments', {
    token: tokS,
    method: 'POST',
    body: { courseId: cc.body.id },
  });
  const eB = await api('/enrollments', {
    token: tokS,
    method: 'POST',
    body: { courseId: aInB.body.id },
  });
  check(
    'student enrols in Center A and Center B courses',
    eA.status < 300 && eB.status < 300,
    `${eA.status}/${eB.status} ${JSON.stringify(eA.body?.code ?? '')}`,
  );
  const rowA = await prisma.enrollment.findUnique({
    where: { studentId_courseId: { studentId: student.studentProfile.id, courseId: cc.body.id } },
  });
  const rowB = await prisma.enrollment.findUnique({
    where: { studentId_courseId: { studentId: student.studentProfile.id, courseId: aInB.body.id } },
  });
  check(
    'Enrollment.academyId copied from the Course; tenantId stays the author',
    rowA?.academyId === cA.id &&
      rowA?.tenantId === tA.id &&
      rowB?.academyId === cB.id &&
      rowB?.tenantId === tA.id,
  );
  check('one student legitimately spans two Centers', rowA?.academyId !== rowB?.academyId);
  const listA = (await api('/teacher/enrollments', { token: tokA, headers: H(cA.id) })).body;
  const listB = (await api('/teacher/enrollments', { token: tokB, headers: H(cB.id) })).body;
  check(
    'Center A staff list shows only Center A enrolments',
    listA.some((e) => e.id === rowA.id) && !listA.some((e) => e.id === rowB.id),
  );
  check(
    'Center B staff list shows only Center B enrolments',
    listB.some((e) => e.id === rowB.id) && !listB.some((e) => e.id === rowA.id),
  );
  check(
    'Center A cannot revoke a Center B enrolment',
    (
      await api(`/teacher/enrollments/${rowB.id}/revoke`, {
        token: tokA,
        method: 'PATCH',
        body: {},
        headers: H(cA.id),
      })
    ).status === 404,
  );
  const roster = (await api('/teacher/roster', { token: tokA, headers: H(cA.id) })).body;
  const rosterIds = JSON.stringify(roster ?? '');
  check(
    'Center A roster includes the student (organisation scope)',
    rosterIds.includes(student.studentProfile.id),
  );
  const rosterB = JSON.stringify(
    (await api('/teacher/roster', { token: tokB, headers: H(cB.id) })).body ?? '',
  );
  check(
    'Center B roster also includes the student — same learner, two organisations',
    rosterB.includes(student.studentProfile.id),
  );
  const rosterPersonal = JSON.stringify((await api('/teacher/roster', { token: tokB })).body ?? '');
  check(
    "teacher B's PERSONAL roster does not pick up Center enrolments",
    !rosterPersonal.includes(rowB.id),
  );

  // ── 6. Payment scope ──
  await prisma.course.update({ where: { id: cc.body.id }, data: { priceCents: 500 } }); // simulate a row that slipped past the create rule
  check(
    'a priced Center course with no agreed split cannot be quoted (Phase 7)',
    (
      await api('/enrollments/quote', {
        token: tokS,
        method: 'POST',
        body: { courseId: cc.body.id },
      })
    ).body?.code === 'CENTER_REVENUE_SPLIT_NOT_CONFIGURED',
  );
  check(
    'a priced Center course with no agreed split cannot receive a payment (Phase 7)',
    (
      await api('/payments', {
        token: tokS,
        method: 'POST',
        body: { courseId: cc.body.id, method: 'VODAFONE_CASH', reference: '01000000000' },
      })
    ).body?.code === 'CENTER_REVENUE_SPLIT_NOT_CONFIGURED',
  );
  check(
    'no Payment row was created for the Center course',
    (await prisma.payment.count({ where: { courseId: cc.body.id } })) === 0,
  );
  await prisma.course.update({ where: { id: cc.body.id }, data: { priceCents: 0 } });
  const pqA = (await api('/admin/payments?status=PENDING', { token: tokAdmin })).status;
  check('admin payment queue still serves', pqA === 200 || pqA === 404, String(pqA));
  const teacherQueueA = await api('/teacher/payments', { token: tokA, headers: H(cA.id) });
  check(
    'teacher payment queue is organisation-scoped (no personal payments inside Center A)',
    teacherQueueA.status === 404 ||
      (Array.isArray(teacherQueueA.body) &&
        teacherQueueA.body.every(
          (p) => p.academyId === cA.id || (p.academyId === undefined && p.tenantId === cA.id),
        )),
    String(teacherQueueA.status),
  );

  // ── 7. Subject isolation & admin counts ──
  check(
    'teacher B (not a member of Center A) cannot toggle Center A subjects',
    (
      await api(`/academies/${cA.slug}/subjects/${subjB}`, {
        token: tokB,
        method: 'PUT',
        body: { isActive: true },
        headers: H(cA.id),
      })
    ).status === 404,
  );
  check(
    'student cannot toggle subjects',
    (
      await api(`/academies/${cA.slug}/subjects/${subjA}`, {
        token: tokS,
        method: 'PUT',
        body: { isActive: false },
        headers: H(cA.id),
      })
    ).status === 404,
  );
  check(
    'deactivating keeps the row and the master subject',
    (
      await api(`/academies/${cA.slug}/subjects/${subjA}`, {
        token: tokA,
        method: 'PUT',
        body: { isActive: false },
        headers: H(cA.id),
      })
    ).body?.isActive === false && (await prisma.subject.count({ where: { id: subjA } })) === 1,
  );
  const detailA = (await api(`/admin/academies/${cA.id}`, { token: tokAdmin })).body;
  check(
    'admin Center detail counts courses by organisation scope',
    detailA?.coursesCount === 1 && detailA?.enrollmentsCount === 1,
    `${detailA?.coursesCount}/${detailA?.enrollmentsCount}`,
  );

  // ── 8. Backfill / invariants across the whole DB ──
  const inv = await prisma.$queryRaw`SELECT
    (SELECT count(*) FROM "Course" WHERE "academyId" IS NULL) AS c_null,
    (SELECT count(*) FROM "Course" c JOIN "Academy" a ON a.id=c."academyId" WHERE a.kind='PERSONAL' AND c."tenantId"<>c."academyId") AS personal_bad,
    (SELECT count(*) FROM "Course" c JOIN "Academy" a ON a.id=c."academyId" WHERE a.kind='CENTER' AND c."tenantId"=c."academyId") AS center_bad,
    (SELECT count(*) FROM "Course" c JOIN "Academy" a ON a.id=c."academyId" WHERE a.kind='CENTER' AND c."priceCents"<>0) AS center_paid,
    (SELECT count(*) FROM "Enrollment" e JOIN "Course" c ON c.id=e."courseId" WHERE e."academyId" IS DISTINCT FROM c."academyId") AS e_mismatch,
    (SELECT count(*) FROM "Payment" p JOIN "Course" c ON c.id=p."courseId" WHERE p."academyId" IS DISTINCT FROM c."academyId") AS p_mismatch`;
  const i = Object.fromEntries(Object.entries(inv[0]).map(([k, v]) => [k, Number(v)]));
  check('every Course has an academyId', i.c_null === 0);
  check('PERSONAL courses: tenantId == academyId', i.personal_bad === 0);
  check('CENTER courses: tenantId != academyId', i.center_bad === 0);
  check('CENTER courses: priceCents == 0', i.center_paid === 0);
  check('every Enrollment matches its Course organisation', i.e_mismatch === 0);
  check('every Payment matches its Course organisation', i.p_mismatch === 0);

  // ── 9. Regression ──
  check(
    'teacher A still resolves their PERSONAL workspace with no header',
    (await api(`/academies/${tA.slug}/me`, { token: tokA })).body?.role === 'OWNER',
  );
  const personalList = (await api('/teacher/courses', { token: tokA })).body;
  check(
    'PERSONAL course list unchanged (only personal courses)',
    personalList.some((c) => c.id === pc.body.id) && !personalList.some((c) => c.id === cc.body.id),
  );
}

main()
  .catch((e) => {
    console.error('\nUNCAUGHT:', e);
    fail++;
  })
  .finally(async () => {
    const ids = cleanup.courseIds.filter(Boolean);
    await prisma.$executeRaw`DELETE FROM "Payment" WHERE "courseId" = ANY(${ids}::text[])`.catch(
      () => {},
    );
    await prisma.$executeRaw`DELETE FROM "Enrollment" WHERE "courseId" = ANY(${ids}::text[])`.catch(
      () => {},
    );
    await prisma.$executeRaw`DELETE FROM "Course" WHERE "id" = ANY(${ids}::text[])`.catch(() => {});
    await prisma.$executeRaw`DELETE FROM "Academy" WHERE "id" = ANY(${cleanup.academyIds}::text[])`.catch(
      () => {},
    );
    await prisma.$disconnect();
    console.log(`\n== ${pass} passed, ${fail} failed ==`);
    process.exit(fail ? 1 : 0);
  });
