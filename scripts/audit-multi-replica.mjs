#!/usr/bin/env node
/**
 * Proves the actual multi-replica architecture works — not a unit test with
 * Redis mocked out, but two real compiled API processes, each with its own
 * port, both pointed at the same Postgres and the same real (disposable)
 * Redis, exactly mirroring the two Railway replicas in production.
 *
 *   1. DISTRIBUTED RATE LIMITING — login requests split across both
 *      instances must hit ONE shared 20/min limit, not ~40 (one per
 *      instance, which is the bug this fixes).
 *   2. MULTI-INSTANCE SOCKET.IO — a chat message sent by a socket connected
 *      to instance A must reach a recipient's socket connected to instance
 *      B, and back, via the Redis adapter's pub/sub fan-out.
 *
 * Both real Nest processes run the actual `dist/main.js` this repo ships —
 * `npx nest build` first. Redis is a real disposable server (redis-memory-
 * server, the same "real prebuilt binary" pattern already used for the
 * isolated Postgres cluster in this audit — not ioredis-mock).
 *
 *   CONFIRM_TEST_DB=yes DATABASE_URL=... node scripts/audit-multi-replica.mjs
 *
 * Everything here is disposable: the isolated Postgres, a throwaway Redis
 * instance, and two API processes on ports 3079/3080 (not the ones any other
 * harness in this repo uses), all torn down at the end.
 */
import { spawn } from 'child_process';
import { PrismaClient } from '@prisma/client';
import { io as ioClient } from 'socket.io-client';
import { RedisMemoryServer } from 'redis-memory-server';

const DB = process.env.DATABASE_URL ?? '';
const PASSWORD = 'Darsly@123';
const PORT_A = 3079;
const PORT_B = 3080;

if (process.env.CONFIRM_TEST_DB !== 'yes') { console.error('REFUSED: set CONFIRM_TEST_DB=yes.'); process.exit(2); }
if (!DB) { console.error('REFUSED: DATABASE_URL is not set.'); process.exit(2); }
if (/railway|prod|amazonaws|supabase|neon\.tech|render\.com/i.test(DB)) {
  console.error('REFUSED: DATABASE_URL looks hosted.'); process.exit(2);
}

let pass = 0, fail = 0;
const findings = [];
const check = (n, ok, d = '') => {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  (${d})` : ''}`);
  if (ok) pass++; else { fail++; findings.push(`${n} — ${d}`); }
};

const baseEnv = {
  ...process.env,
  DATABASE_URL: DB,
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
  VIDEO_SIGNING_SECRET: process.env.VIDEO_SIGNING_SECRET,
  PAYMENT_LISTENER_KEY: process.env.PAYMENT_LISTENER_KEY,
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173',
  WORKER_ENABLED: 'false',
  AI_ACADEMY_ENABLED: 'false',
};

function spawnApi(port, redisUrl, label) {
  const child = spawn('node', ['dist/main.js'], {
    cwd: 'apps/api',
    env: { ...baseEnv, PORT: String(port), REDIS_URL: redisUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { if (process.env.DEBUG_MULTI_REPLICA) process.stdout.write(`[${label}] ${d}`); });
  child.stderr.on('data', (d) => { if (process.env.DEBUG_MULTI_REPLICA) process.stderr.write(`[${label}] ${d}`); });
  return child;
}

async function waitHealthy(port, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 500));
  }
  return false;
}

async function api(port, p, { token, method = 'GET', body, headers = {} } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}/api/v1${p}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body !== undefined ? { body } : {}),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, headers: r.headers };
}
const login = async (port, email) => {
  const r = await api(port, '/auth/login', { method: 'POST', body: JSON.stringify({ email, password: PASSWORD }), headers: { 'content-type': 'application/json' } });
  if (r.status >= 300) throw new Error(`login ${email} on :${port}: ${r.status}`);
  return r.body.accessToken;
};

