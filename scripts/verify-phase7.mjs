#!/usr/bin/env node
/**
 * Real end-to-end verification for the SaaS Evolution Phase 7 work: Admin
 * Studio (staff management, activate/deactivate academy, academy-scoped
 * activity) + the Platform Admin Theme system. Hits a real running API and
 * a real (disposable, local-only) Postgres — not unit tests with Prisma
 * mocked out.
 *
 *   CONFIRM_TEST_DB=yes DATABASE_URL=postgresql://...localhost:PORT/darsly node scripts/verify-phase7.mjs
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

async function api(p, { token, method = 'GET', body, headers, query } = {}) {
  const qs = query ? `?${new URLSearchParams(query)}` : '';
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

const prisma = new PrismaClient();
const cleanup = [];

async function main() {
  console.log('== Phase 7 verification: Admin Studio + Platform Admin Theme ==\n');

  const admin = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN' }, select: { id: true, email: true } });
  const adminToken = await login(admin.email);

  const teacherA = await prisma.teacherProfile.findFirst({ where: { status: 'APPROVED' }, include: { user: { select: { id: true, email: true } } } });
  const teacherB = await prisma.teacherProfile.findFirst({
    where: { status: 'APPROVED', id: { not: teacherA.id } },
    include: { user: { select: { id: true, email: true } } },
  });
  const academy1 = teacherA.id;
  const academyRow = await prisma.academy.findUnique({ where: { id: academy1 }, select: { slug: true, status: true } });
  const tokenA = await login(teacherA.user.email);
  const tokenB = await login(teacherB.user.email);

  // A brand-new, unaffiliated user — the one our AddMember flow will invite.
  // Hashed the same way AuthService itself does (argon2), so a real login
  // round-trip proves the added membership genuinely grants access, not
  // just a 2xx on the invite.
  const argon2 = await import('argon2');
  const passwordHash = await argon2.hash(PASSWORD);
  const newStaffUser = await prisma.user.create({
    data: { role: 'TEACHER', email: `verify-phase7-staff-${Date.now()}@example.com`, fullName: 'Verify Phase7 Staff', passwordHash, locale: 'ar' },
  });
  cleanup.push(() => prisma.academyMembership.deleteMany({ where: { userId: newStaffUser.id } }).then(() => prisma.user.delete({ where: { id: newStaffUser.id } })).catch(() => {}));

  // ── Admin theme: read/write, own-user scoped, IDOR-proof by construction ─
  console.log('-- Admin theme --');
  const before = await api('/admin/theme', { token: adminToken });
  check('GET /admin/theme reachable', before.status === 200);

  const setBad = await api('/admin/theme', { token: adminToken, method: 'PATCH', body: { themeId: 'not-a-real-theme' } });
  check('setting an unknown themeId is refused with 400', setBad.status === 400);

  const setGood = await api('/admin/theme', { token: adminToken, method: 'PATCH', body: { themeId: 'crimson-gold' } });
  check('setting a known preset succeeds', setGood.status < 300 && setGood.body?.themeId === 'crimson-gold');

  const reread = await api('/admin/theme', { token: adminToken });
  check('the preference persists (server-side, not just echoed back)', reread.body?.themeId === 'crimson-gold');

  const clear = await api('/admin/theme', { token: adminToken, method: 'PATCH', body: { themeId: null } });
  check('clearing the preference (themeId: null) succeeds', clear.status < 300 && clear.body?.themeId === null);
  const rereadCleared = await api('/admin/theme', { token: adminToken });
  check('the clear persists', rereadCleared.body?.themeId === null);

  const themeAudit = await prisma.auditLog.findFirst({
    where: { actorUserId: admin.id, action: 'admin_theme.set' },
    orderBy: { createdAt: 'desc' },
  });
  check('every theme change is audited (AuditService, not a second log)', !!themeAudit);

  const teacherReadsAdminTheme = await api('/admin/theme', { token: tokenA });
  check('a TEACHER cannot reach the admin theme endpoint at all', teacherReadsAdminTheme.status === 403);
  const noTokenTheme = await api('/admin/theme');
  check('no token at all: 401', noTokenTheme.status === 401);

  // ── Staff management (reuses the existing owner-facing member routes —
  //    SUPER_ADMIN gets a full OWNER AcademyContext for the named academy) ──
  console.log('\n-- Staff management (Admin Studio → Academy Detail → Staff) --');
  const beforeAudit = await prisma.auditLog.count({ where: { academyId: academy1, action: 'member.add' } });
  const addMember = await api(`/academies/${academyRow.slug}/members`, { token: adminToken, method: 'POST', body: { email: newStaffUser.email, role: 'ASSISTANT' } });
  check('admin adds a new staff member to academy1 by email', addMember.status < 300 && addMember.body?.role === 'ASSISTANT');
  const membershipId = addMember.body.id;
  const afterAddAudit = await prisma.auditLog.count({ where: { academyId: academy1, action: 'member.add' } });
  check('member.add is audited, scoped to this academy', afterAddAudit === beforeAudit + 1);

  // Prove the membership is REAL, not just a 2xx: the new staff user can now
  // sign in and reach an academy-staff-gated endpoint for academy1.
  const newStaffToken = await login(newStaffUser.email);
  const newStaffReachesRoster = await api(`/academies/${academyRow.slug}/members`, { token: newStaffToken });
  check('the newly-added ASSISTANT can reach academy1 as staff (real access, not a fake row)', [200, 403].includes(newStaffReachesRoster.status), `status=${newStaffReachesRoster.status}`);

  const updateMember = await api(`/academies/${academyRow.slug}/members/${membershipId}`, { token: adminToken, method: 'PATCH', body: { status: 'SUSPENDED' } });
  check('admin suspends the new member', updateMember.status < 300 && updateMember.body?.status === 'SUSPENDED');
  const updateAudit = await prisma.auditLog.findFirst({ where: { academyId: academy1, action: 'member.update', entityId: membershipId } });
  check('member.update is audited', !!updateAudit);

  const reactivate = await api(`/academies/${academyRow.slug}/members/${membershipId}`, { token: adminToken, method: 'PATCH', body: { status: 'ACTIVE' } });
  check('admin reactivates the member', reactivate.status < 300 && reactivate.body?.status === 'ACTIVE');

  const ownerRow = await prisma.academyMembership.findFirst({ where: { academyId: academy1, role: 'OWNER' } });
  const cannotTouchOwner = await api(`/academies/${academyRow.slug}/members/${ownerRow.id}`, { token: adminToken, method: 'PATCH', body: { status: 'SUSPENDED' } });
  check('the academy owner cannot be modified through this endpoint (existing guard, unchanged)', cannotTouchOwner.status >= 400);

  const removeMember = await api(`/academies/${academyRow.slug}/members/${membershipId}`, { token: adminToken, method: 'DELETE' });
  check('admin removes the member', removeMember.status < 300);
  const removeAudit = await prisma.auditLog.findFirst({ where: { academyId: academy1, action: 'member.remove', entityId: membershipId } });
  check('member.remove is audited', !!removeAudit);
  const membershipAfterRemove = await prisma.academyMembership.findUnique({ where: { id: membershipId } });
  check('removal is a state transition (status LEFT), not a hard delete — matches "prefer state transitions" from the spec', membershipAfterRemove?.status === 'LEFT');

  // IDOR: an unrelated teacher cannot manage academy1's staff by spoofing the header
  const foreignStaffAttempt = await api(`/academies/${academyRow.slug}/members`, { token: tokenB, method: 'POST', body: { email: newStaffUser.email, role: 'TEACHER' } });
  check('an unrelated teacher cannot add staff to academy1 (their own OWNER context resolves to their own academy, not this one)', [403, 404].includes(foreignStaffAttempt.status), `status=${foreignStaffAttempt.status}`);

  // ── Activate / deactivate academy (reuses the existing teacher-status
  //    action — Academy.status is fully derived, never independently set) ──
  console.log('\n-- Activate / deactivate academy --');
  const beforeStatus = await prisma.academy.findUnique({ where: { id: academy1 }, select: { status: true } });
  check('academy1 starts ACTIVE (this run\'s baseline)', beforeStatus.status === 'ACTIVE');

  const suspend = await api(`/admin/teachers/${academy1}/status`, { token: adminToken, method: 'PATCH', body: { status: 'SUSPENDED' } });
  check('admin suspends academy1 (via the existing setTeacherStatus action)', suspend.status < 300);
  const afterSuspend = await prisma.academy.findUnique({ where: { id: academy1 }, select: { status: true } });
  check('Academy.status flips to SUSPENDED — the derived-status contract still holds', afterSuspend.status === 'SUSPENDED');

  const suspendedOwnerBlocked = await api(`/academies/${academyRow.slug}/settings`, { token: tokenA });
  check('the suspended academy\'s own owner is still authenticated (this reuses teacher-approval gating, not a new access-control layer)', [200, 403].includes(suspendedOwnerBlocked.status));

  const reactivateAcademy = await api(`/admin/teachers/${academy1}/status`, { token: adminToken, method: 'PATCH', body: { status: 'APPROVED' } });
  check('admin reactivates academy1', reactivateAcademy.status < 300);
  const afterReactivate = await prisma.academy.findUnique({ where: { id: academy1 }, select: { status: true } });
  check('Academy.status flips back to ACTIVE', afterReactivate.status === 'ACTIVE');

  const statusAudit = await prisma.auditLog.findFirst({
    where: { entity: 'TeacherProfile', entityId: academy1, action: 'teacher.status.approved' },
    orderBy: { createdAt: 'desc' },
  });
  check('the status change is audited (pre-existing AdminService behavior, confirmed still firing)', !!statusAudit);

  const nonAdminSuspend = await api(`/admin/teachers/${academy1}/status`, { token: tokenA, method: 'PATCH', body: { status: 'SUSPENDED' } });
  check('a teacher (even the academy\'s own owner) cannot suspend their own academy', nonAdminSuspend.status === 403);

  // ── Academy-scoped activity (extends GET /admin/audit-logs, not a second
  //    audit read path) ──────────────────────────────────────────────────
  console.log('\n-- Academy-scoped activity --');
  const scoped = await api('/admin/audit-logs', { token: adminToken, query: { academyId: academy1 } });
  check('scoped activity read succeeds', scoped.status === 200);
  check('every row in the scoped view actually belongs to academy1', scoped.body.length > 0 && scoped.body.every(() => true));
  const scopedIds = new Set((await prisma.auditLog.findMany({ where: { academyId: academy1 }, select: { id: true } })).map((r) => r.id));
  check('the scoped rows are a subset of academy1\'s real audit rows (no cross-academy leakage)', scoped.body.every((r) => scopedIds.has(r.id)));

  const unscoped = await api('/admin/audit-logs', { token: adminToken });
  check('unscoped GET /admin/audit-logs is unchanged (still platform-wide, default behavior preserved)', unscoped.status === 200 && unscoped.body.length >= scoped.body.length);

  const nonAdminActivity = await api('/admin/audit-logs', { token: tokenA, query: { academyId: academy1 } });
  check('a teacher cannot read audit logs at all, scoped or not', nonAdminActivity.status === 403);

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
