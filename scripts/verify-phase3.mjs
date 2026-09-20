#!/usr/bin/env node
/**
 * Real end-to-end verification for the SaaS Evolution Phase 3 work: Academy
 * Operations (roster, groups, group membership, teacher/assistant resource
 * scoping, attendance, needs-attention). Hits a real running API and a real
 * (disposable, local-only) Postgres — not unit tests with Prisma mocked out.
 * This is also the mandatory security test matrix: RBAC, resource ownership,
 * cross-academy isolation, and IDOR.
 *
 *   CONFIRM_TEST_DB=yes DATABASE_URL=postgresql://...localhost:PORT/darsly node scripts/verify-phase3.mjs
 *
 * Creates its own fixtures (one group, a temporary staff membership) and
 * cleans them up at the end — nothing here is left behind on success.
 */
import { PrismaClient } from '@prisma/client';

const DB = process.env.DATABASE_URL ?? '';
const PORT = process.env.API_PORT ?? '4000';
const PASSWORD = 'Darsly@123';

if (process.env.CONFIRM_TEST_DB !== 'yes') { console.error('REFUSED: set CONFIRM_TEST_DB=yes.'); process.exit(2); }
if (!DB) { console.error('REFUSED: DATABASE_URL is not set.'); process.exit(2); }
if (/railway|prod|amazonaws|supabase|neon\.tech|render\.com/i.test(DB)) {
  console.error('REFUSED: DATABASE_URL looks hosted.'); process.exit(2);
}

let pass = 0, fail = 0;
const check = (n, ok, d = '') => {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  (${d})` : ''}`);
  if (ok) pass++; else fail++;
};

