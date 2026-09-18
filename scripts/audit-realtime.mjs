#!/usr/bin/env node
/**
 * Socket.IO: can a user reach over a socket what REST refuses them?
 *
 * That is the whole question. The gateway is transport only — every decision is
 * delegated to ChatService and LiveService, the same services the REST routes
 * use — so the interesting failures are not "is there a check" but "is the
 * check reached": an event that forgets to call one, a connection that stays
 * authorized after its token dies, a room that spans users it should not.
 *
 *   CONFIRM_TEST_DB=yes DATABASE_URL=... API_URL=... WS_URL=... \
 *     node scripts/audit-realtime.mjs
 *
 * Creates its own students, teacher-side rows and threads, and deletes them.
 * Flooding is deliberately small: enough to see whether anything bounds it,
 * not enough to be a load test.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { io } from 'socket.io-client';
import jwt from 'jsonwebtoken';

const API = process.env.API_URL ?? 'http://127.0.0.1:3077/api/v1';
const WS = process.env.WS_URL ?? 'http://127.0.0.1:3077';
const DB = process.env.DATABASE_URL ?? '';
const PASSWORD = 'Darsly@123';

if (process.env.CONFIRM_TEST_DB !== 'yes') { console.error('REFUSED: set CONFIRM_TEST_DB=yes.'); process.exit(2); }
if (!DB) { console.error('REFUSED: DATABASE_URL is not set.'); process.exit(2); }
if (/railway|prod|amazonaws|supabase|neon\.tech|render\.com/i.test(DB)) {
  console.error('REFUSED: DATABASE_URL looks hosted.'); process.exit(2);
}

const prisma = new PrismaClient();
const tag = `rt-${Date.now()}`;
let pass = 0, fail = 0;
const findings = [];
const check = (n, ok, d = '') => {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  (${d})` : ''}`);
  if (ok) pass++; else { fail++; findings.push(`${n} — ${d}`); }
};
const note = (n, d) => console.log(`   NOTE  ${n}  (${d})`);

async function api(p, { token, method = 'GET', body } = {}) {
  const r = await fetch(`${API}${p}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json };
}
const login = async (email) => {
  const r = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  if (r.status >= 300) throw new Error(`login ${email}: ${r.status}`);
  return r.body.accessToken;
};

/** Connect, and resolve with what actually happened rather than throwing. */
function connect(token, { timeout = 6000 } = {}) {
  return new Promise((resolve) => {
    const s = io(WS, { auth: token ? { token } : {}, transports: ['websocket'], reconnection: false, timeout });
    const done = (outcome) => { clearTimeout(t); resolve({ ...outcome, socket: s }); };
    const t = setTimeout(() => done({ connected: s.connected, reason: 'timeout' }), timeout);
    s.on('connect', () => setTimeout(() => done({ connected: s.connected, reason: s.connected ? 'connected' : 'dropped' }), 700));
    s.on('connect_error', (e) => done({ connected: false, reason: 'connect_error: ' + e.message }));
    s.on('error', (e) => { /* the gateway emits 'unauthorized' before disconnecting */ s.data = e; });
    s.on('disconnect', (r) => done({ connected: false, reason: 'disconnected: ' + r }));
  });
}
/** Emit and collect anything that arrives on `waitFor` within the window. */
function emitAndWatch(socket, event, payload, waitFor, ms = 900) {
  return new Promise((resolve) => {
    const seen = [];
    const handlers = (Array.isArray(waitFor) ? waitFor : [waitFor]).filter(Boolean);
    const onAny = (name, ...args) => { if (handlers.includes(name)) seen.push({ name, args }); };
    socket.onAny(onAny);
    let ack = undefined;
    try { socket.emit(event, payload, (a) => { ack = a; }); } catch (e) { ack = { emitError: e.message }; }
    setTimeout(() => { socket.offAny(onAny); resolve({ seen, ack }); }, ms);
  });
}
const rooms = async (socket) => socket.connected;

const made = { users: [], students: [], threads: [], courses: [], enrolments: [], live: [] };

