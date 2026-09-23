#!/usr/bin/env node
/**
 * Real HTTP + DB verification for Architecture Reset Phase 5: teaching modes,
 * GroupSession/LiveSession organisation + teacher scope, cross-Center
 * isolation, conflicts across both tables, Cairo local-day bucketing,
 * teacher removal cleanup. Local only.
 *
 *   CONFIRM_TEST_DB=yes TZ=Africa/Cairo DATABASE_URL=postgresql://...localhost:PORT/darsly node scripts/verify-reset-phase5.mjs
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
const cleanup = { academyIds: [], groupIds: [], liveIds: [] };
const counts = async () =>
  JSON.stringify({
    gs: await prisma.groupSession.count(),
    ls: await prisma.liveSession.count(),
    g: await prisma.group.count(),
    r: await prisma.room.count(),
    a: await prisma.academy.count(),
    att: await prisma.attendanceSession.count(),
  });

// The frontend's fixed local-day key (TeacherSchedulePage.isoDate): local date parts, never toISOString().
const localDayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const day = (iso, h, m = 0) =>
  new Date(`${iso}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`).toISOString();

async function main() {
  console.log('== Reset Phase 5 verification ==\n');
  check(
    'process timezone is Africa/Cairo (required for the local-day regression)',
    Intl.DateTimeFormat().resolvedOptions().timeZone === 'Africa/Cairo',
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const before = await counts();

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

  // Centers: A (owner teacher A), B (owner teacher B; teacher A joins as TEACHER). STAFF admin for Center A.
  const cA = (
    await api('/admin/centers', {
      token: tokAdmin,
      method: 'POST',
      body: { name: `Sched A ${tag}`, adminName: 'Center Admin', adminEmail: tA.owner.email },
    })
  ).body;
  const cB = (
    await api('/admin/centers', {
      token: tokAdmin,
      method: 'POST',
      body: { name: `Sched B ${tag}`, adminName: 'Center Admin', adminEmail: tB.owner.email },
    })
  ).body;
  check('setup: two Centers', !!cA?.id && !!cB?.id);
  if (!cA?.id || !cB?.id) throw new Error('fixtures');
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
    'setup: teacher A is TEACHER in Center B',
    (await api(`/invitation-links/${link.token}/accept`, { token: tokA, method: 'POST' })).status <
      300,
  );

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
  const gP = await mk(tokA, tA.id, `P ${tag}`);
  const gA = await mk(tokA, cA.id, `A ${tag}`);
  const gB = await mk(tokB, cB.id, `B ${tag}`);
  check('setup: groups in Personal, Center A, Center B', !!gP?.id && !!gA?.id && !!gB?.id);
  const assignB = await api(`/teacher/groups/${gB.id}/assignments`, {
    token: tokB,
    method: 'POST',
    body: { userId: tA.owner.id, role: 'TEACHER' },
    headers: H(cB.id),
  });
  check(
    'setup: teacher A assigned to Center B group',
    assignB.status < 300,
    String(assignB.status),
  );
  const roomA = (
    await api('/teacher/rooms', {
      token: tokA,
      method: 'POST',
      body: { name: `Room A ${tag}` },
      headers: H(cA.id),
    })
  ).body;
  const roomB = (
    await api('/teacher/rooms', {
      token: tokB,
      method: 'POST',
      body: { name: `Room B ${tag}` },
      headers: H(cB.id),
    })
  ).body;
  check('setup: rooms', !!roomA?.id && !!roomB?.id);

  // ── 1. Modes ──
  const D = '2027-03-01';
  const phys = await api(`/teacher/groups/${gA.id}/sessions`, {
    token: tokA,
    method: 'POST',
    body: { startAt: day(D, 8), endAt: day(D, 9), roomId: roomA.id, teacherUserId: tA.owner.id },
    headers: H(cA.id),
  });
  check(
    'PHYSICAL in a room → mode PHYSICAL, location CENTER',
    phys.status === 201 && phys.body.mode === 'PHYSICAL' && phys.body.locationType === 'CENTER',
    JSON.stringify(phys.body?.code ?? phys.status),
  );
  check(
    'PHYSICAL without room needs a location',
    (
      await api(`/teacher/groups/${gA.id}/sessions`, {
        token: tokA,
        method: 'POST',
        body: { startAt: day(D, 9), endAt: day(D, 10) },
        headers: H(cA.id),
      })
    ).body?.code === 'LOCATION_REQUIRED',
  );
  const onl = await api(`/teacher/groups/${gA.id}/sessions`, {
    token: tokA,
    method: 'POST',
    body: {
      mode: 'ONLINE',
      startAt: day(D, 10),
      endAt: day(D, 11),
      joinUrl: 'https://meet.test/a',
      teacherUserId: tA.owner.id,
    },
    headers: H(cA.id),
  });
  check(
    'ONLINE with join link → no location',
    onl.status === 201 &&
      onl.body.mode === 'ONLINE' &&
      onl.body.locationType === null &&
      onl.body.roomId === null,
    String(onl.status),
  );
  check(
    'ONLINE with a room is refused',
    (
      await api(`/teacher/groups/${gA.id}/sessions`, {
        token: tokA,
        method: 'POST',
        body: {
          mode: 'ONLINE',
          joinUrl: 'https://m.test',
          roomId: roomA.id,
          startAt: day(D, 12),
          endAt: day(D, 13),
        },
        headers: H(cA.id),
      })
    ).body?.code === 'ONLINE_HAS_LOCATION',
  );
  check(
    'ONLINE without online access is refused',
    (
      await api(`/teacher/groups/${gA.id}/sessions`, {
        token: tokA,
        method: 'POST',
        body: { mode: 'ONLINE', startAt: day(D, 12), endAt: day(D, 13) },
        headers: H(cA.id),
      })
    ).body?.code === 'ONLINE_ACCESS_REQUIRED',
  );
  const hyb = await api(`/teacher/groups/${gA.id}/sessions`, {
    token: tokA,
    method: 'POST',
    body: {
      mode: 'HYBRID',
      locationType: 'STUDENT',
      locationNote: 'Maadi',
      joinUrl: 'https://meet.test/h',
      startAt: day(D, 13),
      endAt: day(D, 14),
      teacherUserId: tA.owner.id,
    },
    headers: H(cA.id),
  });
  check(
    'HYBRID at student location with link',
    hyb.status === 201 &&
      hyb.body.mode === 'HYBRID' &&
      hyb.body.locationType === 'STUDENT' &&
      hyb.body.joinUrl === 'https://meet.test/h',
    String(hyb.status),
  );
  check(
    'HYBRID without location refused',
    (
      await api(`/teacher/groups/${gA.id}/sessions`, {
        token: tokA,
        method: 'POST',
        body: { mode: 'HYBRID', joinUrl: 'https://m.test', startAt: day(D, 15), endAt: day(D, 16) },
        headers: H(cA.id),
      })
    ).body?.code === 'LOCATION_REQUIRED',
  );
  check(
    'invalid mode rejected by validation',
    (
      await api(`/teacher/groups/${gA.id}/sessions`, {
        token: tokA,
        method: 'POST',
        body: { mode: 'REMOTE', startAt: day(D, 15), endAt: day(D, 16) },
        headers: H(cA.id),
      })
    ).status === 400,
  );

  // ── 2. Scope: Group/Room/teacher must all be this academy's ──
  check(
    'forged academyId in the body is rejected',
    (
      await api(`/teacher/groups/${gA.id}/sessions`, {
        token: tokA,
        method: 'POST',
        body: { academyId: cB.id, roomId: roomA.id, startAt: day(D, 15), endAt: day(D, 16) },
        headers: H(cA.id),
      })
    ).status === 400,
  );
  check(
    'a Center B room cannot be used for a Center A session',
    (
      await api(`/teacher/groups/${gA.id}/sessions`, {
        token: tokA,
        method: 'POST',
        body: { roomId: roomB.id, startAt: day(D, 15), endAt: day(D, 16) },
        headers: H(cA.id),
      })
    ).status === 404,
  );
  check(
    'a Center B group cannot be scheduled from a Center A context',
    (
      await api(`/teacher/groups/${gB.id}/sessions`, {
        token: tokA,
        method: 'POST',
        body: { roomId: roomA.id, startAt: day(D, 15), endAt: day(D, 16) },
        headers: H(cA.id),
      })
    ).status === 404,
  );
  check(
    'teacher B (not a member of Center A) cannot be assigned there',
    (
      await api(`/teacher/groups/${gA.id}/sessions`, {
        token: tokA,
        method: 'POST',
        body: {
          roomId: roomA.id,
          teacherUserId: tB.owner.id,
          startAt: day(D, 15),
          endAt: day(D, 16),
        },
        headers: H(cA.id),
      })
    ).body?.code === 'TEACHER_NOT_MEMBER',
  );
  check(
    'a student cannot be the teacher',
    (
      await api(`/teacher/groups/${gA.id}/sessions`, {
        token: tokA,
        method: 'POST',
        body: {
          roomId: roomA.id,
          teacherUserId: student.id,
          startAt: day(D, 15),
          endAt: day(D, 16),
        },
        headers: H(cA.id),
      })
    ).body?.code === 'TEACHER_NOT_ASSIGNABLE',
  );
  const staffAdmin = await prisma.academy.findUnique({
    where: { id: cA.id },
    select: { ownerUserId: true },
  });
  // STAFF path: create a STAFF admin for a third Center and try to be its teacher
  const cS = (
    await api('/admin/centers', {
      token: tokAdmin,
      method: 'POST',
      body: {
        name: `Sched S ${tag}`,
        adminName: 'Staff Admin',
        adminEmail: `staff-sched-${tag}@example.test`,
      },
    })
  ).body;
  cleanup.academyIds.push(cS.id);
  const staffUser = await prisma.user.findUnique({
    where: { email: `staff-sched-${tag}@example.test` },
  });
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
  const tokStaff = await login(`staff-sched-${tag}@example.test`);
  const gS = await mk(tokStaff, cS.id, `S ${tag}`);
  check('STAFF admin can create a group (owner permission)', !!gS?.id);
  check(
    'STAFF cannot be stored as the teacher of a session',
    (
      await api(`/teacher/groups/${gS.id}/sessions`, {
        token: tokStaff,
        method: 'POST',
        body: {
          locationType: 'OTHER',
          teacherUserId: staffUser.id,
          startAt: day(D, 8),
          endAt: day(D, 9),
        },
        headers: H(cS.id),
      })
    ).body?.code === 'TEACHER_NOT_ASSIGNABLE',
  );
  check(
    'STAFF cannot be the teacher of a live stream',
    (
      await api('/teacher/live', {
        token: tokStaff,
        method: 'POST',
        body: { title: 'Staff stream', startsAt: day(D, 8) },
        headers: H(cS.id),
      })
    ).body?.code === 'TEACHER_NOT_ASSIGNABLE',
  );
  check(
    'STAFF can schedule an unassigned physical slot for its Center',
    (
      await api(`/teacher/groups/${gS.id}/sessions`, {
        token: tokStaff,
        method: 'POST',
        body: { locationType: 'OTHER', startAt: day(D, 8), endAt: day(D, 9) },
        headers: H(cS.id),
      })
    ).status === 201,
  );

  // ── 3. Cross-Center read/mutation ──
  const sB = await api(`/teacher/groups/${gB.id}/sessions`, {
    token: tokB,
    method: 'POST',
    body: { roomId: roomB.id, teacherUserId: tB.owner.id, startAt: day(D, 8), endAt: day(D, 9) },
    headers: H(cB.id),
  });
  check('Center B session by its owner', sB.status === 201, String(sB.status));
  check(
    'Center A context cannot update a Center B session',
    (
      await api(`/teacher/sessions/${sB.body.id}`, {
        token: tokA,
        method: 'PATCH',
        body: { startAt: day(D, 9), endAt: day(D, 10) },
        headers: H(cA.id),
      })
    ).status === 404,
  );
  check(
    'Center A context cannot cancel a Center B session',
    (
      await api(`/teacher/sessions/${sB.body.id}`, {
        token: tokA,
        method: 'PATCH',
        body: { status: 'CANCELLED' },
        headers: H(cA.id),
      })
    ).status === 404,
  );
  const schedA = (
    await api(`/academies/${cA.slug}/schedule?from=${day(D, 0)}&to=${day('2027-03-02', 0)}`, {
      token: tokA,
      headers: H(cA.id),
    })
  ).body;
  check(
    'Center A schedule holds only Center A sessions',
    Array.isArray(schedA) &&
      schedA.some((s) => s.id === phys.body.id) &&
      !schedA.some((s) => s.id === sB.body.id),
  );
  const schedB_asA = (
    await api(`/academies/${cB.slug}/schedule?from=${day(D, 0)}&to=${day('2027-03-02', 0)}`, {
      token: tokA,
      headers: H(cB.id),
    })
  ).body;
  check(
    'teacher A in Center B sees only assigned-group sessions there, nothing from Center A',
    Array.isArray(schedB_asA) && !schedB_asA.some((s) => s.id === phys.body.id),
  );

  // ── 4. Live sessions ──
  const liveA = await api('/teacher/live', {
    token: tokA,
    method: 'POST',
    body: { title: `Live A ${tag}`, startsAt: day(D, 16), durationMin: 60, groupId: gA.id },
    headers: H(cA.id),
  });
  check(
    'Center live stream: tenantId = author, academyId = Center, teacherUserId = caller, groupId set',
    liveA.status === 201 &&
      liveA.body.academyId === cA.id &&
      liveA.body.tenantId === tA.id &&
      liveA.body.teacherUserId === tA.owner.id &&
      liveA.body.groupId === gA.id,
    JSON.stringify(liveA.body?.code ?? liveA.status),
  );
  cleanup.liveIds.push(liveA.body?.id);
  check(
    'forged teacherUserId from another Center refused on live create',
    (
      await api('/teacher/live', {
        token: tokA,
        method: 'POST',
        body: { title: 'Forged teacher', startsAt: day(D, 18), teacherUserId: tB.owner.id },
        headers: H(cA.id),
      })
    ).body?.code === 'TEACHER_NOT_MEMBER',
  );
  check(
    'a Center B group cannot back a Center A stream',
    (
      await api('/teacher/live', {
        token: tokA,
        method: 'POST',
        body: { title: 'Foreign group', startsAt: day(D, 18), groupId: gB.id },
        headers: H(cA.id),
      })
    ).status === 404,
  );
  check(
    'Center B owner cannot read/update Center A stream',
    (
      await api(`/teacher/live/${liveA.body.id}`, {
        token: tokB,
        method: 'PATCH',
        body: { title: 'hijack' },
        headers: H(cB.id),
      })
    ).status === 404,
  );
  const liveListB = (await api('/teacher/live', { token: tokB, headers: H(cB.id) })).body;
  check(
    'Center B live list excludes Center A streams',
    Array.isArray(liveListB) && !liveListB.some((l) => l.id === liveA.body.id),
  );
  const personalLive = await api('/teacher/live', {
    token: tokA,
    method: 'POST',
    body: { title: `Personal live ${tag}`, startsAt: day('2027-03-03', 10), durationMin: 60 },
  });
  cleanup.liveIds.push(personalLive.body?.id);
  check(
    'personal stream: academyId == tenantId == the teacher',
    personalLive.status === 201 &&
      personalLive.body.academyId === tA.id &&
      personalLive.body.tenantId === tA.id,
  );

  // ── 5. Conflicts (both tables, across Centers, with DB constraints intact) ──
  check(
    'same teacher overlapping physical slots rejected (409)',
    (
      await api(`/teacher/groups/${gA.id}/sessions`, {
        token: tokA,
        method: 'POST',
        body: {
          roomId: roomA.id,
          teacherUserId: tA.owner.id,
          startAt: day(D, 8, 30),
          endAt: day(D, 9, 30),
        },
        headers: H(cA.id),
      })
    ).status === 409,
  );
  check(
    'same room overlapping rejected',
    (
      await api(`/teacher/groups/${gA.id}/sessions`, {
        token: tokA,
        method: 'POST',
        body: { roomId: roomA.id, startAt: day(D, 8, 15), endAt: day(D, 8, 45) },
        headers: H(cA.id),
      })
    ).status === 409,
  );
  const liveClash = await api('/teacher/live', {
    token: tokA,
    method: 'POST',
    body: { title: 'clash', startsAt: day(D, 8, 30), durationMin: 30 },
    headers: H(cA.id),
  });
  check(
    "a live stream overlapping the teacher's physical slot is rejected (cross-table)",
    liveClash.status === 409 && liveClash.body?.code === 'TEACHER_CONFLICT',
    String(liveClash.status),
  );
  const physVsLive = await api(`/teacher/groups/${gA.id}/sessions`, {
    token: tokA,
    method: 'POST',
    body: {
      locationType: 'OTHER',
      teacherUserId: tA.owner.id,
      startAt: day(D, 16, 30),
      endAt: day(D, 17, 30),
    },
    headers: H(cA.id),
  });
  check(
    "a physical slot overlapping the teacher's live stream is rejected (cross-table)",
    physVsLive.status === 409 && physVsLive.body?.code === 'TEACHER_CONFLICT',
    String(physVsLive.status),
  );
  // Center B's group is free at 13:00, but teacher A is teaching a HYBRID slot in Center A then.
  const crossCenter = await api(`/teacher/groups/${gB.id}/sessions`, {
    token: tokA,
    method: 'POST',
    body: {
      locationType: 'OTHER',
      teacherUserId: tA.owner.id,
      startAt: day(D, 13),
      endAt: day(D, 14),
    },
    headers: H(cB.id),
  });
  check(
    'teacher A cannot be double-booked across Centers, and the foreign id is not revealed',
    crossCenter.status === 409 && crossCenter.body?.conflictingSessionId === undefined,
    JSON.stringify(crossCenter.body ?? crossCenter.status),
  );
  check(
    'non-overlapping slot in Center B accepted (no false conflict)',
    (
      await api(`/teacher/groups/${gB.id}/sessions`, {
        token: tokA,
        method: 'POST',
        body: {
          locationType: 'OTHER',
          teacherUserId: tA.owner.id,
          startAt: day(D, 18),
          endAt: day(D, 19),
        },
        headers: H(cB.id),
      })
    ).status === 201,
  );
  const excl =
    await prisma.$queryRaw`SELECT count(*) AS n FROM pg_constraint WHERE conname IN ('GroupSession_room_no_overlap','GroupSession_teacher_no_overlap','GroupSession_group_no_overlap')`;
  check('DB exclusion constraints still present', Number(excl[0].n) === 3);

  // ── 6. Cairo local-day bucketing ──
  // 22:30Z on Mar 1 is 00:30 on Mar 2 in Cairo (UTC+2 in March).
  const midnight = await api(`/teacher/groups/${gA.id}/sessions`, {
    token: tokA,
    method: 'POST',
    body: { locationType: 'OTHER', startAt: day(D, 22, 30), endAt: day(D, 23, 30) },
    headers: H(cA.id),
  });
  const startLocal = new Date(midnight.body.startAt);
  check(
    'a session at 22:30Z lands on the NEXT Cairo-local day (fixed helper)',
    localDayKey(startLocal) === '2027-03-02',
    localDayKey(startLocal),
  );
  check(
    '…while the old UTC-date bucketing would have put it on Mar 1 (the bug)',
    startLocal.toISOString().slice(0, 10) === '2027-03-01',
  );

  // ── 7. Teacher unified schedule ──
  const mine = (
    await api(`/me/schedule?from=${day(D, 0)}&to=${day('2027-03-04', 0)}`, { token: tokA })
  ).body;
  const kinds = (ids) =>
    mine
      .filter((e) => ids.includes(e.id))
      .map(
        (e) =>
          `${e.kind}:${e.academyId === cA.id ? 'A' : e.academyId === cB.id ? 'B' : e.academyId === tA.id ? 'P' : '?'}`,
      )
      .sort();
  check(
    'My Schedule spans Center A (physical + live), Center B (physical) and Personal (live)',
    mine &&
      kinds([phys.body.id, liveA.body.id, personalLive.body.id]).join(',') ===
        'GROUP:A,LIVE:A,LIVE:P' &&
      mine.some((e) => e.academyId === cB.id),
    JSON.stringify(kinds([phys.body.id, liveA.body.id, personalLive.body.id])),
  );
  check(
    "My Schedule never includes teacher B's Center B session",
    !mine.some((e) => e.id === sB.body.id),
  );
  check(
    'every event carries its academy context',
    mine.every((e) => e.academy && e.academy.id),
  );
  const mineB = (
    await api(`/me/schedule?from=${day(D, 0)}&to=${day('2027-03-04', 0)}`, { token: tokB })
  ).body;
  check(
    "teacher B's My Schedule holds none of teacher A's sessions",
    !mineB.some((e) => [phys.body.id, liveA.body.id, personalLive.body.id].includes(e.id)),
  );

  // ── 8. Removal cleanup ──
  const bMembership = await prisma.academyMembership.findUnique({
    where: { userId_academyId: { userId: tA.owner.id, academyId: cB.id } },
  });
  const attendance = await prisma.attendanceSession.create({
    data: {
      groupId: gB.id,
      academyId: cB.id,
      date: new Date('2027-02-01'),
      createdBy: tB.owner.id,
    },
  });
  const futureB = await prisma.groupSession.findFirst({
    where: { academyId: cB.id, teacherUserId: tA.owner.id, startAt: { gt: new Date() } },
  });
  check(
    'OWNER removes teacher A from Center B',
    (
      await api(`/academies/${cB.slug}/members/${bMembership.id}`, {
        token: tokB,
        method: 'DELETE',
        headers: H(cB.id),
      })
    ).status < 300,
  );
  check(
    'future Center B slot lost the teacher assignment',
    (await prisma.groupSession.findUnique({ where: { id: futureB.id } })).teacherUserId === null,
  );
  check(
    'the slot itself and attendance history remain',
    (await prisma.groupSession.count({ where: { id: futureB.id } })) === 1 &&
      (await prisma.attendanceSession.count({ where: { id: attendance.id } })) === 1,
  );
  check(
    'teacher A can no longer touch Center B scheduling',
    (
      await api(`/teacher/groups/${gB.id}/sessions`, {
        token: tokA,
        method: 'POST',
        body: { locationType: 'OTHER', startAt: day('2027-03-05', 8), endAt: day('2027-03-05', 9) },
        headers: H(cB.id),
      })
    ).status === 404,
  );
  check(
    'teacher A can no longer touch Center B live streams',
    (
      await api('/teacher/live', {
        token: tokA,
        method: 'POST',
        body: { title: 'After removal', startsAt: day('2027-03-05', 8) },
        headers: H(cB.id),
      })
    ).status === 404,
  );
  check(
    'teacher A still schedules in Center A and Personal',
    (
      await api(`/teacher/groups/${gA.id}/sessions`, {
        token: tokA,
        method: 'POST',
        body: { locationType: 'OTHER', startAt: day('2027-03-05', 8), endAt: day('2027-03-05', 9) },
        headers: H(cA.id),
      })
    ).status === 201 &&
      (await api(`/academies/${tA.slug}/me`, { token: tokA })).body?.role === 'OWNER',
  );
  check(
    'TeacherProfile untouched',
    (await prisma.teacherProfile.findUnique({ where: { id: tA.id }, select: { status: true } }))
      .status === 'APPROVED',
  );

  // ── 9. Personal isolation ──
  const schedP = (
    await api(`/academies/${tA.slug}/schedule?from=${day(D, 0)}&to=${day('2027-03-04', 0)}`, {
      token: tokA,
    })
  ).body;
  check(
    'Personal schedule contains no Center sessions',
    !schedP.some((e) => [phys.body.id, sB.body.id, liveA.body.id].includes(e.id)),
  );
  await prisma.attendanceSession.delete({ where: { id: attendance.id } }).catch(() => {});
  check('database counts (pre-cleanup snapshot recorded)', true, before);
}

main()
  .catch((e) => {
    console.error('\nUNCAUGHT:', e);
    fail++;
  })
  .finally(async () => {
    await prisma.$executeRaw`DELETE FROM "LiveSession" WHERE "academyId" = ANY(${cleanup.academyIds}::text[]) OR "id" = ANY(${cleanup.liveIds.filter(Boolean)}::text[])`.catch(
      () => {},
    );
    await prisma.$executeRaw`DELETE FROM "GroupSession" WHERE "groupId" = ANY(${cleanup.groupIds.filter(Boolean)}::text[])`.catch(
      () => {},
    );
    await prisma.$executeRaw`DELETE FROM "AttendanceSession" WHERE "groupId" = ANY(${cleanup.groupIds.filter(Boolean)}::text[])`.catch(
      () => {},
    );
    await prisma.$executeRaw`DELETE FROM "Group" WHERE "id" = ANY(${cleanup.groupIds.filter(Boolean)}::text[])`.catch(
      () => {},
    );
    await prisma.$executeRaw`DELETE FROM "Room" WHERE "academyId" = ANY(${cleanup.academyIds}::text[])`.catch(
      () => {},
    );
    await prisma.$executeRaw`DELETE FROM "Academy" WHERE "id" = ANY(${cleanup.academyIds}::text[])`.catch(
      () => {},
    );
    await prisma.$executeRaw`DELETE FROM "User" WHERE "email" LIKE ${`staff-sched-${tag}@example.test`}`.catch(
      () => {},
    );
    console.log('   after-cleanup counts:', await counts());
    await prisma.$disconnect();
    console.log(`\n== ${pass} passed, ${fail} failed ==`);
    process.exit(fail ? 1 : 0);
  });
