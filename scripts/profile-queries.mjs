#!/usr/bin/env node
/**
 * How many SQL statements does one request cost?
 *
 * Run the API with PRISMA_QUERY_LOG=true writing to a file, point this at that
 * file, and it makes one request per endpoint and counts the statements that
 * appeared while it was in flight.
 *
 *   node scripts/profile-queries.mjs
 *
 *   API_URL   base URL of the running API
 *   SQL_LOG   path the API's stdout is being written to
 *
 * The number to care about is not the total, it is whether the total grows with
 * the size of the result. A list endpoint that costs a constant handful of
 * statements is fine at any page size; one that costs a statement per row is an
 * N+1, and the only way to tell them apart is to ask for more rows and look
 * again — which is why every list here is measured at two page sizes.
 */
import { readFileSync } from 'fs';

const API = process.env.API_URL ?? 'http://127.0.0.1:3077/api/v1';
const LOG = process.env.SQL_LOG;
if (!LOG) { console.error('SQL_LOG is not set — point it at the API stdout file.'); process.exit(2); }

const lines = () => {
  try { return readFileSync(LOG, 'utf8').split('\n').filter((l) => l.startsWith('[sql')).length; }
  catch { return 0; }
};

/** Let the statements from a request finish landing in the log before counting. */
const settle = () => new Promise((r) => setTimeout(r, 900));

async function login(email, password = 'Darsly@123') {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`login ${email}: ${r.status}`);
  return (await r.json()).accessToken;
}

async function measure(label, path, token) {
  await settle();
  const before = lines();
  const t0 = performance.now();
  const r = await fetch(`${API}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const ms = performance.now() - t0;
  const body = await r.json().catch(() => null);
  await settle();
  const queries = lines() - before;
  const rows = Array.isArray(body) ? body.length
    : Array.isArray(body?.items) ? body.items.length
    : Array.isArray(body?.data) ? body.data.length
    : null;
  return { label, status: r.status, ms, queries, rows };
}

const { PrismaClient } = await import('@prisma/client');
const prisma = new PrismaClient();
const student = await prisma.studentProfile.findFirst({
  where: { user: { isActive: true } }, include: { user: { select: { email: true } } },
});
const teacher = await prisma.teacherProfile.findFirst({
  where: { status: 'APPROVED' }, include: { user: { select: { email: true } } },
});
const admin = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', isActive: true } });
await prisma.$disconnect();

const sTok = await login(student.user.email);
const tTok = await login(teacher.user.email);
const aTok = admin ? await login(admin.email).catch(() => null) : null;

// Each list is measured small and large. A cost that tracks the row count is
// the N+1; a cost that stays flat is not.
const plan = [
  ['course discovery (10)', '/courses?page=1&pageSize=10', sTok],
  ['course discovery (50)', '/courses?page=1&pageSize=50', sTok],
  ['teacher discovery (10)', '/teachers?page=1&pageSize=10', sTok],
  ['teacher discovery (50)', '/teachers?page=1&pageSize=50', sTok],
  ['student shelf', '/enrollments/mine', sTok],
  ['my profile', '/auth/me', sTok],
  ['teacher courses', '/teacher/courses', tTok],
  ['teacher students', '/teacher/enrollments', tTok],
  ['teacher analytics', '/teacher/analytics', tTok],
  ['teacher engagement', '/teacher/gamification/analytics', tTok],
  ['notifications', '/notifications', sTok],
  ['my certificates', '/certificates/mine', sTok],
];
if (aTok) plan.push(['admin payment events', '/admin/payment-events', aTok]);

console.log('SQL statements per request — the growth matters more than the total\n');
console.log('  endpoint                      status  queries   rows    ms');
const results = [];
for (const [label, path, token] of plan) {
  const r = await measure(label, path, token);
  results.push(r);
  console.log(
    `  ${label.padEnd(28)} ${String(r.status).padStart(5)}  ${String(r.queries).padStart(7)}  ${String(r.rows ?? '-').padStart(5)}  ${r.ms.toFixed(1).padStart(6)}`,
  );
}

console.log('\nN+1 check — does the statement count follow the row count?');
for (const [small, large] of [['course discovery (10)', 'course discovery (50)'], ['teacher discovery (10)', 'teacher discovery (50)']]) {
  const a = results.find((r) => r.label === small);
  const b = results.find((r) => r.label === large);
  if (!a || !b) continue;
  const grew = b.queries - a.queries;
  const verdict = grew <= 1 ? 'FLAT — no N+1'
    : grew >= (b.rows ?? 0) - (a.rows ?? 0) ? 'N+1 — one statement per row'
    : `grows by ${grew} for ${(b.rows ?? 0) - (a.rows ?? 0)} more rows — partial`;
  console.log(`  ${small.replace(' (10)', '').padEnd(26)} ${a.queries} -> ${b.queries} queries for ${a.rows} -> ${b.rows} rows   ${verdict}`);
}
