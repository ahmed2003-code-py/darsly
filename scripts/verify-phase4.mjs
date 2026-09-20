#!/usr/bin/env node
/**
 * Real end-to-end verification for the SaaS Evolution Phase 4 work: academy
 * scheduling — physical rooms, group sessions, and conflict detection (room/
 * teacher/group overlap, boundary rules, and the DB-level exclusion-
 * constraint guarantee under real concurrency). Hits a real running API and
 * a real (disposable, local-only) Postgres — not unit tests with Prisma
 * mocked out. This is also the mandatory security + conflict test matrix.
 *
 *   CONFIRM_TEST_DB=yes DATABASE_URL=postgresql://...localhost:PORT/darsly node scripts/verify-phase4.mjs
 *
 * Creates its own fixtures (rooms, groups, sessions) and cleans them up.
 */
import { PrismaClient } from '@prisma/client';

const DB = process.env.DATABASE_URL ?? '';
const PORT = process.env.API_PORT ?? '41000';
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

async function api(p, { token, method = 'GET', body, headers, params } = {}) {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const r = await fetch(`http://127.0.0.1:${PORT}/api/v1${p}${qs}`, {
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
const iso = (s) => new Date(s).toISOString();

const prisma = new PrismaClient();
const cleanup = [];

async function main() {
  console.log('== Phase 4 verification: Scheduling, Rooms & Conflict Detection ==\n');

  const teacherA = await prisma.teacherProfile.findFirst({ where: { status: 'APPROVED' }, include: { user: { select: { id: true, email: true } } } });
  const others = await prisma.teacherProfile.findMany({
    where: { status: 'APPROVED', id: { not: teacherA.id } }, take: 2,
    include: { user: { select: { id: true, email: true } } },
  });
  const [teacherB, teacherC] = others;
  const academy1 = teacherA.id;
  const academySlug = await prisma.academy.findUnique({ where: { id: academy1 }, select: { slug: true } });

  const tokenA = await login(teacherA.user.email);
  const tokenC = await login(teacherC.user.email);

  // ── Fixtures ──────────────────────────────────────────────────────────────
  const roomRes = await api('/teacher/rooms', { token: tokenA, method: 'POST', body: { name: 'Verify Phase4 Room', capacity: 20 } });
  check('setup: create room', roomRes.status < 300);
  const roomId = roomRes.body.id;
  cleanup.push(() => prisma.room.delete({ where: { id: roomId } }).catch(() => {}));

  const groupRes = await api('/teacher/groups', { token: tokenA, method: 'POST', body: { name: 'Verify Phase4 Group' } });
  const groupId = groupRes.body.id;
  const fixtureStudent = await prisma.studentProfile.findFirst({
    where: { enrollments: { some: { tenantId: academy1 } } },
    include: { user: { select: { email: true } } },
  });
  if (fixtureStudent) {
    await api(`/teacher/groups/${groupId}/members`, { token: tokenA, method: 'POST', body: { studentIds: [fixtureStudent.id] } });
  }
  const group2Res = await api('/teacher/groups', { token: tokenA, method: 'POST', body: { name: 'Verify Phase4 Group 2' } });
  const group2Id = group2Res.body.id;
  const group3Res = await api('/teacher/groups', { token: tokenA, method: 'POST', body: { name: 'Verify Phase4 Group 3' } });
  const group3Id = group3Res.body.id;
  cleanup.push(async () => {
    await prisma.groupSession.deleteMany({ where: { groupId: { in: [groupId, group2Id, group3Id] } } });
    await prisma.group.deleteMany({ where: { id: { in: [groupId, group2Id, group3Id] } } });
  });

  // ── Room CRUD ────────────────────────────────────────────────────────────
  console.log('-- Room CRUD --');
  const listRooms = await api('/teacher/rooms', { token: tokenA });
  check('list rooms: 200, includes the new one', listRooms.status === 200 && listRooms.body.some((r) => r.id === roomId));
  const updateRoom = await api(`/teacher/rooms/${roomId}`, { token: tokenA, method: 'PATCH', body: { capacity: 30 } });
  check('update room: 2xx', updateRoom.status < 300 && updateRoom.body.capacity === 30);
  const archiveRoom = await api(`/teacher/rooms/${roomId}`, { token: tokenA, method: 'PATCH', body: { status: 'ARCHIVED' } });
  check('archive room: 2xx', archiveRoom.status < 300 && archiveRoom.body.status === 'ARCHIVED');
  const archivedBlocked = await api(`/teacher/groups/${groupId}/sessions`, {
    token: tokenA, method: 'POST', body: { roomId, startAt: iso('2026-12-01T09:00:00Z'), endAt: iso('2026-12-01T10:00:00Z') },
  });
  check('cannot schedule into an archived room: 400', archivedBlocked.status === 400);
  const reactivateRoom = await api(`/teacher/rooms/${roomId}`, { token: tokenA, method: 'PATCH', body: { status: 'ACTIVE' } });
  check('reactivate room: 2xx', reactivateRoom.status < 300 && reactivateRoom.body.status === 'ACTIVE');

  // ── Session CRUD + valid cases ───────────────────────────────────────────
  console.log('\n-- Session CRUD: valid cases --');
  const s1 = await api(`/teacher/groups/${groupId}/sessions`, {
    token: tokenA, method: 'POST', body: { roomId, startAt: iso('2026-12-01T10:00:00Z'), endAt: iso('2026-12-01T11:00:00Z') },
  });
  check('first session: 2xx', s1.status < 300);
  const s1Id = s1.body.id;

  const backToBack = await api(`/teacher/groups/${groupId}/sessions`, {
    token: tokenA, method: 'POST', body: { roomId, startAt: iso('2026-12-01T11:00:00Z'), endAt: iso('2026-12-01T12:00:00Z') },
  });
  check('back-to-back same room, same group (11:00 boundary): 2xx, not a conflict', backToBack.status < 300);

  const differentRoom = await api(`/teacher/groups/${group2Id}/sessions`, {
    token: tokenA, method: 'POST', body: { startAt: iso('2026-12-01T10:30:00Z'), endAt: iso('2026-12-01T11:30:00Z') },
  });
  check('different group, no room, overlapping time: 2xx (no room/teacher to conflict on)', differentRoom.status < 300);

  const endLteStart = await api(`/teacher/groups/${group3Id}/sessions`, {
    token: tokenA, method: 'POST', body: { startAt: iso('2026-12-01T10:00:00Z'), endAt: iso('2026-12-01T10:00:00Z') },
  });
  check('end == start rejected: 400', endLteStart.status === 400);

  // ── Invalid: overlap detection (all three kinds + boundaries) ──────────
  console.log('\n-- Conflict detection --');
  const roomOverlap = await api(`/teacher/groups/${group3Id}/sessions`, {
    token: tokenA, method: 'POST', body: { roomId, startAt: iso('2026-12-01T10:59:00Z'), endAt: iso('2026-12-01T11:30:00Z') },
  });
  check('1-minute room overlap rejected: 409 ROOM_CONFLICT', roomOverlap.status === 409 && roomOverlap.body?.code === 'ROOM_CONFLICT');

  const containedOverlap = await api(`/teacher/groups/${group3Id}/sessions`, {
    token: tokenA, method: 'POST', body: { roomId, startAt: iso('2026-12-01T10:15:00Z'), endAt: iso('2026-12-01T10:45:00Z') },
  });
  check('session fully contained inside an existing one: 409', containedOverlap.status === 409);

  const containingOverlap = await api(`/teacher/groups/${group3Id}/sessions`, {
    token: tokenA, method: 'POST', body: { roomId, startAt: iso('2026-12-01T09:30:00Z'), endAt: iso('2026-12-01T12:30:00Z') },
  });
  check('session that fully contains an existing one: 409', containingOverlap.status === 409);

  const teacherSess = await api(`/teacher/groups/${groupId}/sessions`, {
    token: tokenA, method: 'POST', body: { teacherUserId: teacherA.user.id, startAt: iso('2026-12-02T09:00:00Z'), endAt: iso('2026-12-02T10:00:00Z') },
  });
  check('setup: teacher-assigned session', teacherSess.status < 300);
  const teacherOverlap = await api(`/teacher/groups/${group2Id}/sessions`, {
    token: tokenA, method: 'POST', body: { teacherUserId: teacherA.user.id, startAt: iso('2026-12-02T09:30:00Z'), endAt: iso('2026-12-02T10:30:00Z') },
  });
  check('same teacher, different group, overlapping: 409 TEACHER_CONFLICT', teacherOverlap.status === 409 && teacherOverlap.body?.code === 'TEACHER_CONFLICT');

  const groupOverlap = await api(`/teacher/groups/${groupId}/sessions`, {
    token: tokenA, method: 'POST', body: { startAt: iso('2026-12-01T10:30:00Z'), endAt: iso('2026-12-01T11:30:00Z') },
  });
  check('same group, overlapping (no room/teacher): 409 GROUP_CONFLICT', groupOverlap.status === 409 && groupOverlap.body?.code === 'GROUP_CONFLICT');

  // ── Update / reschedule ──────────────────────────────────────────────────
  console.log('\n-- Update / reschedule --');
  const noop = await api(`/teacher/sessions/${s1Id}`, { token: tokenA, method: 'PATCH', body: { startAt: iso('2026-12-01T10:00:00Z'), endAt: iso('2026-12-01T11:00:00Z') } });
  check('no-op update (same times) does not conflict with itself: 2xx', noop.status < 300);

  const reschedule = await api(`/teacher/sessions/${s1Id}`, { token: tokenA, method: 'PATCH', body: { startAt: iso('2026-12-01T08:00:00Z'), endAt: iso('2026-12-01T09:00:00Z') } });
  check('reschedule to a free slot: 2xx', reschedule.status < 300);

  const rescheduleIntoConflict = await api(`/teacher/sessions/${s1Id}`, { token: tokenA, method: 'PATCH', body: { startAt: iso('2026-12-01T11:30:00Z'), endAt: iso('2026-12-01T12:30:00Z') } });
  check('reschedule into an existing conflict: 409', rescheduleIntoConflict.status === 409);

  const restoreS1 = await api(`/teacher/sessions/${s1Id}`, { token: tokenA, method: 'PATCH', body: { startAt: iso('2026-12-01T10:00:00Z'), endAt: iso('2026-12-01T11:00:00Z') } });
  check('reschedule back out of conflict: 2xx', restoreS1.status < 300);

  // ── Cancellation ──────────────────────────────────────────────────────────
  console.log('\n-- Cancellation --');
  const cancel = await api(`/teacher/sessions/${s1Id}`, { token: tokenA, method: 'PATCH', body: { status: 'CANCELLED' } });
  check('cancel: 2xx', cancel.status < 300 && cancel.body.status === 'CANCELLED');
  const bookOverCancelled = await api(`/teacher/groups/${group3Id}/sessions`, {
    token: tokenA, method: 'POST', body: { roomId, startAt: iso('2026-12-01T10:00:00Z'), endAt: iso('2026-12-01T11:00:00Z') },
  });
  check('a CANCELLED session does not block a new booking over the same slot: 2xx', bookOverCancelled.status < 300);
  if (bookOverCancelled.status < 300) cleanup.push(() => prisma.groupSession.delete({ where: { id: bookOverCancelled.body.id } }).catch(() => {}));

  // ── Schedule retrieval + date range ──────────────────────────────────────
  console.log('\n-- Schedule retrieval --');
  const sched = await api(`/academies/${academySlug.slug}/schedule`, { token: tokenA, params: { from: '2026-12-01T00:00:00.000Z', to: '2026-12-03T00:00:00.000Z' } });
  check('schedule range read: 200, includes sessions in range', sched.status === 200 && sched.body.length > 0);
  const outOfRange = await api(`/academies/${academySlug.slug}/schedule`, { token: tokenA, params: { from: '2030-01-01T00:00:00.000Z', to: '2030-01-02T00:00:00.000Z' } });
  check('out-of-range window returns none of the fixtures', outOfRange.status === 200 && !outOfRange.body.some((s) => [groupId, group2Id, group3Id].includes(s.group.id)));
  const missingRange = await api(`/academies/${academySlug.slug}/schedule`, { token: tokenA });
  check('missing from/to is rejected, not defaulted to "everything": 400', missingRange.status === 400);
  const tooWide = await api(`/academies/${academySlug.slug}/schedule`, { token: tokenA, params: { from: '2020-01-01T00:00:00.000Z', to: '2030-01-01T00:00:00.000Z' } });
  check('an excessively wide range is rejected: 400', tooWide.status === 400);

  // ── Cross-academy isolation + IDOR ───────────────────────────────────────
  console.log('\n-- Cross-academy isolation + IDOR --');
  const foreignRoom = await api(`/teacher/groups/${groupId}/sessions`, {
    token: tokenA, method: 'POST', body: { roomId: 'not-a-real-or-foreign-room-id', startAt: iso('2026-12-05T10:00:00Z'), endAt: iso('2026-12-05T11:00:00Z') },
  });
  check('unknown/foreign roomId: 404, not silently accepted', foreignRoom.status === 404);

  const otherAcademyRoom = await prisma.room.findFirst({ where: { academyId: { not: academy1 } }, select: { id: true } });
  if (otherAcademyRoom) {
    const crossRoom = await api(`/teacher/groups/${groupId}/sessions`, {
      token: tokenA, method: 'POST', body: { roomId: otherAcademyRoom.id, startAt: iso('2026-12-05T10:00:00Z'), endAt: iso('2026-12-05T11:00:00Z') },
    });
    check("another academy's real room id: 404", crossRoom.status === 404);
  }

  const cNoMembership = await api(`/academies/${academySlug.slug}/schedule`, { token: tokenC, params: { from: '2026-12-01T00:00:00.000Z', to: '2026-12-03T00:00:00.000Z' } });
  check('an unrelated academy owner with no membership here is refused', [401, 403, 404].includes(cNoMembership.status), `status=${cNoMembership.status}`);

  const cForeignSession = await api(`/teacher/sessions/${s1Id}`, { token: tokenC, method: 'PATCH', body: { status: 'CANCELLED' } });
  check("IDOR: another academy's owner cannot cancel this academy's session via their own context", cForeignSession.status === 404);

  const cRoomCreate = await api('/teacher/rooms', { token: tokenC, method: 'POST', body: { name: 'should not land in academy1' } });
  check("room created under teacherC's own token lands in THEIR academy, not academy1", cRoomCreate.status < 300 && cRoomCreate.body.academyId !== academy1);
  if (cRoomCreate.status < 300) await prisma.room.delete({ where: { id: cRoomCreate.body.id } }).catch(() => {});

  // ── RBAC / resource scope (same pattern as Phase 3) ─────────────────────
  console.log('\n-- RBAC / resource scope --');
  const membershipB = await prisma.academyMembership.create({ data: { userId: teacherB.user.id, academyId: academy1, role: 'TEACHER', status: 'ACTIVE' } });
  cleanup.push(() => prisma.academyMembership.delete({ where: { id: membershipB.id } }).catch(() => {}));
  const tokenB = await login(teacherB.user.email);

  const bCreateBeforeAssign = await api(`/teacher/groups/${groupId}/sessions`, {
    token: tokenB, headers: { 'X-Academy-Id': academy1 }, method: 'POST', body: { startAt: iso('2026-12-06T10:00:00Z'), endAt: iso('2026-12-06T11:00:00Z') },
  });
  check('teacherB (staff, schedule.manage capability, NOT assigned to this group) refused: 403', bCreateBeforeAssign.status === 403);

  const bRoomCreate = await api('/teacher/rooms', { token: tokenB, headers: { 'X-Academy-Id': academy1 }, method: 'POST', body: { name: 'teacherB should not manage rooms' } });
  check('teacherB cannot create a room (room.manage is OWNER-only, not granted to TEACHER)', bRoomCreate.status === 403);

  await api(`/teacher/groups/${groupId}/assignments`, { token: tokenA, method: 'POST', body: { userId: teacherB.user.id, role: 'TEACHER' } });
  const bCreateAfterAssign = await api(`/teacher/groups/${groupId}/sessions`, {
    token: tokenB, headers: { 'X-Academy-Id': academy1 }, method: 'POST', body: { startAt: iso('2026-12-06T10:00:00Z'), endAt: iso('2026-12-06T11:00:00Z') },
  });
  check('teacherB now assigned — can schedule this group: 2xx', bCreateAfterAssign.status < 300);
  if (bCreateAfterAssign.status < 300) cleanup.push(() => prisma.groupSession.delete({ where: { id: bCreateAfterAssign.body.id } }).catch(() => {}));

  const bCreateOtherGroup = await api(`/teacher/groups/${group2Id}/sessions`, {
    token: tokenB, headers: { 'X-Academy-Id': academy1 }, method: 'POST', body: { startAt: iso('2026-12-06T10:00:00Z'), endAt: iso('2026-12-06T11:00:00Z') },
  });
  check('teacherB still refused for a group they are NOT assigned to', bCreateOtherGroup.status === 403);

  const bAssignForeignTeacher = await api(`/teacher/groups/${groupId}/sessions`, {
    token: tokenB, headers: { 'X-Academy-Id': academy1 }, method: 'POST', body: { teacherUserId: teacherC.user.id, startAt: iso('2026-12-07T10:00:00Z'), endAt: iso('2026-12-07T11:00:00Z') },
  });
  check('cannot assign a teacher who is not assigned to the group as the session teacher: 400', bAssignForeignTeacher.status === 400);

  // ── STUDENT: read-only, no mutation ──────────────────────────────────────
  console.log('\n-- STUDENT: read-only --');
  if (fixtureStudent) {
    const studentToken = await login(fixtureStudent.user.email);
    const studentRead = await api(`/academies/${academySlug.slug}/schedule`, { token: studentToken, params: { from: '2026-12-01T00:00:00.000Z', to: '2026-12-03T00:00:00.000Z' } });
    check('student can read the schedule', studentRead.status === 200);
    const studentCreate = await api(`/teacher/groups/${groupId}/sessions`, { token: studentToken, headers: { 'X-Academy-Id': academy1 }, method: 'POST', body: { startAt: iso('2026-12-08T10:00:00Z'), endAt: iso('2026-12-08T11:00:00Z') } });
    check('student cannot create a session', [401, 403, 404].includes(studentCreate.status));
    const studentRoom = await api('/teacher/rooms', { token: studentToken, headers: { 'X-Academy-Id': academy1 }, method: 'POST', body: { name: 'nope' } });
    check('student cannot create a room', [401, 403, 404].includes(studentRoom.status));
  } else {
    console.log('   SKIP  no group member with a student found for this academy');
  }

  // ── Feature flag integration ─────────────────────────────────────────────
  console.log('\n-- Feature flag integration --');
  const adminToken = await login('admin@darsly.app');
  await api(`/admin/academies/${academy1}/feature-flags/scheduling`, { token: adminToken, method: 'PATCH', body: { enabled: false } });
  const blockedByFlag = await api(`/teacher/groups/${groupId}/sessions`, { token: tokenA, method: 'POST', body: { startAt: iso('2026-12-09T10:00:00Z'), endAt: iso('2026-12-09T11:00:00Z') } });
  check('scheduling flag disabled — even the OWNER is 403d server-side', blockedByFlag.status === 403);
  await api(`/admin/academies/${academy1}/feature-flags/scheduling`, { token: adminToken, method: 'PATCH', body: { enabled: true } });
  const worksAgain = await api(`/teacher/groups/${groupId}/sessions`, { token: tokenA, method: 'POST', body: { startAt: iso('2026-12-09T10:00:00Z'), endAt: iso('2026-12-09T11:00:00Z') } });
  check('reachable again immediately after re-enabling', worksAgain.status < 300);
  if (worksAgain.status < 300) cleanup.push(() => prisma.groupSession.delete({ where: { id: worksAgain.body.id } }).catch(() => {}));

  // ── DB constraint: direct exclusion-constraint rejection ────────────────
  console.log('\n-- DB constraints (direct) --');
  {
    let rejected = false;
    const existing = await prisma.groupSession.findFirst({ where: { groupId, roomId, status: 'SCHEDULED' } });
    try {
      await prisma.groupSession.create({
        data: { academyId: academy1, groupId: group3Id, roomId, startAt: new Date(existing.startAt.getTime() + 5 * 60_000), endAt: existing.endAt, createdBy: 'test' },
      });
    } catch (e) { rejected = /exclusion constraint/i.test(String(e.message)); }
    check('DB rejects a room-overlap insert made directly (bypassing app-level pre-check)', rejected);
  }

  // ── Concurrency: two simultaneous room-conflicting creates ──────────────
  console.log('\n-- Concurrency --');
  {
    const g4 = await api('/teacher/groups', { token: tokenA, method: 'POST', body: { name: 'Verify Phase4 Concurrency Group' } });
    const g5 = await api('/teacher/groups', { token: tokenA, method: 'POST', body: { name: 'Verify Phase4 Concurrency Group 2' } });
    cleanup.push(async () => {
      await prisma.groupSession.deleteMany({ where: { groupId: { in: [g4.body.id, g5.body.id] } } });
      await prisma.group.deleteMany({ where: { id: { in: [g4.body.id, g5.body.id] } } });
    });
    const race = { roomId, startAt: iso('2026-12-15T10:00:00Z'), endAt: iso('2026-12-15T11:00:00Z') };
    const [r1, r2] = await Promise.all([
      api(`/teacher/groups/${g4.body.id}/sessions`, { token: tokenA, method: 'POST', body: race }),
      api(`/teacher/groups/${g5.body.id}/sessions`, { token: tokenA, method: 'POST', body: race }),
    ]);
    const succeeded = [r1, r2].filter((r) => r.status < 300);
    const conflicted = [r1, r2].filter((r) => r.status === 409);
    check('exactly one of two concurrent same-room requests succeeds', succeeded.length === 1, `statuses=${r1.status},${r2.status}`);
    check('the other receives a structured 409 conflict', conflicted.length === 1);
    if (succeeded[0]) await prisma.groupSession.delete({ where: { id: succeeded[0].body.id } }).catch(() => {});
  }
  {
    const g6 = await api('/teacher/groups', { token: tokenA, method: 'POST', body: { name: 'Verify Phase4 Concurrency Group 3' } });
    const g7 = await api('/teacher/groups', { token: tokenA, method: 'POST', body: { name: 'Verify Phase4 Concurrency Group 4' } });
    cleanup.push(async () => {
      await prisma.groupSession.deleteMany({ where: { groupId: { in: [g6.body.id, g7.body.id] } } });
      await prisma.group.deleteMany({ where: { id: { in: [g6.body.id, g7.body.id] } } });
    });
    const race = { teacherUserId: teacherA.user.id, startAt: iso('2026-12-16T10:00:00Z'), endAt: iso('2026-12-16T11:00:00Z') };
    const [r1, r2] = await Promise.all([
      api(`/teacher/groups/${g6.body.id}/sessions`, { token: tokenA, method: 'POST', body: race }),
      api(`/teacher/groups/${g7.body.id}/sessions`, { token: tokenA, method: 'POST', body: race }),
    ]);
    const succeeded = [r1, r2].filter((r) => r.status < 300);
    check('exactly one of two concurrent same-teacher requests succeeds', succeeded.length === 1, `statuses=${r1.status},${r2.status}`);
    if (succeeded[0]) await prisma.groupSession.delete({ where: { id: succeeded[0].body.id } }).catch(() => {});
  }

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
