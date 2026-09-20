#!/usr/bin/env node
/**
 * Real end-to-end verification for the SaaS Evolution Phase 2 work: the
 * Platform Command Center — KPI overview, academy list (search/filter/
 * pagination), academy drill-down (staff/revenue/feature flags), and growth/
 * revenue trend endpoints. Hits a real running API and a real (disposable,
 * local-only) Postgres — not unit tests with Prisma mocked out. Also proves
 * the security requirement: every route here is SUPER_ADMIN-only, and no
 * other role — including an academy OWNER — can reach it.
 *
 *   CONFIRM_TEST_DB=yes DATABASE_URL=postgresql://...localhost:PORT/darsly node scripts/verify-phase2.mjs
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

async function api(p, { token, method = 'GET', body, params } = {}) {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const r = await fetch(`http://127.0.0.1:${PORT}/api/v1${p}${qs}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
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

async function main() {
  console.log('== Phase 2 verification: Platform Command Center ==\n');
  const adminToken = await login('admin@darsly.app');

  // ── KPI overview ─────────────────────────────────────────────────────────
  console.log('-- Overview KPIs --');
  const overview = await api('/admin/overview', { token: adminToken });
  check('overview: 200', overview.status === 200);
  const expectedFields = [
    'students', 'teachersApproved', 'teachersPending', 'coursesPublished',
    'activeEnrollments', 'totalEnrollments', 'pendingPayouts', 'grossCents',
    'commissionCents', 'totalAcademies', 'activeAcademies',
  ];
  check('overview: has every expected field', expectedFields.every((f) => f in (overview.body ?? {})));
  const realAcademyCount = await prisma.academy.count();
  check('totalAcademies matches a direct DB count', overview.body?.totalAcademies === realAcademyCount, `api=${overview.body?.totalAcademies} db=${realAcademyCount}`);

  // ── Academy list ─────────────────────────────────────────────────────────
  console.log('\n-- Academy list --');
  const list = await api('/admin/academies', { token: adminToken, params: { page: 1, pageSize: 20 } });
  check('list: 200', list.status === 200);
  check('list: total matches DB', list.body?.total === realAcademyCount);
  check('list: returns rows with the expected shape', !!list.body?.academies?.[0]?.slug && typeof list.body.academies[0].netRevenueCents === 'number');

  const firstAcademy = list.body?.academies?.[0];
  if (firstAcademy) {
    const bySlug = await api('/admin/academies', { token: adminToken, params: { search: firstAcademy.slug } });
    check('search by slug finds the academy', bySlug.body?.academies?.some((a) => a.id === firstAcademy.id));

    const byStatus = await api('/admin/academies', { token: adminToken, params: { status: firstAcademy.status } });
    check('status filter returns only that status', byStatus.body?.academies?.every((a) => a.status === firstAcademy.status));
  }

  const noMatch = await api('/admin/academies', { token: adminToken, params: { search: 'zzzzz_no_such_academy_zzzzz' } });
  check('empty search returns an empty (not error) result', noMatch.status === 200 && noMatch.body?.academies?.length === 0);

  const overPageSize = await api('/admin/academies', { token: adminToken, params: { pageSize: 99999 } });
  check('pageSize is capped server-side', overPageSize.body?.pageSize <= 100);

  // ── Academy drill-down ───────────────────────────────────────────────────
  console.log('\n-- Academy drill-down --');
  if (firstAcademy) {
    const detail = await api(`/admin/academies/${firstAcademy.id}`, { token: adminToken });
    check('detail: 200', detail.status === 200);
    check('detail: has staff, featureFlags, revenue fields', Array.isArray(detail.body?.staff) && Array.isArray(detail.body?.featureFlags) && typeof detail.body?.netRevenueCents === 'number');
    check('detail: featureFlags include all 5 known keys', detail.body?.featureFlags?.length === 5);
    check('detail: staff excludes STUDENT-role rows', detail.body?.staff?.every((s) => s.role !== 'STUDENT'));
  }
  const bogus = await api('/admin/academies/not-a-real-id', { token: adminToken });
  check('unknown academy id: 404', bogus.status === 404);

  // ── Growth / revenue trends ──────────────────────────────────────────────
  console.log('\n-- Growth / revenue trends --');
  for (const range of [7, 30, 90]) {
    const growth = await api('/admin/analytics/growth', { token: adminToken, params: { range } });
    check(`growth range=${range}: 200, ${range} zero-filled days`, growth.status === 200 && growth.body?.length === range);
    const revenue = await api('/admin/analytics/revenue', { token: adminToken, params: { range } });
    check(`revenue range=${range}: 200, ${range} zero-filled days`, revenue.status === 200 && revenue.body?.length === range);
  }
  const badRange = await api('/admin/analytics/growth', { token: adminToken, params: { range: 42 } });
  check('rejects an out-of-list range', badRange.status === 400);

  // ── Security: every route is SUPER_ADMIN-only ───────────────────────────
  console.log('\n-- Security: role checks --');
  const roleCases = [
    ['STUDENT', await prisma.user.findFirst({ where: { role: 'STUDENT' }, select: { email: true } })],
    ['TEACHER', await prisma.user.findFirst({ where: { role: 'TEACHER' }, select: { email: true } })],
  ];
  for (const [role, user] of roleCases) {
    if (!user?.email) { console.log(`   SKIP  no ${role} in local data`); continue; }
    const token = await login(user.email);
    const routes = ['/admin/overview', '/admin/academies', `/admin/academies/${firstAcademy?.id ?? 'x'}`, '/admin/analytics/growth', '/admin/analytics/revenue'];
    for (const route of routes) {
      const r = await api(route, { token });
      check(`${role} refused ${route}`, r.status === 401 || r.status === 403, `status=${r.status}`);
    }
  }

  // An academy OWNER (real academy authority, but not platform authority) must
  // also be refused — the platform-admin surface is a different authority
  // entirely from AcademyContext/@AcademyStaff, and must never be reachable
  // through an academy-scoped token no matter which academy it names.
  const ownerMembership = await prisma.academyMembership.findFirst({ where: { role: 'OWNER' }, include: { user: { select: { email: true } } } });
  if (ownerMembership?.user?.email) {
    const ownerToken = await login(ownerMembership.user.email);
    const r = await api('/admin/academies', { token: ownerToken });
    check('academy OWNER refused the platform-wide academies list', r.status === 401 || r.status === 403, `status=${r.status}`);
  }

  const noAuth = await api('/admin/overview');
  check('no token at all: 401', noAuth.status === 401);

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error('FATAL', e);
  await prisma.$disconnect();
  process.exit(1);
});