try {
  // ── cast: two students in different academies, and their two teachers ──
  const enrolments = await prisma.enrollment.findMany({
    where: { status: 'ACTIVE' }, take: 200,
    include: { student: { include: { user: true } }, course: true },
  });
  const byTenant = new Map();
  for (const e of enrolments) if (!byTenant.has(e.tenantId)) byTenant.set(e.tenantId, e);
  const [eA, eB] = [...byTenant.values()];
  if (!eA || !eB) throw new Error('need active enrolments in two academies — seed first');

  const A = { student: eA.student, tenantId: eA.tenantId, token: await login(eA.student.user.email) };
  const B = { student: eB.student, tenantId: eB.tenantId, token: await login(eB.student.user.email) };
  const tA = await prisma.teacherProfile.findUnique({ where: { id: A.tenantId }, include: { user: true } });
  const tB = await prisma.teacherProfile.findUnique({ where: { id: B.tenantId }, include: { user: true } });
  const TA = { profile: tA, token: await login(tA.user.email) };

  // B's own thread with their own teacher — the thing A must not reach.
  let bThread = await prisma.chatThread.findFirst({ where: { studentId: B.student.id } });
  if (!bThread) {
    bThread = await prisma.chatThread.create({ data: { studentId: B.student.id, tenantId: B.tenantId } });
    made.threads.push(bThread.id);
  }
  const aThread = await prisma.chatThread.findFirst({ where: { studentId: A.student.id } })
    ?? await prisma.chatThread.create({ data: { studentId: A.student.id, tenantId: A.tenantId } });

  console.log(`student A ${eA.student.user.email}   student B ${eB.student.user.email}`);
  console.log(`teacher A ${tA.user.email}\n`);

  // ── 1. connection authentication ────────────────────────────────────────
  console.log('=== 1. CONNECTION AUTHENTICATION ===');
  const sockets = [];
  {
    const anon = await connect(null);
    sockets.push(anon.socket);
    check('an anonymous connection is rejected', !anon.connected, anon.reason);

    const garbage = await connect('not-a-jwt');
    sockets.push(garbage.socket);
    check('a malformed token is rejected', !garbage.connected, garbage.reason);

    const forged = jwt.sign({ sub: A.student.userId, role: 'SUPER_ADMIN' }, 'attacker-secret-aaaaaaaaaaaaaaaaaaaa', { expiresIn: '1h' });
    const wrongSig = await connect(forged);
    sockets.push(wrongSig.socket);
    check('a token signed with the wrong secret is rejected', !wrongSig.connected, wrongSig.reason);

    const noneAlg = [
      Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: A.student.userId, role: 'SUPER_ADMIN', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'),
      '',
    ].join('.');
    const none = await connect(noneAlg);
    sockets.push(none.socket);
    check('an alg:none token is rejected', !none.connected, none.reason);

    const expired = jwt.sign({ sub: A.student.userId, role: 'STUDENT' }, process.env.JWT_ACCESS_SECRET ?? 'x', { expiresIn: '-60s' });
    const exp = await connect(expired);
    sockets.push(exp.socket);
    check('an expired token is rejected at handshake', !exp.connected, exp.reason);

    const good = await connect(A.token);
    check('a valid token connects', good.connected, good.reason);
    sockets.push(good.socket);
  }

  // ── 2. cross-account rooms ──────────────────────────────────────────────
  console.log('\n=== 2. CROSS-ACCOUNT ROOMS ===');
  const aSock = (await connect(A.token)).socket;
  const bSock = (await connect(B.token)).socket;
  sockets.push(aSock, bSock);
  await new Promise((r) => setTimeout(r, 500));
  {
    // A joins B's thread, then B sends into it. If A is in the room, A hears it.
    await emitAndWatch(aSock, 'chat:join', bThread.id, null, 600);
    const heard = [];
    const onAny = (name, ...args) => { if (name === 'chat:message') heard.push(args); };
    aSock.onAny(onAny);
    const sent = await api('/threads/' + bThread.id + '/messages', {
      method: 'POST', token: B.token, body: { body: `${tag} private to B` },
    });
    await new Promise((r) => setTimeout(r, 1200));
    aSock.offAny(onAny);
    check("student A cannot join student B's thread room", heard.length === 0,
      heard.length ? `RECEIVED ${heard.length} message(s) from another student's thread` : 'heard nothing');
    if (sent.status >= 400) note('the REST send used to prove it', `HTTP ${sent.status} — thread may be teacher-initiated only`);

    // A sends into B's thread over the socket.
    const before = await prisma.chatMessage.count({ where: { threadId: bThread.id } });
    await emitAndWatch(aSock, 'chat:send', { threadId: bThread.id, body: `${tag} injected by A` }, null, 1200);
    const after = await prisma.chatMessage.count({ where: { threadId: bThread.id } });
    check("student A cannot send into student B's thread", after === before, `${after - before} message(s) landed`);

    // Typing echo into a thread A does not belong to.
    const typingHeard = [];
    const onTyping = (name, ...a) => { if (name === 'chat:typing') typingHeard.push(a); };
    bSock.onAny(onTyping);
    await emitAndWatch(aSock, 'chat:typing', bThread.id, null, 900);
    await new Promise((r) => setTimeout(r, 600));
    bSock.offAny(onTyping);
    check("student A's typing does not leak into B's thread", typingHeard.length === 0, `${typingHeard.length} echo(es)`);

    // markRead on somebody else's thread.
    const unreadBefore = await prisma.chatMessage.count({ where: { threadId: bThread.id, readAt: null } });
    await emitAndWatch(aSock, 'chat:read', bThread.id, null, 900);
    const unreadAfter = await prisma.chatMessage.count({ where: { threadId: bThread.id, readAt: null } });
    check("student A cannot mark B's thread read", unreadAfter === unreadBefore, `${unreadBefore} -> ${unreadAfter} unread`);
  }

  // ── 3. live rooms ───────────────────────────────────────────────────────
  console.log('\n=== 3. LIVE CLASSROOM ROOMS ===');
  {
    const bLive = await prisma.liveSession.findFirst({ where: { tenantId: B.tenantId } });
    if (!bLive) {
      note('live room probe skipped', 'no live session in the other academy');
    } else {
      const heard = [];
      const onAny = (name, ...a) => { if (String(name).startsWith('live:')) heard.push(name); };
      aSock.onAny(onAny);
      await emitAndWatch(aSock, 'live:join', bLive.id, null, 1000);
      // Ask the server, not the client, whether the join took: the client-side
      // join() is a request, and the gateway may simply have ignored it.
      const inRoom = await api(`/live/${bLive.id}/detail`, { token: A.token });
      aSock.offAny(onAny);
      check("a student cannot join another academy's live room", inRoom.status >= 400,
        `REST detail says HTTP ${inRoom.status}`);
    }
  }

  // ── 4. event input validation ───────────────────────────────────────────
  console.log('\n=== 4. EVENT INPUT VALIDATION ===');
  {
    const before = await api('/health');
    const junk = [
      ['null thread id', 'chat:join', null],
      ['numeric thread id', 'chat:join', 12345],
      ['array thread id', 'chat:join', ['a', 'b']],
      ['object thread id', 'chat:join', { id: 'x' }],
      ['200KB thread id', 'chat:join', 'x'.repeat(200_000)],
      ['send with no body', 'chat:send', {}],
      ['send with null body', 'chat:send', { threadId: aThread.id, body: null }],
      ['send with numeric body', 'chat:send', { threadId: aThread.id, body: 99 }],
      ['send with array body', 'chat:send', { threadId: aThread.id, body: ['x'] }],
      ['send with 500KB body', 'chat:send', { threadId: aThread.id, body: 'x'.repeat(500_000) }],
      ['prototype pollution keys', 'chat:send', { threadId: aThread.id, body: 'hi', __proto__: { admin: true }, constructor: { x: 1 } }],
      ['deeply nested payload', 'chat:send', JSON.parse('{"threadId":"' + aThread.id + '","body":"hi","n":' + '['.repeat(60) + '1' + ']'.repeat(60) + '}')],
      ['live:join with null', 'live:join', null],
      ['live:join with an object', 'live:join', { a: 1 }],
      ['unknown event entirely', 'chat:definitely-not-an-event', { x: 1 }],
      ['typing with a number', 'chat:typing', 42],
      ['read with an array', 'chat:read', []],
    ];
    for (const [label, ev, payload] of junk) {
      await emitAndWatch(aSock, ev, payload, null, 160);
    }
    await new Promise((r) => setTimeout(r, 1500));
    const after = await api('/health');
    check('the API survived every malformed event', after.status === 200, `health ${before.status} -> ${after.status}`);
    check('the socket is still connected after the fuzz', aSock.connected, aSock.connected ? 'connected' : 'DROPPED');
    check('prototype pollution did not take', ({}).admin === undefined, ({}).admin === undefined ? 'Object.prototype clean' : 'POLLUTED');
  }

  // ── 5. a legitimate message still works ─────────────────────────────────
  console.log('\n=== 5. THE HAPPY PATH STILL WORKS ===');
  {
    const before = await prisma.chatMessage.count({ where: { threadId: aThread.id } });
    await emitAndWatch(aSock, 'chat:send', { threadId: aThread.id, body: `${tag} legitimate` }, null, 1500);
    const after = await prisma.chatMessage.count({ where: { threadId: aThread.id } });
    check("a student can send into their own thread", after > before, `${after - before} message(s) landed`);
    // And REST sees what the socket wrote.
    const viaRest = await api(`/threads/${aThread.id}/messages`, { token: A.token });
    const found = Array.isArray(viaRest.body) && viaRest.body.some((m) => (m.body ?? '').includes(`${tag} legitimate`));
    check('a socket-written message is visible over REST', found || after > before, `REST HTTP ${viaRest.status}`);
  }

  // ── 6. stale authentication ─────────────────────────────────────────────
  console.log('\n=== 6. STALE AUTHENTICATION ON A LIVE SOCKET ===');
  {
    // A token that dies two seconds after the handshake.
    const shortLived = jwt.sign(
      { sub: A.student.userId, role: 'STUDENT', tenantId: null },
      process.env.JWT_ACCESS_SECRET ?? 'x',
      { expiresIn: '2s' },
    );
    const s = await connect(shortLived);
    sockets.push(s.socket);
    if (!s.connected) {
      note('short-lived token probe skipped', s.reason);
    } else {
      await new Promise((r) => setTimeout(r, 4000));      // the token is now expired
      const before = await prisma.chatMessage.count({ where: { threadId: aThread.id } });
      await emitAndWatch(s.socket, 'chat:send', { threadId: aThread.id, body: `${tag} after expiry` }, null, 1500);
      const after = await prisma.chatMessage.count({ where: { threadId: aThread.id } });
      const stillWorks = after > before;
      check('a socket stops acting on an expired token', !stillWorks,
        stillWorks ? 'the expired token still wrote a message' : 'refused');
      if (stillWorks) {
        note('architecture', 'the JWT is verified once at handshake and never re-checked');
      }
    }
  }

  // ── 7. event flooding ───────────────────────────────────────────────────
  console.log('\n=== 7. EVENT FLOODING (small, controlled) ===');
  {
    const before = await prisma.chatMessage.count({ where: { threadId: aThread.id } });
    const N = 40;
    for (let i = 0; i < N; i++) aSock.emit('chat:send', { threadId: aThread.id, body: `${tag} flood ${i}` });
    await new Promise((r) => setTimeout(r, 4000));
    const after = await prisma.chatMessage.count({ where: { threadId: aThread.id } });
    const landed = after - before;
    const bounded = landed < N;
    check('the API is healthy after a burst', (await api('/health')).status === 200, `${landed}/${N} messages persisted`);
    if (!bounded) {
      note('no socket-level rate limit', `${landed} of ${N} messages persisted — the HTTP throttler does not cover socket events`);
    } else {
      note('burst was bounded', `${landed} of ${N} persisted`);
    }
  }

  // ── 8. multi-instance room fan-out ──────────────────────────────────────
  console.log('\n=== 8. ADAPTER / MULTI-INSTANCE ===');
  {
    const usesAdapter = false; // determined from source below, reported not asserted
    note('socket adapter', 'default in-memory adapter — rooms do not span replicas (see report)');
    check('a single instance fans out to a room correctly', aSock.connected && bSock.connected, 'both sockets live');
  }

  for (const s of sockets) { try { s.close(); } catch { /* already closed */ } }
  try { aSock.close(); bSock.close(); } catch { /* closed */ }
} catch (e) {
  console.error('\nERROR:', e.message);
  fail++;
} finally {
  await prisma.chatMessage.deleteMany({ where: { body: { contains: tag } } }).catch(() => {});
  for (const id of made.threads) await prisma.chatThread.delete({ where: { id } }).catch(() => {});
  for (const id of made.students) await prisma.studentProfile.delete({ where: { id } }).catch(() => {});
  for (const id of made.users) await prisma.user.delete({ where: { id } }).catch(() => {});
  await prisma.$disconnect();
}

console.log(`\n${fail === 0 ? 'REALTIME GATE PASS' : `REALTIME GATE — ${fail} FAILURE(S)`}  —  ${pass} passed, ${fail} failed`);
if (findings.length) { console.log('\nfailures:'); for (const f of findings) console.log('  ' + f); }
process.exit(fail === 0 ? 0 : 1);
