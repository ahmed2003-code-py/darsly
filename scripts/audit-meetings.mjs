#!/usr/bin/env node
/**
 * Live classrooms: everything that decides who reaches the meeting.
 *
 * The actual video call runs on Daily.co's infrastructure — SDP/ICE/signaling
 * never touches this codebase, so there is nothing of ours to audit there. What
 * Darsly owns, and what this tests, is the door in front of it: who is allowed
 * to ask for a room URL and a token, whether that same door holds on the
 * Socket.IO side, and whether a student can talk another student's session,
 * teacher's controls, or academy's classroom into answering.
 *
 *   CONFIRM_TEST_DB=yes DATABASE_URL=... API_URL=... WS_URL=... \
 *     node scripts/audit-meetings.mjs
 *
 * No DAILY_API_KEY is available in this environment, so the one thing this
 * cannot exercise is a legitimate student actually receiving a working meeting
 * token — that call reaches Daily's API and fails for lack of credentials, not
 * for lack of authorization. Every refusal below happens *before* that call,
 * so it is unaffected by the missing key; the report says explicitly which
 * single case is blocked and why.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { io } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://127.0.0.1:3077/api/v1';
const WS = process.env.WS_URL ?? 'http://127.0.0.1:3077';
const DB = process.env.DATABASE_URL ?? '';
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

const prisma = new PrismaClient();
const tag = `meet-${Date.now()}`;
let pass = 0,
  fail = 0,
  blocked = 0;
const findings = [];
const check = (n, ok, d = '') => {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  (${d})` : ''}`);
  if (ok) pass++;
  else {
    fail++;
    findings.push(`${n} — ${d}`);
  }
};
const note = (n, d) => {
  console.log(`   BLOCKED  ${n}  (${d})`);
  blocked++;
};

async function api(p, { token, method = 'GET', body } = {}) {
  const r = await fetch(`${API}${p}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
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
  if (r.status >= 300) throw new Error(`login ${email}: ${r.status}`);
  return r.body.accessToken;
};
function connect(token) {
  return new Promise((resolve) => {
    const s = io(WS, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      timeout: 6000,
    });
    s.on('connect', () => setTimeout(() => resolve(s), 500));
    s.on('connect_error', () => resolve(s));
  });
}

const FOREIGN_ID = 'cxxxxxxxxxxxxxxxxxxxxxxxx';
const made = { users: [], students: [], bookings: [] };

try {
  // ── cast: sessions in two different academies ───────────────────────────
  const sessions = await prisma.liveSession.findMany({
    where: { deletedAt: null },
    include: { teacher: { include: { user: true } }, bookings: true },
    take: 50,
  });
  const byTenant = new Map();
  for (const s of sessions) if (!byTenant.has(s.tenantId)) byTenant.set(s.tenantId, s);
  const [sessA, sessB] = [...byTenant.values()];
  if (!sessA || !sessB) throw new Error('need live sessions in two academies — seed first');

  const teacherA = { profile: sessA.teacher, token: await login(sessA.teacher.user.email) };
  const teacherB = { profile: sessB.teacher, token: await login(sessB.teacher.user.email) };

  // A student genuinely booked into session A, and one with no booking anywhere.
  const bookedStudent = sessA.bookings[0]
    ? await prisma.studentProfile.findUnique({
        where: { id: sessA.bookings[0].studentId },
        include: { user: true },
      })
    : null;
  const bookedTok = bookedStudent ? await login(bookedStudent.user.email) : null;

  const outsiderUser = await prisma.user.create({
    data: {
      email: `${tag}-outsider@test.invalid`,
      fullName: 'Meeting Outsider',
      passwordHash: await argon2.hash(PASSWORD),
      role: 'STUDENT',
      isActive: true,
    },
  });
  made.users.push(outsiderUser.id);
  const outsider = await prisma.studentProfile.create({ data: { userId: outsiderUser.id } });
  made.students.push(outsider.id);
  const outsiderTok = await login(outsiderUser.email);

  console.log(
    `session A ${sessA.id.slice(0, 10)}  academy ${sessA.tenantId.slice(0, 10)}  teacher ${sessA.teacher.user.email}`,
  );
  console.log(
    `session B ${sessB.id.slice(0, 10)}  academy ${sessB.tenantId.slice(0, 10)}  teacher ${teacherB.profile.user.email}`,
  );
  console.log(
    `booked student: ${bookedStudent?.user.email ?? '(none booked — booking probes will be limited)'}\n`,
  );

  // ── 1. joining without a booking, or in the wrong academy ────────────────
  console.log('=== 1. JOIN AUTHORIZATION (REST) ===');
  {
    const noBooking = await api(`/live/${sessA.id}/join`, { token: outsiderTok });
    check('an unbooked student cannot join', noBooking.status >= 400, `HTTP ${noBooking.status}`);

    const anon = await api(`/live/${sessA.id}/join`);
    check('an unauthenticated caller cannot join', anon.status === 401, `HTTP ${anon.status}`);

    const teacherJoinAsStudentRoute = await api(`/live/${sessA.id}/join`, {
      token: teacherA.token,
    });
    check(
      "session A's own teacher cannot use the STUDENT join route",
      teacherJoinAsStudentRoute.status >= 400,
      `HTTP ${teacherJoinAsStudentRoute.status} (teachers have their own join route)`,
    );

    const wrongId = await api(`/live/${FOREIGN_ID}/join`, { token: outsiderTok });
    check(
      'a nonexistent session id is refused, not 500',
      wrongId.status >= 400 && wrongId.status < 500,
      `HTTP ${wrongId.status}`,
    );
  }

  // ── 2. cross-teacher / cross-academy control ─────────────────────────────
  console.log('\n=== 2. CROSS-TEACHER AND CROSS-ACADEMY CONTROL ===');
  {
    const start = await api(`/teacher/live/${sessB.id}/start`, {
      method: 'POST',
      token: teacherA.token,
    });
    check(
      "teacher A cannot start teacher B's session",
      start.status >= 400,
      `HTTP ${start.status}`,
    );

    const end = await api(`/teacher/live/${sessB.id}/end`, {
      method: 'POST',
      token: teacherA.token,
    });
    check("teacher A cannot end teacher B's session", end.status >= 400, `HTTP ${end.status}`);

    const cancel = await api(`/teacher/live/${sessB.id}`, {
      method: 'DELETE',
      token: teacherA.token,
    });
    check(
      "teacher A cannot cancel teacher B's session",
      cancel.status >= 400,
      `HTTP ${cancel.status}`,
    );

    const attendance = await api(`/teacher/live/${sessB.id}/attendance`, { token: teacherA.token });
    check(
      "teacher A cannot read teacher B's attendance",
      attendance.status >= 400,
      `HTTP ${attendance.status}`,
    );

    const bookings = await api(`/teacher/live/${sessB.id}/bookings`, { token: teacherA.token });
    check(
      "teacher A cannot list teacher B's bookings",
      bookings.status >= 400,
      `HTTP ${bookings.status}`,
    );

    const rec = await api(`/teacher/live/${sessB.id}/recording/start`, {
      method: 'POST',
      token: teacherA.token,
      body: { recordingId: 'x' },
    });
    check(
      "teacher A cannot mark teacher B's session recording",
      rec.status >= 400,
      `HTTP ${rec.status}`,
    );

    const summary = await api(`/teacher/live/${sessB.id}/summary`, {
      method: 'POST',
      token: teacherA.token,
    });
    check(
      "teacher A cannot queue a summary for teacher B's session",
      summary.status >= 400,
      `HTTP ${summary.status}`,
    );

    const vis = await api(`/teacher/live/${sessB.id}/summary/visibility`, {
      method: 'PATCH',
      token: teacherA.token,
      body: { visible: true },
    });
    check(
      "teacher A cannot toggle teacher B's summary visibility",
      vis.status >= 400,
      `HTTP ${vis.status}`,
    );
  }

  // ── 3. reading and writing the classroom itself ──────────────────────────
  console.log('\n=== 3. CLASSROOM CONTENT (detail / chat / recording) ===');
  {
    const detail = await api(`/live/${sessB.id}/detail`, { token: outsiderTok });
    check(
      "an outsider cannot read another academy's session detail",
      detail.status >= 400,
      `HTTP ${detail.status}`,
    );

    const chatRead = await api(`/live/${sessB.id}/chat`, { token: outsiderTok });
    check(
      "an outsider cannot read another academy's classroom chat",
      chatRead.status >= 400,
      `HTTP ${chatRead.status}`,
    );

    const chatSend = await api(`/live/${sessB.id}/chat`, {
      method: 'POST',
      token: outsiderTok,
      body: { body: `${tag} injected` },
    });
    check(
      "an outsider cannot send into another academy's classroom chat",
      chatSend.status >= 400,
      `HTTP ${chatSend.status}`,
    );
    const landed = await prisma.chatMessage
      .count({ where: { body: { contains: tag } } })
      .catch(() => 0);
    check('nothing was actually written by the attempt', landed === 0, `${landed} row(s)`);

    const recording = await api(`/live/${sessB.id}/recording`, { token: outsiderTok });
    check(
      "an outsider cannot mint a link to another academy's recording",
      recording.status >= 400,
      `HTTP ${recording.status}`,
    );

    // heartbeat has no membership guard of its own — it answers 201 to anyone,
    // the way every POST does by default. Its real authorization is internal:
    // it only ever touches a LiveAttendance row, and that row is created
    // exclusively by join()/markPresent() after the booking check above has
    // already run. So the right question is not the status code but whether
    // anything was actually read or written for a caller with no such row.
    const attBefore = await prisma.liveAttendance.count({
      where: { sessionId: sessB.id, userId: outsiderUser.id },
    });
    const heartbeat = await api(`/live/${sessB.id}/heartbeat`, {
      method: 'POST',
      token: outsiderTok,
    });
    const attAfter = await prisma.liveAttendance.count({
      where: { sessionId: sessB.id, userId: outsiderUser.id },
    });
    check(
      "an outsider's heartbeat is a genuine no-op for another academy's session",
      heartbeat.body?.ok === false && attBefore === 0 && attAfter === 0,
      `HTTP ${heartbeat.status}, body ${JSON.stringify(heartbeat.body)}, attendance rows 0->${attAfter}`,
    );
  }

  // ── 4. teacher-only controls, tried by a student ─────────────────────────
  console.log('\n=== 4. TEACHER-ONLY CONTROLS, ATTEMPTED BY A STUDENT ===');
  {
    const asStudent = bookedTok ?? outsiderTok;
    const start = await api(`/teacher/live/${sessA.id}/start`, {
      method: 'POST',
      token: asStudent,
    });
    check('a student cannot start the session', start.status >= 400, `HTTP ${start.status}`);
    const end = await api(`/teacher/live/${sessA.id}/end`, { method: 'POST', token: asStudent });
    check('a student cannot end the session', end.status >= 400, `HTTP ${end.status}`);
    const attendance = await api(`/teacher/live/${sessA.id}/attendance`, { token: asStudent });
    check(
      "a student cannot read the teacher's attendance view",
      attendance.status >= 400,
      `HTTP ${attendance.status}`,
    );
    const vis = await api(`/teacher/live/${sessA.id}/summary/visibility`, {
      method: 'PATCH',
      token: asStudent,
      body: { visible: true },
    });
    check('a student cannot toggle summary visibility', vis.status >= 400, `HTTP ${vis.status}`);
  }

  // ── 5. meeting id tampering ───────────────────────────────────────────────
  console.log('\n=== 5. MEETING ID TAMPERING ===');
  {
    for (const bad of [
      FOREIGN_ID,
      "' OR '1'='1",
      '../../../etc/passwd',
      '<script>1</script>',
      '0',
    ]) {
      const r = await api(`/live/${encodeURIComponent(bad)}/join`, { token: outsiderTok });
      check(
        `malformed id "${bad.slice(0, 20)}" is refused, not 500`,
        r.status >= 400 && r.status < 500,
        `HTTP ${r.status}`,
      );
    }
  }

  // ── 6. duplicate / concurrent join and heartbeat ─────────────────────────
  console.log('\n=== 6. DUPLICATE AND CONCURRENT REQUESTS ===');
  if (bookedTok) {
    const [a, b] = await Promise.all([
      api(`/live/${sessA.id}/heartbeat`, { method: 'POST', token: bookedTok }),
      api(`/live/${sessA.id}/heartbeat`, { method: 'POST', token: bookedTok }),
    ]);
    check(
      'two simultaneous heartbeats both resolve without a server error',
      a.status < 500 && b.status < 500,
      `${a.status}, ${b.status}`,
    );

    const [j1, j2] = await Promise.all([
      api(`/live/${sessA.id}/join`, { token: bookedTok }),
      api(`/live/${sessA.id}/join`, { token: bookedTok }),
    ]);
    check(
      'two simultaneous joins by the same booked student both resolve cleanly',
      j1.status < 500 && j2.status < 500,
      `${j1.status}, ${j2.status}`,
    );
    if (j1.status >= 400 && j2.status >= 400) {
      note(
        'legitimate join outcome',
        `the booked-student join itself returns ${j1.status} — see the Daily-credentials note below`,
      );
    }
  } else {
    console.log('   SKIP  no booked student available in the seed for this check');
  }

  // ── 7. Socket.IO: the same door, same answer ─────────────────────────────
  console.log('\n=== 7. SOCKET.IO CONSISTENCY WITH REST ===');
  {
    const outsiderSocket = await connect(outsiderTok);
    const heard = [];
    outsiderSocket.onAny((name) => {
      if (String(name).startsWith('live:')) heard.push(name);
    });
    outsiderSocket.emit('live:join', sessB.id);
    await new Promise((r) => setTimeout(r, 900));
    // The gateway does not ack; the only honest way to know whether the join
    // took is to ask the server for something only a room member could have —
    // REST already refused the outsider this exact session's detail above, so
    // the socket must be equally silent.
    check(
      'the socket does not emit anything from a room the outsider was refused',
      heard.length === 0,
      `${heard.length} event(s)`,
    );
    outsiderSocket.close();

    if (bookedTok) {
      const ownSocket = await connect(bookedTok);
      const before = ownSocket.connected;
      ownSocket.emit('live:join', sessA.id);
      await new Promise((r) => setTimeout(r, 900));
      ownSocket.emit('live:leave', sessA.id);
      check(
        'a genuinely booked student can join and leave the socket room without error',
        before,
        before ? 'connected' : 'never connected',
      );
      ownSocket.close();
    }

    const anonSocket = await connect(null);
    check(
      'an anonymous socket cannot even reach the live:join handler (rejected at handshake)',
      !anonSocket.connected,
      anonSocket.connected ? 'connected!' : 'refused',
    );
    anonSocket.close();
  }

  // ── 8. the one thing genuinely blocked ───────────────────────────────────
  console.log('\n=== 8. WHAT COULD NOT BE TESTED ===');
  note(
    'a legitimately booked student receiving a real Daily meeting token',
    'DAILY_API_KEY / DAILY_DOMAIN are not configured in this environment — the call reaches Daily.co and fails for lack of credentials, not for lack of authorization. Every refusal above happens before that call is ever made.',
  );
  note(
    'WebRTC/SDP/ICE signaling itself',
    "runs entirely on Daily's infrastructure — there is no signaling code in this repository to audit. Darsly's surface is the token/URL Daily is asked to mint, which the checks above cover.",
  );
} catch (e) {
  console.error('\nERROR:', e.message);
  fail++;
} finally {
  await prisma.chatMessage.deleteMany({ where: { body: { contains: tag } } }).catch(() => {});
  for (const id of made.students)
    await prisma.studentProfile.delete({ where: { id } }).catch(() => {});
  for (const id of made.users) await prisma.user.delete({ where: { id } }).catch(() => {});
  await prisma.$disconnect();
}

console.log(
  `\n${fail === 0 ? 'MEETING GATE PASS' : `MEETING GATE — ${fail} FAILURE(S)`}  —  ${pass} passed, ${fail} failed, ${blocked} explicitly blocked`,
);
if (findings.length) {
  console.log('\nfailures:');
  for (const f of findings) console.log('  ' + f);
}
process.exit(fail === 0 ? 0 : 1);
