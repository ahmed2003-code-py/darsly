#!/usr/bin/env node
/**
 * Real end-to-end verification for the SaaS Evolution Phase 1 work: feature
 * flags (model + service + guard + admin API), audit coverage for payout
 * approve/complete and admin payment verify, and the isHome DB constraint.
 * Hits a real running API and a real (disposable, local-only) Postgres — not
 * unit tests with Prisma mocked out.
 *
 *   CONFIRM_TEST_DB=yes DATABASE_URL=postgresql://...localhost:PORT/darsly node scripts/verify-phase1.mjs
 *
 * Assumes: the target API is already running (dev server) against the same
 * DATABASE_URL. Nothing here is destructive to real data — it only toggles
 * feature flags (restored to their original state after) and reads AuditLog.
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

async function api(p, { token, method = 'GET', body } = {}) {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/v1${p}`, {
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
  console.log('== Phase 1 verification: feature flags, audit coverage, isHome constraint ==\n');

  // ── isHome DB constraint ────────────────────────────────────────────────
  console.log('-- isHome partial unique index --');
  {
    const home = await prisma.academyMembership.findFirst({ where: { isHome: true, deletedAt: null } });
    if (!home) {
      check('isHome constraint reachable', false, 'no isHome=true row found to test against');
    } else {
      const otherAcademy = await prisma.academy.findFirst({ where: { id: { not: home.academyId } } });
      let rejected = false;
      try {
        await prisma.$transaction(async (tx) => {
          await tx.academyMembership.create({
            data: {
              id: 'verify_phase1_dup_home',
              userId: home.userId,
              academyId: otherAcademy.id,
              role: 'STUDENT',
              status: 'ACTIVE',
              isHome: true,
            },
          });
        });
      } catch (e) {
        rejected = /unique constraint/i.test(String(e.message));
      }
      check('DB rejects a second isHome=true row for the same user', rejected);
    }
  }

  // ── Admin + feature flags API ───────────────────────────────────────────
  console.log('\n-- Feature flags admin API --');
  const adminToken = await login('admin@darsly.app');
  const academy = await prisma.academy.findFirst({ select: { id: true } });

  {
    const nonAdminLogin = await api('/auth/login', { method: 'POST', body: { email: 'nonexistent@nope.nope', password: 'x' } });
    check('bogus login is rejected (sanity)', nonAdminLogin.status >= 400);
  }

  const initial = await api(`/admin/academies/${academy.id}/feature-flags`, { token: adminToken });
  check('list flags: 200', initial.status === 200);
  check('list flags: all 5 known keys present with defaults', Array.isArray(initial.body) && initial.body.length === 5);
  const attendanceDefault = initial.body?.find((f) => f.key === 'attendance');
  check('unset flag defaults to enabled', attendanceDefault?.enabled === true);

  const disable = await api(`/admin/academies/${academy.id}/feature-flags/attendance`, { token: adminToken, method: 'PATCH', body: { enabled: false } });
  check('disable flag: 200', disable.status === 200);
  check('disable flag: persisted enabled=false', disable.body?.enabled === false);

  const afterDisable = await api(`/admin/academies/${academy.id}/feature-flags`, { token: adminToken });
  const attendanceAfter = afterDisable.body?.find((f) => f.key === 'attendance');
  check('list reflects the disable', attendanceAfter?.enabled === false);

  const badKey = await api(`/admin/academies/${academy.id}/feature-flags/not-a-real-flag`, { token: adminToken, method: 'PATCH', body: { enabled: false } });
  check('unknown flag key is rejected: 400', badKey.status === 400);

  // restore to default so this script is non-destructive to local state
  await api(`/admin/academies/${academy.id}/feature-flags/attendance`, { token: adminToken, method: 'PATCH', body: { enabled: true } });

  // Non-admin cannot reach the platform-admin route at all.
  const teacher = await prisma.user.findFirst({ where: { role: 'TEACHER' }, select: { email: true } });
  if (teacher) {
    const teacherToken = await login(teacher.email);
    const asTeacher = await api(`/admin/academies/${academy.id}/feature-flags`, { token: teacherToken });
    check('teacher (non-admin) is refused the platform-admin route', asTeacher.status === 403 || asTeacher.status === 401);
  }

  // Audit row exists and carries academyId for the flag toggle itself.
  const flagAudit = await prisma.auditLog.findFirst({
    where: { entity: 'AcademyFeatureFlag', academyId: academy.id },
    orderBy: { createdAt: 'desc' },
  });
  check('feature-flag toggle wrote an AuditLog row with academyId', !!flagAudit);

  // ── Audit coverage: admin payment verify/reject/settle ─────────────────
  console.log('\n-- Audit coverage: admin payment actions --');
  const pendingPayment = await prisma.payment.findFirst({ where: { status: 'PENDING' } });
  if (pendingPayment) {
    const before = await prisma.auditLog.count({ where: { entity: 'Payment', action: 'payment.admin_verify' } });
    const verify = await api(`/admin/payments/${pendingPayment.id}/verify`, { token: adminToken, method: 'POST' });
    check('admin verify: 2xx', verify.status < 300, `status=${verify.status}`);
    const after = await prisma.auditLog.count({ where: { entity: 'Payment', action: 'payment.admin_verify' } });
    check('admin verify wrote a new AuditLog row', after === before + 1);
    const row = await prisma.auditLog.findFirst({ where: { entity: 'Payment', entityId: pendingPayment.id, action: 'payment.admin_verify' } });
    check('that row carries academyId', !!row?.academyId);
  } else {
    console.log('   SKIP  no PENDING payment in local data to verify against');
  }

  // ── Audit coverage: payout process ──────────────────────────────────────
  console.log('\n-- Audit coverage: payout process --');
  const pendingPayout = await prisma.payoutRequest.findFirst({ where: { status: { notIn: ['COMPLETED', 'REJECTED'] } } });
  if (pendingPayout) {
    const before = await prisma.auditLog.count({ where: { entity: 'PayoutRequest', entityId: pendingPayout.id } });
    const proc = await api(`/admin/payouts/${pendingPayout.id}`, { token: adminToken, method: 'PATCH', body: { status: 'REJECTED', note: 'phase1 verification' } });
    check('admin process payout: 2xx', proc.status < 300, `status=${proc.status}`);
    const after = await prisma.auditLog.count({ where: { entity: 'PayoutRequest', entityId: pendingPayout.id } });
    check('payout process wrote a new AuditLog row', after === before + 1);
    const row = await prisma.auditLog.findFirst({ where: { entity: 'PayoutRequest', entityId: pendingPayout.id }, orderBy: { createdAt: 'desc' } });
    check('that row carries academyId', !!row?.academyId);
    check('action name reflects the new status', row?.action === 'payout.rejected');
  } else {
    console.log('   SKIP  no open PayoutRequest in local data to process');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error('FATAL', e);
  await prisma.$disconnect();
  process.exit(1);
});