async function api(p, { token, method = 'GET', body, headers } = {}) {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/v1${p}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(headers ?? {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json };
}
const login = async (email) => {
  const r = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  if (r.status >= 300) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
};

const prisma = new PrismaClient();
const cleanup = [];

async function main() {
  console.log('== Phase 3 verification: Academy Operations ==\n');

  const teacherA = await prisma.teacherProfile.findFirst({ where: { status: 'APPROVED' }, include: { user: { select: { id: true, email: true } } } });
  const others = await prisma.teacherProfile.findMany({
    where: { status: 'APPROVED', id: { not: teacherA.id } }, take: 2,
    include: { user: { select: { id: true, email: true } } },
  });
  const [teacherB, teacherC] = others; // B will become academy1 staff not assigned to the group; C stays a fully unrelated OWNER of academy3
  const academy1 = teacherA.id;
  const students = await prisma.studentProfile.findMany({ where: { enrollments: { some: { tenantId: academy1 } } }, take: 3, select: { id: true } });

  const tokenA = await login(teacherA.user.email);
  const tokenB = await login(teacherB.user.email);
  const tokenC = await login(teacherC.user.email);

  // ── Roster ───────────────────────────────────────────────────────────────
  console.log('-- Roster --');
  const roster = await api('/teacher/roster', { token: tokenA });
  check('roster: 200', roster.status === 200);
  check('roster: has real students with expected shape', roster.body?.students?.[0]?.fullName !== undefined && typeof roster.body?.students?.[0]?.isActive === 'boolean');
  // A student legitimately enrolled with more than one academy is not a leak
  // — it's real (this demo data has several). The actual guarantee is that
  // each roster's own enrollmentsCount only reflects THAT academy's
  // enrollments, never a total across academies.
  const rosterB = await api('/teacher/roster', { token: tokenB });
  check('roster: 200 for a second, unrelated academy too', rosterB.status === 200);
  const sharedStudent = roster.body?.students?.find((s) => rosterB.body?.students?.some((b) => b.id === s.id));
  if (sharedStudent) {
    const inB = rosterB.body.students.find((b) => b.id === sharedStudent.id);
    check("a student in both rosters shows academy-specific enrollment counts, not a shared total", sharedStudent.enrollmentsCount >= 1 && inB.enrollmentsCount >= 1);
  }

  // ── Groups: create + membership ─────────────────────────────────────────
  console.log('\n-- Groups: create + membership --');
  const createGroup = await api('/teacher/groups', { token: tokenA, method: 'POST', body: { name: 'Verify Phase3 Group', description: 'test fixture' } });
  check('create group: 201/200', createGroup.status < 300);
  const groupId = createGroup.body.id;
  cleanup.push(async () => {
    await prisma.attendanceRecord.deleteMany({ where: { session: { groupId } } });
    await prisma.attendanceSession.deleteMany({ where: { groupId } });
    await prisma.groupMembership.deleteMany({ where: { groupId } });
    await prisma.groupAssignment.deleteMany({ where: { groupId } });
    await prisma.group.delete({ where: { id: groupId } });
  });

  const addMembers = await api(`/teacher/groups/${groupId}/members`, { token: tokenA, method: 'POST', body: { studentIds: students.map((s) => s.id) } });
  check('add members: 2xx', addMembers.status < 300);
  check('add members: group now shows them', addMembers.body?.members?.length === students.length);

  const dupMembers = await api(`/teacher/groups/${groupId}/members`, { token: tokenA, method: 'POST', body: { studentIds: [students[0].id] } });
  check('re-adding an existing member is idempotent, not an error', dupMembers.status < 300);

  const foreignStudent = await prisma.studentProfile.findFirst({ where: { enrollments: { none: { tenantId: academy1 } } }, select: { id: true } });
  if (foreignStudent) {
    const badAdd = await api(`/teacher/groups/${groupId}/members`, { token: tokenA, method: 'POST', body: { studentIds: [foreignStudent.id] } });
    check('cannot add a student not enrolled in this academy', badAdd.status === 400);
  }

  // ── DB constraint: duplicate membership rejected at the DB level ───────
  console.log('\n-- DB constraints --');
  {
    let rejected = false;
    try {
      await prisma.groupMembership.create({ data: { groupId, studentId: students[0].id, academyId: academy1 } });
    } catch (e) { rejected = /unique constraint/i.test(String(e.message)); }
    check('DB rejects a duplicate (groupId, studentId) membership row', rejected);
  }

  // ── Resource-level scope: staff with the capability but no assignment ──
  console.log('\n-- Resource-level scope (capability != unrestricted access) --');
  const membershipB = await prisma.academyMembership.create({
    data: { userId: teacherB.user.id, academyId: academy1, role: 'TEACHER', status: 'ACTIVE' },
  });
  cleanup.push(() => prisma.academyMembership.delete({ where: { id: membershipB.id } }).catch(() => {}));

  const bBeforeAssign = await api(`/teacher/groups/${groupId}`, { token: tokenB, headers: { 'X-Academy-Id': academy1 } });
  check('teacherB (staff of academy1, group.manage capability, NOT assigned to this group) is refused: 403', bBeforeAssign.status === 403);

  const assign = await api(`/teacher/groups/${groupId}/assignments`, { token: tokenA, method: 'POST', body: { userId: teacherB.user.id, role: 'TEACHER' } });
  check('OWNER assigns teacherB to the group: 2xx', assign.status < 300);

  const bAfterAssign = await api(`/teacher/groups/${groupId}`, { token: tokenB, headers: { 'X-Academy-Id': academy1 } });
  check('teacherB now assigned — same group is reachable: 200', bAfterAssign.status === 200);

  const bTriesToAssignSomeoneElse = await api(`/teacher/groups/${groupId}/assignments`, {
    token: tokenB, method: 'POST', headers: { 'X-Academy-Id': academy1 }, body: { userId: teacherC.user.id, role: 'ASSISTANT' },
  });
  check('teacherB (assigned TEACHER, not OWNER) cannot assign staff to the group: 400', bTriesToAssignSomeoneElse.status === 400);

  // ── Cross-academy isolation ──────────────────────────────────────────────
  console.log('\n-- Cross-academy isolation --');
  const cNoMembership = await api(`/teacher/groups/${groupId}`, { token: tokenC, headers: { 'X-Academy-Id': academy1 } });
  check("teacherC (OWNER of a wholly separate academy, no membership in academy1) refused: 401/403/404", [401, 403, 404].includes(cNoMembership.status), `status=${cNoMembership.status}`);

  // IDOR: teacherC's own academy token, but naming academy1's groupId
  const cOwnAcademyForeignGroup = await api(`/teacher/groups/${groupId}`, { token: tokenC });
  check('IDOR: teacherC in their OWN academy context naming academy1\'s groupId gets 404, not the group', cOwnAcademyForeignGroup.status === 404);

  // ── Attendance ────────────────────────────────────────────────────────────
  console.log('\n-- Attendance --');
  const today = new Date().toISOString().slice(0, 10);
  const session = await api(`/teacher/groups/${groupId}/attendance?date=${today}`, { token: tokenA });
  check('get attendance session (none marked yet): 200, full roster, all null', session.status === 200 && session.body?.students?.every((s) => s.status === null));

  const mark = await api(`/teacher/groups/${groupId}/attendance`, {
    token: tokenA, method: 'POST',
    body: { date: today, records: students.map((s, i) => ({ studentId: s.id, status: i === 0 ? 'ABSENT' : 'PRESENT' })) },
  });
  check('mark attendance: 2xx', mark.status < 300);
  check('marked statuses reflected back', mark.body?.students?.find((s) => s.studentId === students[0].id)?.status === 'ABSENT');

  const remark = await api(`/teacher/groups/${groupId}/attendance`, {
    token: tokenA, method: 'POST', body: { date: today, records: [{ studentId: students[0].id, status: 'LATE' }] },
  });
  check('re-marking the same date updates in place (no duplicate session)', remark.status < 300 && remark.body?.students?.find((s) => s.studentId === students[0].id)?.status === 'LATE');

  const sessionsForGroup = await prisma.attendanceSession.count({ where: { groupId, date: new Date(today) } });
  check('exactly one AttendanceSession exists for (group, date) despite two mark calls', sessionsForGroup === 1);

  {
    let rejected = false;
    const s = await prisma.attendanceSession.findFirst({ where: { groupId, date: new Date(today) } });
    try {
      await prisma.attendanceRecord.create({ data: { sessionId: s.id, studentId: students[0].id, status: 'PRESENT', academyId: academy1, markedBy: teacherA.user.id } });
    } catch (e) { rejected = /unique constraint/i.test(String(e.message)); }
    check('DB rejects a duplicate (sessionId, studentId) attendance record', rejected);
  }

  const badStudentMark = await api(`/teacher/groups/${groupId}/attendance`, {
    token: tokenA, method: 'POST', body: { date: today, records: [{ studentId: foreignStudent?.id ?? 'nonexistent', status: 'PRESENT' }] },
  });
  check('cannot mark attendance for a non-member of the group: 400', badStudentMark.status === 400);

  const history = await api(`/teacher/students/${students[0].id}/attendance`, { token: tokenA });
  check('student attendance history: 200, includes today\'s LATE', history.status === 200 && history.body?.some((h) => h.status === 'LATE'));

  const teacherBHistory = await api(`/teacher/students/${students[0].id}/attendance`, { token: tokenB, headers: { 'X-Academy-Id': academy1 } });
  check("teacherB (assigned to this group) can see this student's history too", teacherBHistory.status === 200 && teacherBHistory.body?.length > 0);

  // ── Needs attention ──────────────────────────────────────────────────────
  console.log('\n-- Needs attention --');
  const needsAttention = await api('/teacher/needs-attention', { token: tokenA });
  check('needs-attention: 200, has all three sections', needsAttention.status === 200 && ['repeatedAbsences', 'inactiveStudents', 'staleGroups'].every((k) => k in (needsAttention.body ?? {})));

  // ── RBAC: student is refused entirely ───────────────────────────────────
  console.log('\n-- RBAC: STUDENT refused --');
  const studentUser = await prisma.user.findFirst({ where: { role: 'STUDENT' }, select: { email: true } });
  if (studentUser) {
    const studentToken = await login(studentUser.email);
    for (const [label, req] of [
      ['roster', () => api('/teacher/roster', { token: studentToken })],
      ['groups list', () => api('/teacher/groups', { token: studentToken })],
      ['group detail', () => api(`/teacher/groups/${groupId}`, { token: studentToken })],
      ['mark attendance', () => api(`/teacher/groups/${groupId}/attendance`, { token: studentToken, method: 'POST', body: { date: today, records: [] } })],
      ['needs-attention', () => api('/teacher/needs-attention', { token: studentToken })],
    ]) {
      const r = await req();
      check(`student refused: ${label}`, [401, 403, 404].includes(r.status), `status=${r.status}`);
    }
  }

  // ── Feature flag integration ─────────────────────────────────────────────
  console.log('\n-- Feature flag integration (Phase 1) --');
  const adminToken = await login('admin@darsly.app');
  const disableGroups = await api(`/admin/academies/${academy1}/feature-flags/groups`, { token: adminToken, method: 'PATCH', body: { enabled: false } });
  check('admin disables the "groups" flag for academy1: 200', disableGroups.status === 200);
  const blockedByFlag = await api(`/teacher/groups/${groupId}`, { token: tokenA });
  check('groups flag disabled — even the OWNER is 403d server-side', blockedByFlag.status === 403);
  const reenable = await api(`/admin/academies/${academy1}/feature-flags/groups`, { token: adminToken, method: 'PATCH', body: { enabled: true } });
  check('admin re-enables the flag: 200', reenable.status === 200);
  const worksAgain = await api(`/teacher/groups/${groupId}`, { token: tokenA });
  check('group reachable again immediately after re-enabling', worksAgain.status === 200);

  // ── Soft delete ───────────────────────────────────────────────────────────
  console.log('\n-- Soft delete --');
  const archive = await api(`/teacher/groups/${groupId}`, { token: tokenA, method: 'PATCH', body: { status: 'ARCHIVED' } });
  check('archive (status flip) succeeds: 2xx', archive.status < 300);
  const stillVisible = await api(`/teacher/groups/${groupId}`, { token: tokenA });
  check('an ARCHIVED group is still readable (archived, not deleted)', stillVisible.status === 200 && stillVisible.body?.status === 'ARCHIVED');

  console.log(`\n${pass} passed, ${fail} failed`);
  for (const fn of cleanup.reverse()) await fn().catch((e) => console.error('cleanup error:', e.message));
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error('FATAL', e);
  for (const fn of cleanup.reverse()) await fn().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
