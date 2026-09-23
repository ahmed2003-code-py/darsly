/**
// Run from the repo root so @prisma/client resolves:  node scripts/probe-runtime.mjs
 * Runtime probes against the isolated staging API: authentication boundaries,
 * a cross-account authorization spot-check, and a latency baseline.
 *
 * Read-only apart from logging in. Nothing here writes money.
 */
const API = process.env.API_URL ?? 'http://127.0.0.1:3077/api/v1';
const PASS = 'Darsly@123';
let pass = 0,
  fail = 0;

const check = (name, ok, detail = '') => {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  ok ? pass++ : fail++;
};

async function req(path, { token, method = 'GET', body, headers = {} } = {}) {
  const t0 = performance.now();
  const r = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const ms = performance.now() - t0;
  let json = null;
  try {
    json = await r.json();
  } catch {
    /* empty body */
  }
  return { status: r.status, body: json, ms };
}

async function login(email) {
  const r = await req('/auth/login', { method: 'POST', body: { email, password: PASS } });
  if (r.status >= 300)
    throw new Error(`login ${email} failed: ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  return r.body.accessToken;
}

const { PrismaClient } = await import('@prisma/client');
const prisma = new PrismaClient();

// ── pick two real students from the seed, and a teacher ────────────────────
const students = await prisma.studentProfile.findMany({
  take: 2,
  include: { user: { select: { email: true } } },
  where: { user: { isActive: true } },
});
const teacher = await prisma.teacherProfile.findFirst({
  where: { status: 'APPROVED' },
  include: { user: { select: { email: true } } },
});
if (students.length < 2 || !teacher)
  throw new Error('seed did not provide two students and a teacher');

const [A, B] = students;
const tokenA = await login(A.user.email);
const tokenB = await login(B.user.email);
const tokenT = await login(teacher.user.email);

console.log('\n=== AUTHENTICATION BOUNDARIES ===');
{
  const anon = await req('/auth/me');
  check('no token is refused', anon.status === 401, `got ${anon.status}`);

  const malformed = await req('/auth/me', { token: 'not-a-jwt' });
  check('malformed JWT is refused', malformed.status === 401, `got ${malformed.status}`);

  // A structurally valid token signed with the wrong key.
  const jwt = await import('jsonwebtoken');
  const forged = jwt.default.sign(
    { sub: A.userId, role: 'SUPER_ADMIN' },
    'attacker-chosen-secret-aaaaaaaaaaaaaaa',
    { expiresIn: '1h' },
  );
  const wrongSig = await req('/auth/me', { token: forged });
  check(
    'token signed with the wrong secret is refused',
    wrongSig.status === 401,
    `got ${wrongSig.status}`,
  );

  // alg:none — the classic algorithm-confusion attempt.
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: A.userId,
      role: 'SUPER_ADMIN',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString('base64url');
  const none = await req('/auth/me', { token: `${header}.${payload}.` });
  check('alg:none token is refused', none.status === 401, `got ${none.status}`);

  const expired = jwt.default.sign(
    { sub: A.userId, role: 'STUDENT' },
    process.env.JWT_ACCESS_SECRET ?? 'x',
    { expiresIn: '-1s' },
  );
  const exp = await req('/auth/me', { token: expired });
  check('expired token is refused', exp.status === 401, `got ${exp.status}`);

  const valid = await req('/auth/me', { token: tokenA });
  check('a valid token is accepted', valid.status === 200, `got ${valid.status}`);
}

console.log('\n=== USER ENUMERATION ===');
{
  const unknown = await req('/auth/login', {
    method: 'POST',
    body: { email: 'nobody-here@test.invalid', password: 'whatever' },
  });
  const known = await req('/auth/login', {
    method: 'POST',
    body: { email: A.user.email, password: 'definitely-wrong' },
  });
  check(
    'unknown and known emails fail alike',
    unknown.status === known.status &&
      JSON.stringify(unknown.body?.message) === JSON.stringify(known.body?.message),
    `${unknown.status} vs ${known.status}`,
  );
}

console.log('\n=== AUTHORIZATION / PRIVILEGE ===');
{
  const asStudent = await req('/admin/payment-events', { token: tokenA });
  check(
    'student cannot reach an admin route',
    asStudent.status === 403 || asStudent.status === 401,
    `got ${asStudent.status}`,
  );

  const asTeacher = await req('/admin/payment-events', { token: tokenT });
  check(
    'teacher cannot reach an admin route',
    asTeacher.status === 403 || asTeacher.status === 401,
    `got ${asTeacher.status}`,
  );

  const anonAdmin = await req('/admin/payment-events');
  check(
    'anonymous cannot reach an admin route',
    anonAdmin.status === 401,
    `got ${anonAdmin.status}`,
  );

  const ingest = await req('/payment-events', {
    method: 'POST',
    body: { provider: 'VODAFONE_CASH', amountCents: 999999 },
    headers: { 'x-listener-key': 'wrong-key-entirely' },
  });
  check(
    'transfer ingestion refuses a wrong listener key',
    ingest.status === 401,
    `got ${ingest.status}`,
  );
}

console.log('\n=== CROSS-ACCOUNT (IDOR spot-check) ===');
{
  // B's payment, fetched with A's token.
  const bPayment = await prisma.payment.findFirst({ where: { studentId: B.id } });
  if (bPayment) {
    const cross = await req(`/payments/${bPayment.id}`, { token: tokenA });
    check(
      "student A cannot read student B's payment",
      cross.status === 403 || cross.status === 404,
      `got ${cross.status}`,
    );
  } else {
    console.log('   SKIP  no seeded payment for student B');
  }

  const bEnrolment = await prisma.enrollment.findFirst({ where: { studentId: B.id } });
  if (bEnrolment) {
    const cross = await req(`/enrollments/${bEnrolment.id}/hide`, {
      method: 'POST',
      token: tokenA,
    });
    check(
      "student A cannot act on student B's enrolment",
      cross.status === 403 || cross.status === 404,
      `got ${cross.status}`,
    );
  }
}

console.log('\n=== MALFORMED INPUT (no 5xx allowed) ===');
{
  const cases = [
    ['missing body', '/auth/login', {}],
    ['wrong types', '/auth/login', { email: 12345, password: ['a'] }],
    ['null fields', '/auth/login', { email: null, password: null }],
    ['unexpected field', '/auth/login', { email: A.user.email, password: PASS, isAdmin: true }],
    [
      'huge string',
      '/auth/login',
      { email: 'x'.repeat(20000) + '@t.io', password: 'y'.repeat(20000) },
    ],
    ['negative number', '/enrollments/quote', { courseId: 'nope', amountCents: -999999 }],
  ];
  for (const [name, path, body] of cases) {
    const r = await req(path, { method: 'POST', body, token: tokenA });
    check(`${name} -> no 5xx`, r.status < 500, `got ${r.status}`);
  }
  const badJson = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"email":',
  });
  check('malformed JSON -> no 5xx', badJson.status < 500, `got ${badJson.status}`);
}

console.log('\n=== LATENCY BASELINE (30 samples each, warm) ===');
{
  const endpoints = [
    ['GET  /health', '/health', {}],
    [
      'POST /auth/login',
      '/auth/login',
      { method: 'POST', body: { email: A.user.email, password: PASS } },
    ],
    ['GET  /courses (discovery)', '/courses?page=1&pageSize=20', { token: tokenA }],
    ['GET  /teachers (discovery)', '/teachers?page=1&pageSize=20', { token: tokenA }],
    ['GET  /students/me', '/auth/me', { token: tokenA }],
    ['GET  /enrollments/mine', '/enrollments/mine', { token: tokenA }],
  ];
  console.log('   endpoint                      n    p50      p95      p99      max     status');
  for (const [label, path, opts] of endpoints) {
    const times = [];
    let status = 0;
    for (let i = 0; i < 30; i++) {
      const r = await req(path, opts);
      times.push(r.ms);
      status = r.status;
    }
    times.sort((a, b) => a - b);
    const at = (p) => times[Math.min(times.length - 1, Math.floor(times.length * p))].toFixed(1);
    console.log(
      `   ${label.padEnd(28)} ${String(times.length).padStart(3)}  ${at(0.5).padStart(6)}ms ${at(0.95).padStart(6)}ms ${at(0.99).padStart(6)}ms ${times[times.length - 1].toFixed(1).padStart(6)}ms  ${status}`,
    );
  }
}

await prisma.$disconnect();
console.log(
  `\n${fail === 0 ? 'ALL PROBES PASSED' : `${fail} PROBE(S) FAILED`}  —  ${pass} passed, ${fail} failed`,
);
process.exit(fail === 0 ? 0 : 1);
