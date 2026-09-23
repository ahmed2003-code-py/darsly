#!/usr/bin/env node
/**
 * Real HTTP + DB verification for Architecture Reset Phase 6: Center
 * operations (admin, members, students, courses, groups, attendance, rooms,
 * subjects, settings) and organisation-scoped analytics. Local only.
 *
 *   CONFIRM_TEST_DB=yes DATABASE_URL=postgresql://...localhost:PORT/darsly node scripts/verify-reset-phase6.mjs
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
const staffEmail = `staff-ops-${tag}@example.test`;
const cleanup = { academyIds: [], groupIds: [], courseIds: [] };
const counts = async () =>
  JSON.stringify({
    a: await prisma.academy.count(),
    m: await prisma.academyMembership.count(),
    c: await prisma.course.count(),
    e: await prisma.enrollment.count(),
    g: await prisma.group.count(),
    gm: await prisma.groupMembership.count(),
    r: await prisma.room.count(),
    att: await prisma.attendanceSession.count(),
    ar: await prisma.attendanceRecord.count(),
    s: await prisma.academySubject.count(),
    u: await prisma.user.count(),
    al: await prisma.auditLog.count(),
  });

async function main() {
  console.log('== Reset Phase 6 verification ==\n');
  const before = await counts();
  const beforeAudit = await prisma.auditLog.count();

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
    select: { id: true, email: true, studentProfile: { select: { id: true } } },
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

  // Centers: A (owner = teacher A), B (owner = teacher B; teacher A joins as TEACHER), S (STAFF admin, non-teaching).
  const cA = (
    await api('/admin/centers', {
      token: tokAdmin,
      method: 'POST',
      body: { name: `Ops A ${tag}`, adminName: 'Center Admin', adminEmail: tA.owner.email },
    })
  ).body;
  const cB = (
    await api('/admin/centers', {
      token: tokAdmin,
      method: 'POST',
      body: { name: `Ops B ${tag}`, adminName: 'Center Admin', adminEmail: tB.owner.email },
    })
  ).body;
  const cS = (
    await api('/admin/centers', {
      token: tokAdmin,
      method: 'POST',
      body: { name: `Ops S ${tag}`, adminName: 'Staff Admin', adminEmail: staffEmail },
    })
  ).body;
  check('setup: three Centers', !!cA?.id && !!cB?.id && !!cS?.id);
  if (!cA?.id || !cB?.id || !cS?.id) throw new Error('fixtures');
  cleanup.academyIds.push(cA.id, cB.id, cS.id);
  const staffUser = await prisma.user.findUnique({ where: { email: staffEmail } });
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
  check('setup: STAFF admin logs in', !!tokStaff);
  const link = (
    await api(`/academies/${cB.slug}/invitation-links`, {
      token: tokB,
      method: 'POST',
      body: { role: 'TEACHER' },
      headers: H(cB.id),
    })
  ).body;
  check(
    'setup: teacher A is TEACHER in Center B',
    (await api(`/invitation-links/${link.token}/accept`, { token: tokA, method: 'POST' })).status <
      300,
  );

  // ── 1. Center Admin operations: own Center only, no platform operations ──
  // A non-member's selector resolves to no context: 404 (existence hidden), the Phase 1 contract.
  const denied = (st) => st === 403 || st === 404;
  const membersS = await api(`/academies/${cS.slug}/members`, {
    token: tokStaff,
    headers: H(cS.id),
  });
  check(
    'STAFF admin lists own Center members',
    membersS.status === 200 &&
      Array.isArray(membersS.body) &&
      membersS.body.some((m) => m.userId === staffUser.id || m.user?.id === staffUser.id),
    String(membersS.status),
  );
  check(
    "STAFF admin cannot read another Center's members (selector rejected)",
    denied(
      (await api(`/academies/${cA.slug}/members`, { token: tokStaff, headers: H(cA.id) })).status,
    ),
  );
  check(
    'STAFF admin cannot create a Center',
    (
      await api('/admin/centers', {
        token: tokStaff,
        method: 'POST',
        body: { name: 'Rogue', adminName: 'Rogue Admin', adminEmail: `rogue-${tag}@example.test` },
      })
    ).status === 403,
  );
  check(
    'STAFF admin cannot list platform academies',
    (await api('/admin/academies', { token: tokStaff })).status === 403,
  );
  check(
    'STAFF admin cannot change a Center status (platform op)',
    (
      await api(`/admin/centers/${cS.id}/status`, {
        token: tokStaff,
        method: 'PATCH',
        body: { status: 'SUSPENDED' },
      })
    ).status === 403,
  );
  check(
    'STAFF admin cannot read platform analytics',
    (await api('/admin/analytics/growth', { token: tokStaff })).status === 403,
  );
  const rename = await api(`/academies/${cS.slug}/settings`, {
    token: tokStaff,
    method: 'PATCH',
    body: { name: `Ops S renamed ${tag}`, tagline: 'Hello' },
    headers: H(cS.id),
  });
  check(
    'STAFF admin updates own Center profile (allowed fields)',
    rename.status < 300,
    String(rename.status),
  );
  const forgedKind = await api(`/academies/${cS.slug}/settings`, {
    token: tokStaff,
    method: 'PATCH',
    body: { kind: 'PERSONAL', status: 'SUSPENDED', ownerUserId: tA.owner.id },
    headers: H(cS.id),
  });
  const sAfter = await prisma.academy.findUnique({
    where: { id: cS.id },
    select: { kind: true, status: true, ownerUserId: true, name: true },
  });
  check(
    'kind/status/owner cannot be changed through settings',
    sAfter.kind === 'CENTER' && sAfter.status === 'ACTIVE' && sAfter.ownerUserId === staffUser.id,
    `${forgedKind.status}`,
  );
  check('rename persisted', sAfter.name === `Ops S renamed ${tag}`);
  check(
    'teacher A (TEACHER in Center B) cannot manage Center B members',
    (await api(`/academies/${cB.slug}/members`, { token: tokA, headers: H(cB.id) })).status === 403,
  );

  // ── 2. Teachers / members ──
  const membersB = (await api(`/academies/${cB.slug}/members`, { token: tokB, headers: H(cB.id) }))
    .body;
  const membersA = (await api(`/academies/${cA.slug}/members`, { token: tokA, headers: H(cA.id) }))
    .body;
  const hasUser = (rows, uid) =>
    Array.isArray(rows) && rows.some((m) => m.userId === uid || m.user?.id === uid);
  check(
    "Center B member list includes teacher A; Center A's does not include teacher B",
    hasUser(membersB, tA.owner.id) && !hasUser(membersA, tB.owner.id),
  );

  // ── 3. Subjects + courses (authorship unchanged under admin management) ──
  const subjA = (await prisma.teacherSubject.findFirst({ where: { tenantId: tA.id } })).subjectId;
  check(
    'Center A activates a subject',
    (
      await api(`/academies/${cA.slug}/subjects/${subjA}`, {
        token: tokA,
        method: 'PUT',
        body: { isActive: true },
        headers: H(cA.id),
      })
    ).status < 300,
  );
  const subjectsB = (
    await api(`/academies/${cB.slug}/subjects`, { token: tokB, headers: H(cB.id) })
  ).body;
  check(
    "Center B does not see Center A's activation",
    subjectsB?.subjects?.find((s) => s.id === subjA)?.offered === false,
  );
  check(
    'STAFF admin cannot activate a subject in another Center',
    denied(
      (
        await api(`/academies/${cA.slug}/subjects/${subjA}`, {
          token: tokStaff,
          method: 'PUT',
          body: { isActive: false },
          headers: H(cA.id),
        })
      ).status,
    ),
  );
  const cc = await api('/teacher/courses', {
    token: tokA,
    method: 'POST',
    body: { title: `Ops course ${tag}`, priceCents: 0, subjectId: subjA },
    headers: H(cA.id),
  });
  check(
    'Center A course: tenantId = author, academyId = Center',
    cc.status === 201 && cc.body.tenantId === tA.id && cc.body.academyId === cA.id,
    JSON.stringify(cc.body?.code ?? cc.status),
  );
  cleanup.courseIds.push(cc.body?.id);
  check(
    'Center B owner cannot read a Center A course',
    (await api(`/teacher/courses/${cc.body.id}`, { token: tokB, headers: H(cB.id) })).status ===
      404,
  );
  check(
    'STAFF admin cannot author a course',
    (
      await api('/teacher/courses', {
        token: tokStaff,
        method: 'POST',
        body: { title: `Staff course ${tag}`, priceCents: 0 },
        headers: H(cS.id),
      })
    ).status >= 400,
  );
  const unit = await prisma.courseUnit.create({
    data: { courseId: cc.body.id, title: 'u', sortOrder: 0 },
  });
  await prisma.lesson.create({ data: { unitId: unit.id, title: 'l', sortOrder: 0 } });
  await prisma.course.update({ where: { id: cc.body.id }, data: { status: 'PUBLISHED' } });
  const eA = await api('/enrollments', {
    token: tokS,
    method: 'POST',
    body: { courseId: cc.body.id },
  });
  check(
    'student enrols in the Center A course (Enrollment.academyId = Center A)',
    eA.status < 300 &&
      (
        await prisma.enrollment.findFirst({
          where: { courseId: cc.body.id },
          select: { academyId: true },
        })
      )?.academyId === cA.id,
    String(eA.status),
  );

  // ── 4. Students ──
  const rosterA = (await api('/teacher/roster', { token: tokA, headers: H(cA.id) })).body;
  const rosterB = (await api('/teacher/roster', { token: tokB, headers: H(cB.id) })).body;
  const inRoster = (r) => JSON.stringify(r ?? '').includes(student.studentProfile.id);
  check(
    'student is in Center A roster and not in Center B roster',
    inRoster(rosterA) && !inRoster(rosterB),
  );
  check(
    'student cannot read a roster',
    denied((await api('/teacher/roster', { token: tokS, headers: H(cA.id) })).status),
  );

  // ── 5. Groups + attendance ──
  const mk = async (tok, academyId, name) => {
    const r = await api('/teacher/groups', {
      token: tok,
      method: 'POST',
      body: { name },
      headers: H(academyId),
    });
    cleanup.groupIds.push(r.body?.id);
    return r.body;
  };
  const gA = await mk(tokA, cA.id, `Ops A ${tag}`);
  const gB = await mk(tokB, cB.id, `Ops B ${tag}`);
  check('setup: groups in Center A and B', !!gA?.id && !!gB?.id);
  const addA = await api(`/teacher/groups/${gA.id}/members`, {
    token: tokA,
    method: 'POST',
    body: { studentIds: [student.studentProfile.id] },
    headers: H(cA.id),
  });
  check(
    'Center A group accepts a student enrolled in the Center (organisation scope, not author scope)',
    addA.status < 300,
    `${addA.status} ${JSON.stringify(addA.body?.message ?? '')}`,
  );
  check(
    'Center B group refuses a student not enrolled in Center B',
    (
      await api(`/teacher/groups/${gB.id}/members`, {
        token: tokB,
        method: 'POST',
        body: { studentIds: [student.studentProfile.id] },
        headers: H(cB.id),
      })
    ).status === 400,
  );
  check(
    'Center B owner cannot read a Center A group',
    (await api(`/teacher/groups/${gA.id}`, { token: tokB, headers: H(cB.id) })).status === 404,
  );
  check(
    'Center A group cannot be reached from a Center B selector by its own owner',
    (await api(`/teacher/groups/${gA.id}`, { token: tokA, headers: H(cB.id) })).status === 404,
  );
  const marked = await api(`/teacher/groups/${gA.id}/attendance`, {
    token: tokA,
    method: 'POST',
    body: {
      date: '2027-04-01',
      records: [{ studentId: student.studentProfile.id, status: 'PRESENT' }],
    },
    headers: H(cA.id),
  });
  check('attendance marked in Center A', marked.status < 300, String(marked.status));
  check(
    'attendance rows carry academyId = Center A',
    (await prisma.attendanceSession.count({ where: { groupId: gA.id, academyId: cA.id } })) === 1,
  );
  check(
    'Center B owner cannot read Center A attendance',
    (
      await api(`/teacher/groups/${gA.id}/attendance?date=2027-04-01`, {
        token: tokB,
        headers: H(cB.id),
      })
    ).status === 404,
  );
  check(
    'Center B owner cannot mark Center A attendance',
    (
      await api(`/teacher/groups/${gA.id}/attendance`, {
        token: tokB,
        method: 'POST',
        body: {
          date: '2027-04-01',
          records: [{ studentId: student.studentProfile.id, status: 'ABSENT' }],
        },
        headers: H(cB.id),
      })
    ).status === 404,
  );
  check(
    "Center B cannot see the student's Center A history",
    (
      await api(`/teacher/students/${student.studentProfile.id}/attendance`, {
        token: tokB,
        headers: H(cB.id),
      })
    ).body?.length === 0 ||
      (
        await api(`/teacher/students/${student.studentProfile.id}/attendance`, {
          token: tokB,
          headers: H(cB.id),
        })
      ).status === 404,
  );

  // ── 6. Rooms ──
  const roomA = (
    await api('/teacher/rooms', {
      token: tokA,
      method: 'POST',
      body: { name: `Ops room ${tag}` },
      headers: H(cA.id),
    })
  ).body;
  check(
    'Center B room list excludes Center A rooms',
    !((await api('/teacher/rooms', { token: tokB, headers: H(cB.id) })).body ?? []).some(
      (r) => r.id === roomA?.id,
    ),
  );
  check(
    'Center B owner cannot edit a Center A room',
    (
      await api(`/teacher/rooms/${roomA.id}`, {
        token: tokB,
        method: 'PATCH',
        body: { name: 'hijack' },
        headers: H(cB.id),
      })
    ).status === 404,
  );

  // ── 7. Analytics: organisation-scoped, owner-only, no finance for Centers ──
  const ovA = await api('/teacher/analytics/center', { token: tokA, headers: H(cA.id) });
  check(
    'Center A overview served to its owner',
    ovA.status === 200 && ovA.body.academy?.kind === 'CENTER',
    String(ovA.status),
  );
  check(
    'Center A overview counts its own teacher, student, course, group, subject',
    ovA.body.teachers >= 1 &&
      ovA.body.students === 1 &&
      ovA.body.courses.total === 1 &&
      ovA.body.groups === 1 &&
      ovA.body.subjectsActive === 1,
    JSON.stringify({
      t: ovA.body.teachers,
      s: ovA.body.students,
      c: ovA.body.courses,
      g: ovA.body.groups,
      sub: ovA.body.subjectsActive,
    }),
  );
  check(
    'Center A overview carries no financial figure',
    !/cents|revenue|commission|payout/i.test(JSON.stringify(ovA.body)),
  );
  const ovB = (await api('/teacher/analytics/center', { token: tokB, headers: H(cB.id) })).body;
  check(
    'Center B overview does not count Center A data',
    ovB.students === 0 && ovB.courses.total === 0 && ovB.groups === 1 && ovB.subjectsActive === 0,
    JSON.stringify({ s: ovB.students, c: ovB.courses, g: ovB.groups }),
  );
  const forged = await api(`/teacher/analytics/center?academyId=${cB.id}`, {
    token: tokA,
    headers: H(cA.id),
  });
  check(
    'forged ?academyId is ignored — the selected membership decides',
    forged.status === 200 &&
      forged.body.students === 1 &&
      forged.body.academy?.name === ovA.body.academy?.name,
  );
  check(
    'teacher A (TEACHER in Center B) gets 403 on academy-wide analytics there',
    (await api('/teacher/analytics/center', { token: tokA, headers: H(cB.id) })).status === 403,
  );
  check(
    'teacher A (TEACHER in Center B) gets 403 on the overview too',
    (await api('/teacher/analytics', { token: tokA, headers: H(cB.id) })).status === 403,
  );
  const me = await api('/teacher/analytics/me', { token: tokA, headers: H(cB.id) });
  check(
    'teacher A gets their own slice in Center B (no Center A course counted)',
    me.status === 200 && me.body.academyId === cB.id && me.body.courses === 0,
    JSON.stringify(me.body?.code ?? me.status),
  );
  const meA = (await api('/teacher/analytics/me', { token: tokA, headers: H(cA.id) })).body;
  check(
    "teacher A's own slice in Center A counts their authored course",
    meA?.courses === 1 && meA?.activeEnrollments === 1,
    JSON.stringify(meA),
  );
  check(
    'student cannot read analytics',
    denied((await api('/teacher/analytics/center', { token: tokS, headers: H(cA.id) })).status),
  );
  const fin = await api('/teacher/analytics/financial', { token: tokA, headers: H(cA.id) });
  check(
    'financial analytics are served for a Center (Phase 7: organisation-scoped, its own ledger account)',
    fin.status === 200 && fin.body?.kind === 'CENTER',
    String(fin.status),
  );
  check(
    'financial analytics still served for the Personal academy',
    (await api('/teacher/analytics/financial', { token: tokA, headers: H(tA.id) })).status === 200,
  );
  const ovS = await api('/teacher/analytics/center', { token: tokStaff, headers: H(cS.id) });
  check(
    'STAFF admin reads own Center overview; is not counted as a teacher',
    ovS.status === 200 && ovS.body.teachers === 0,
    String(ovS.status),
  );
  check(
    'STAFF admin cannot read Center A overview',
    denied((await api('/teacher/analytics/center', { token: tokStaff, headers: H(cA.id) })).status),
  );
  const meS = await api('/teacher/analytics/me', { token: tokStaff, headers: H(cS.id) });
  check(
    'STAFF admin own slice: zero authored courses, no error',
    meS.status === 200 && meS.body.courses === 0,
    String(meS.status),
  );
  const persA = (await api('/teacher/analytics/center', { token: tokA, headers: H(tA.id) })).body;
  check(
    'Personal academy overview: kind PERSONAL, no subject gate',
    persA?.academy?.kind === 'PERSONAL' && persA.subjectsActive === null,
  );
  const persCourses = await prisma.course.count({ where: { academyId: tA.id } });
  check(
    'Personal overview course count equals Personal-scoped rows (Center course not included)',
    persA?.courses?.total === persCourses,
    `${persA?.courses?.total} vs ${persCourses}`,
  );

  // ── 8. Audit trail written with the Center scope ──
  check(
    'Center operations were audited under academyId',
    (await prisma.auditLog.count({ where: { academyId: { in: [cA.id, cB.id, cS.id] } } })) > 0,
  );
  check('database counts (pre-cleanup snapshot recorded)', true, before);
  await prisma.auditLog.deleteMany({ where: { academyId: { in: cleanup.academyIds } } });
  await prisma.auditLog
    .deleteMany({ where: { createdAt: { gte: new Date(tag) }, academyId: null } })
    .catch(() => {});
  return { before, beforeAudit };
}

main()
  .catch((e) => {
    console.error('\nUNCAUGHT:', e);
    fail++;
  })
  .finally(async () => {
    const cids = cleanup.courseIds.filter(Boolean);
    const gids = cleanup.groupIds.filter(Boolean);
    await prisma.$executeRaw`DELETE FROM "AttendanceRecord" WHERE "academyId" = ANY(${cleanup.academyIds}::text[])`.catch(
      () => {},
    );
    await prisma.$executeRaw`DELETE FROM "AttendanceSession" WHERE "groupId" = ANY(${gids}::text[])`.catch(
      () => {},
    );
    await prisma.$executeRaw`DELETE FROM "GroupMembership" WHERE "groupId" = ANY(${gids}::text[])`.catch(
      () => {},
    );
    await prisma.$executeRaw`DELETE FROM "Group" WHERE "id" = ANY(${gids}::text[])`.catch(() => {});
    await prisma.$executeRaw`DELETE FROM "Room" WHERE "academyId" = ANY(${cleanup.academyIds}::text[])`.catch(
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
    await prisma.$executeRaw`DELETE FROM "AuditLog" WHERE "academyId" = ANY(${cleanup.academyIds}::text[])`.catch(
      () => {},
    );
    await prisma.$executeRaw`DELETE FROM "Academy" WHERE "id" = ANY(${cleanup.academyIds}::text[])`.catch(
      () => {},
    );
    await prisma.$executeRaw`DELETE FROM "User" WHERE "email" = ${staffEmail}`.catch(() => {});
    console.log('   after-cleanup counts:', await counts());
    await prisma.$disconnect();
    console.log(`\n== ${pass} passed, ${fail} failed ==`);
    process.exit(fail ? 1 : 0);
  });