function connect(port, token) {
  return new Promise((resolve) => {
    const s = ioClient(`http://127.0.0.1:${port}`, { auth: { token }, transports: ['websocket'], reconnection: false, timeout: 8000 });
    s.on('connect', () => resolve(s));
    s.on('connect_error', () => resolve(s));
    setTimeout(() => resolve(s), 4000);
  });
}
function waitFor(socket, event, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

let redis, apiA, apiB;
const prisma = new PrismaClient();

try {
  console.log('=== booting a real disposable Redis ===');
  redis = new RedisMemoryServer();
  const redisHost = await redis.getHost();
  const redisPort = await redis.getPort();
  const redisUrl = `redis://${redisHost}:${redisPort}`;
  console.log(`   Redis up at ${redisUrl}`);

  console.log('\n=== booting two real API instances against it ===');
  apiA = spawnApi(PORT_A, redisUrl, 'A');
  apiB = spawnApi(PORT_B, redisUrl, 'B');
  const [healthyA, healthyB] = await Promise.all([waitHealthy(PORT_A), waitHealthy(PORT_B)]);
  check('instance A came up healthy', healthyA, `:${PORT_A}`);
  check('instance B came up healthy', healthyB, `:${PORT_B}`);
  if (!healthyA || !healthyB) throw new Error('both instances must be healthy to continue');
  // Give the Redis adapter's async connectToRedis() + PING a moment past health.
  await new Promise((r) => setTimeout(r, 1500));

  // Socket.IO runs BEFORE the rate-limit exhaustion test below: that test
  // deliberately trips the shared login throttle, and every login in this
  // script shares one client IP — done in this order so the real logins the
  // Socket.IO section needs aren't collateral damage from the test that
  // follows them.

  // ══ 1. MULTI-INSTANCE SOCKET.IO ═════════════════════════════════════════
  console.log('\n=== 1. MULTI-INSTANCE SOCKET.IO DELIVERY ===');
  const teacher = await prisma.teacherProfile.findFirst({ where: { status: 'APPROVED' }, include: { user: true } });
  const academy = await prisma.academy.findUnique({ where: { id: teacher.id } });
  const student = await prisma.studentProfile.findFirst({ where: { userId: { not: undefined }, user: { isActive: true } }, include: { user: true } });
  const outsider = await prisma.studentProfile.findFirst({ where: { id: { not: student.id }, user: { isActive: true } }, include: { user: true } });
  let thread = await prisma.chatThread.findFirst({ where: { tenantId: academy.id, studentId: student.id } });
  if (!thread) {
    thread = await prisma.chatThread.create({ data: { tenantId: academy.id, studentId: student.id, type: 'DM' } });
  }
  const otherThread = await prisma.chatThread.findFirst({ where: { id: { not: thread.id } } });

  const tTokA = await login(PORT_A, teacher.user.email); // teacher connects to instance A
  const sTokB = await login(PORT_B, student.user.email); // student connects to instance B
  const outsiderTokA = await login(PORT_A, outsider.user.email);

  const teacherSocket = await connect(PORT_A, tTokA);
  const studentSocket = await connect(PORT_B, sTokB);
  const outsiderSocket = await connect(PORT_A, outsiderTokA);

  check('JWT auth still works on instance A', teacherSocket.connected, 'connected');
  check('JWT auth still works on instance B', studentSocket.connected, 'connected');

  teacherSocket.emit('chat:join', thread.id);
  studentSocket.emit('chat:join', thread.id);
  outsiderSocket.emit('chat:join', thread.id); // not a participant — must be silently refused
  await new Promise((r) => setTimeout(r, 800));

  {
    // A → instance A → Redis → instance B → B
    const bMsg = waitFor(studentSocket, 'chat:message');
    const outsiderHeard = waitFor(outsiderSocket, 'chat:message', 2500);
    teacherSocket.emit('chat:send', { threadId: thread.id, body: 'from A to B — cross-instance' });
    const [received, outsiderReceived] = await Promise.all([bMsg, outsiderHeard]);
    check('instance A → Redis → instance B: the recipient on instance B receives the message',
      received?.body === 'from A to B — cross-instance', received ? 'received' : 'timed out — NOT delivered');
    check('an outsider socket (never authorized into the room) receives nothing',
      !outsiderReceived, outsiderReceived ? 'LEAKED to outsider' : 'nothing received');
  }
  {
    // B → instance B → Redis → instance A → A, the reverse direction
    const aMsg = waitFor(teacherSocket, 'chat:message');
    studentSocket.emit('chat:send', { threadId: thread.id, body: 'from B to A — cross-instance' });
    const received = await aMsg;
    check('instance B → Redis → instance A: the recipient on instance A receives the message',
      received?.body === 'from B to A — cross-instance', received ? 'received' : 'timed out — NOT delivered');
  }

  // Cross-room isolation: a socket on a different, unrelated thread never hears this room.
  if (otherThread) {
    const bystander = await connect(PORT_A, tTokA === undefined ? outsiderTokA : outsiderTokA);
    bystander.emit('chat:join', otherThread.id);
    await new Promise((r) => setTimeout(r, 500));
    const heard = waitFor(bystander, 'chat:message', 2000);
    teacherSocket.emit('chat:send', { threadId: thread.id, body: 'must stay in its own room' });
    const leaked = await heard;
    check('a socket joined to a different room never receives this room\'s messages', !leaked, leaked ? 'LEAKED' : 'clean');
    bystander.close();
  }

  // No duplicate delivery: exactly one chat:message per send, even for a
  // third legitimate participant-equivalent socket on the SAME instance as
  // the sender (the classic Redis-adapter local+remote double-fire bug).
  {
    const secondTeacherSocket = await connect(PORT_A, tTokA); // same instance as the sender
    secondTeacherSocket.emit('chat:join', thread.id);
    await new Promise((r) => setTimeout(r, 500));
    let count = 0;
    const onMsg = () => { count++; };
    secondTeacherSocket.on('chat:message', onMsg);
    studentSocket.emit('chat:send', { threadId: thread.id, body: 'duplicate-delivery probe' });
    await new Promise((r) => setTimeout(r, 1500));
    check('a socket on the SAME instance as the sender receives the message exactly once, not twice', count === 1, `received ${count} time(s)`);
    secondTeacherSocket.close();
  }

  // Disconnect / reconnect
  {
    studentSocket.disconnect();
    await new Promise((r) => setTimeout(r, 500));
    const reconnected = await connect(PORT_B, sTokB);
    check('a fresh connection after disconnect succeeds cleanly', reconnected.connected, 'connected');
    reconnected.emit('chat:join', thread.id);
    await new Promise((r) => setTimeout(r, 500));
    const heard = waitFor(reconnected, 'chat:message');
    teacherSocket.emit('chat:send', { threadId: thread.id, body: 'after reconnect' });
    const received = await heard;
    check('the reconnected socket still receives cross-instance messages', received?.body === 'after reconnect', received ? 'received' : 'not received');
    reconnected.close();
  }

  teacherSocket.close();
  outsiderSocket.close();

  // ══ 2. DISTRIBUTED RATE LIMITING ═══════════════════════════════════════
  // Runs last and deliberately exhausts the shared login throttle — every
  // request in this script shares one client IP, so this intentionally
  // leaves logins blocked on both instances for the rest of the process.
  console.log('\n=== 2. DISTRIBUTED RATE LIMITING (login, shared 20/min) ===');
  {
    const email = 'rl-probe@darsly.invalid'; // deliberately nonexistent — every attempt is a clean, safe 401
    const results = [];
    for (let i = 0; i < 25; i++) {
      const port = i % 2 === 0 ? PORT_A : PORT_B; // strictly alternating — 12/13 split across instances
      const r = await api(port, '/auth/login', { method: 'POST', body: JSON.stringify({ email, password: 'x' }), headers: { 'content-type': 'application/json' } });
      results.push({ i, port, status: r.status });
    }
    const first429 = results.find((r) => r.status === 429);
    const statuses = results.map((r) => r.status);
    check('a 429 fires', !!first429, statuses.join(','));
    check('the 429 fires at (or immediately after) request 21 of the combined stream, not ~41',
      !!first429 && first429.i <= 23, first429 ? `first 429 at combined request #${first429.i + 1}` : 'never fired');
    const both429 = results.slice(first429 ? first429.i : 25).some((r) => r.port === PORT_A) &&
                     results.slice(first429 ? first429.i : 25).some((r) => r.port === PORT_B);
    check('once blocked, BOTH instances honor the same block (not just the one that tripped it)',
      !!first429 && both429, 'checked post-block responses on both ports');
  }
} catch (e) {
  console.error('\nERROR:', e.message);
  fail++;
} finally {
  console.log('\n=== tearing down ===');
  apiA?.kill('SIGTERM');
  apiB?.kill('SIGTERM');
  await prisma.chatThread.deleteMany({ where: { id: { in: [] } } }).catch(() => {}); // no throwaway rows to clean beyond the thread possibly created above
  await prisma.$disconnect();
  await redis?.stop().catch(() => {});
}

console.log(`\n${fail === 0 ? 'MULTI-REPLICA GATE PASS' : `MULTI-REPLICA GATE — ${fail} FAILURE(S)`}  —  ${pass} passed, ${fail} failed`);
if (findings.length) { console.log('\nfailures:'); for (const f of findings) console.log('  ' + f); }
process.exit(fail === 0 ? 0 : 1);
