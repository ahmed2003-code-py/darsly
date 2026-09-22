#!/usr/bin/env node
/**
 * Real HTTP + DB verification for Architecture Reset Phase 2: Center creation,
 * STAFF identity, one-time activation, Center status, isolation. Local only.
 *
 *   CONFIRM_TEST_DB=yes DATABASE_URL=postgresql://...localhost:PORT/darsly node scripts/verify-reset-phase2.mjs
 */
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';

const DB = process.env.DATABASE_URL ?? '';
const PORT = process.env.API_PORT ?? '41000';
const PASSWORD = 'Darsly@123';
if (process.env.CONFIRM_TEST_DB !== 'yes') { console.error('REFUSED: set CONFIRM_TEST_DB=yes.'); process.exit(2); }
if (!DB || /railway|prod|amazonaws|supabase|neon\.tech|render\.com/i.test(DB)) { console.error('REFUSED: DATABASE_URL missing or hosted.'); process.exit(2); }

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  (${d})` : ''}`); ok ? pass++ : fail++; };
async function api(p, { token, method = 'GET', body, headers } = {}) {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/v1${p}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(headers ?? {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, body: json };
}
const login = async (email, password = PASSWORD) => {
  const r = await api('/auth/login', { method: 'POST', body: { email, password } });
  return r.status < 300 ? r.body.accessToken : null;
};
const prisma = new PrismaClient();
const tag = randomBytes(3).toString('hex');
const cleanup = { academyIds: [], userIds: [] };

async function main() {
  console.log('== Reset Phase 2 verification ==\n');
  const admin = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN' }, select: { email: true } });
  const teacherOwner = await prisma.academy.findFirst({ where: { kind: 'PERSONAL' }, select: { id: true, slug: true, owner: { select: { email: true } } } });
  const student = await prisma.user.findFirst({ where: { role: 'STUDENT' }, select: { email: true } });
  const adminTok = await login(admin.email);
  const teacherTok = await login(teacherOwner.owner.email);
  const studentTok = await login(student.email);
  check('super admin, teacher, student logins', !!adminTok && !!teacherTok && !!studentTok);

  // ── 1. Only SUPER_ADMIN creates Centers ──
  const dto = { name: `Center ${tag}`, adminName: 'Center Admin', adminEmail: `center-admin-${tag}@example.test` };
  for (const [who, tok] of [['teacher', teacherTok], ['student', studentTok]]) {
    const r = await api('/admin/centers', { token: tok, method: 'POST', body: dto });
    check(`${who} cannot create a Center`, r.status === 403, String(r.status));
  }
  const created = await api('/admin/centers', { token: adminTok, method: 'POST', body: dto });
  check('SUPER_ADMIN creates a Center', created.status === 201 && created.body.kind === 'CENTER' && created.body.status === 'PENDING', String(created.status));
  const centerId = created.body.id; cleanup.academyIds.push(centerId);
  const staffUser = await prisma.user.findUnique({ where: { email: dto.adminEmail }, include: { teacherProfile: true, studentProfile: true } });
  cleanup.userIds.push(staffUser.id);
  check('new admin is STAFF, inactive, no password', staffUser.role === 'STAFF' && !staffUser.isActive && !staffUser.passwordHash);
  check('no TeacherProfile / StudentProfile fabricated', !staffUser.teacherProfile && !staffUser.studentProfile);
  const m0 = await prisma.academyMembership.findUnique({ where: { userId_academyId: { userId: staffUser.id, academyId: centerId } } });
  check('OWNER membership starts INVITED', m0.role === 'OWNER' && m0.status === 'INVITED');
  const t0 = await prisma.academyActivationToken.findFirst({ where: { academyId: centerId } });
  check('token stored hashed (sha256 hex), unexpired', /^[a-f0-9]{64}$/.test(t0.tokenHash) && t0.expiresAt > new Date());
  check('duplicate Center for same admin email is refused (identity rule)', (await api('/admin/centers', { token: adminTok, method: 'POST', body: { ...dto, name: `${dto.name} 2` } })).status === 400);

  // ── 2. Cannot log in before activation; wrong/expired tokens rejected ──
  check('inactive STAFF cannot log in', (await login(dto.adminEmail, 'Passw0rd!')) === null);
  check('unknown activation token → 404', (await api(`/auth/activation/${'x'.repeat(40)}`)).status === 404);
  const raw = randomBytes(32).toString('base64url');
  await prisma.academyActivationToken.deleteMany({ where: { academyId: centerId } });
  const row = await prisma.academyActivationToken.create({ data: { userId: staffUser.id, academyId: centerId, tokenHash: createHash('sha256').update(raw).digest('hex'), expiresAt: new Date(Date.now() + 3_600_000) } });
  const preview = await api(`/auth/activation/${raw}`);
  check('preview shows only name/email/center', preview.status === 200 && preview.body.academyName === dto.name && !('id' in preview.body));
  const expiredRaw = randomBytes(32).toString('base64url');
  await prisma.academyActivationToken.create({ data: { userId: staffUser.id, academyId: centerId, tokenHash: createHash('sha256').update(expiredRaw).digest('hex'), expiresAt: new Date(Date.now() - 1000) } });
  check('expired token → 410', (await api('/auth/activation', { method: 'POST', body: { token: expiredRaw, password: 'Passw0rd!' } })).status === 410);
  const revokedRaw = randomBytes(32).toString('base64url');
  await prisma.academyActivationToken.create({ data: { userId: staffUser.id, academyId: centerId, tokenHash: createHash('sha256').update(revokedRaw).digest('hex'), expiresAt: new Date(Date.now() + 3_600_000), revokedAt: new Date() } });
  check('revoked token → 410', (await api('/auth/activation', { method: 'POST', body: { token: revokedRaw, password: 'Passw0rd!' } })).status === 410);

  // ── 3. Replay race: two concurrent redemptions, exactly one wins ──
  const race = await Promise.all([1, 2].map(() => api('/auth/activation', { method: 'POST', body: { token: raw, password: 'Passw0rd!' } })));
  check('concurrent redemption: exactly one 200', race.filter((r) => r.status === 200).length === 1, race.map((r) => r.status).join('/'));
  check('reused token → 410', (await api('/auth/activation', { method: 'POST', body: { token: raw, password: 'Other1234' } })).status === 410);
  const after = await prisma.user.findUnique({ where: { id: staffUser.id } });
  const m1 = await prisma.academyMembership.findUnique({ where: { id: m0.id } });
  const c1 = await prisma.academy.findUnique({ where: { id: centerId } });
  check('activation: user active + password set, membership ACTIVE, center ACTIVE', after.isActive && !!after.passwordHash && m1.status === 'ACTIVE' && c1.status === 'ACTIVE');
  check('token cannot be used to change identity', after.role === 'STAFF' && (await prisma.academyActivationToken.findUnique({ where: { id: row.id } })).usedAt !== null);

  // ── 4. STAFF session: valid identity, no tenantId, scoped to own Center only ──
  const staffTok = await login(dto.adminEmail, 'Passw0rd!');
  check('activated STAFF can log in', !!staffTok);
  const payload = JSON.parse(Buffer.from(staffTok.split('.')[1], 'base64url').toString());
  check('JWT role STAFF, tenantId undefined', payload.role === 'STAFF' && payload.tenantId === undefined);
  const me = await api(`/academies/${created.body.slug}/me`, { token: staffTok, headers: { 'X-Academy-Id': centerId } });
  check('STAFF is OWNER in own Center with member.manage', me.status === 200 && me.body.role === 'OWNER' && me.body.permissions.includes('member.manage'));
  check('STAFF cannot select a teacher\'s PERSONAL academy', (await api(`/academies/${teacherOwner.slug}/me`, { token: staffTok, headers: { 'X-Academy-Id': teacherOwner.id } })).status === 404);
  check('STAFF cannot create Centers', (await api('/admin/centers', { token: staffTok, method: 'POST', body: dto })).status === 403);
  check('STAFF is refused teacher-only authorship routes', (await api('/teacher/profile', { token: staffTok })).status === 403);
  check('STAFF is refused student-only routes', (await api('/enrollments/mine', { token: staffTok })).status === 403);
  check('teacher cannot enter the Center', (await api(`/academies/${created.body.slug}/me`, { token: teacherTok, headers: { 'X-Academy-Id': centerId } })).status === 404);

  // ── 5. Second Center: Center Admin A cannot reach Center B ──
  const dto2 = { name: `Center B ${tag}`, adminName: 'Admin B', adminEmail: `center-admin-b-${tag}@example.test` };
  const createdB = await api('/admin/centers', { token: adminTok, method: 'POST', body: dto2 });
  cleanup.academyIds.push(createdB.body.id); cleanup.userIds.push((await prisma.user.findUnique({ where: { email: dto2.adminEmail } })).id);
  check('Center Admin A cannot access Center B', (await api(`/academies/${createdB.body.slug}/me`, { token: staffTok, headers: { 'X-Academy-Id': createdB.body.id } })).status === 404);

  // ── 6. Existing approved TEACHER designated as Center Admin ──
  const dto3 = { name: `Center T ${tag}`, adminName: 'ignored', adminEmail: teacherOwner.owner.email };
  const createdT = await api('/admin/centers', { token: adminTok, method: 'POST', body: dto3 });
  cleanup.academyIds.push(createdT.body.id);
  check('approved teacher becomes OWNER directly (ACTIVE, no activation)', createdT.status === 201 && createdT.body.status === 'ACTIVE' && createdT.body.admin.activation === 'NOT_REQUIRED');
  const tpBefore = await prisma.teacherProfile.findFirst({ where: { user: { email: teacherOwner.owner.email } }, select: { slug: true, status: true } });
  check('teacher identity untouched', tpBefore.status === 'APPROVED');
  check('teacher acts in the new Center as OWNER', (await api(`/academies/${createdT.body.slug}/me`, { token: teacherTok, headers: { 'X-Academy-Id': createdT.body.id } })).body?.role === 'OWNER');
  check('student cannot be designated', (await api('/admin/centers', { token: adminTok, method: 'POST', body: { name: `S ${tag}`, adminName: 'S', adminEmail: student.email } })).status === 400);

  // ── 7. Slug isolation ──
  const rename = await api(`/academies/${createdT.body.slug}/settings`, { token: adminTok, method: 'PATCH', headers: { 'X-Academy-Id': createdT.body.id }, body: { slug: `renamed-${tag}` } });
  const tpAfter = await prisma.teacherProfile.findFirst({ where: { user: { email: teacherOwner.owner.email } }, select: { slug: true } });
  check('renaming a Center leaves the admin\'s /t/:slug intact', rename.status < 300 && tpAfter.slug === tpBefore.slug, `${rename.status}`);
  check('Center cannot take a teacher slug', (await api('/admin/centers', { token: adminTok, method: 'POST', body: { name: 'Slug Clash', slug: tpBefore.slug, adminName: 'Slug Clash', adminEmail: `x-${tag}@example.test` } })).status === 409);
  const reg = await api('/auth/register/teacher', { method: 'POST', body: { fullName: `renamed-${tag}`, email: `renamed-${tag}@example.test`, phone: `0101${tag.replace(/\D/g, '1').padEnd(7, '1').slice(0, 7)}`, password: 'Passw0rd!', subjectIds: [(await prisma.subject.findFirst()).id], stages: ['SECONDARY'] } });
  const newTp = reg.status < 300 ? await prisma.teacherProfile.findFirst({ where: { user: { email: `renamed-${tag}@example.test` } } }) : null;
  if (newTp) cleanup.userIds.push(newTp.userId);
  check('teacher signup avoids a Center slug', reg.status < 300 && newTp && newTp.slug !== `renamed-${tag}`, `${reg.status} ${newTp?.slug ?? ''}`);

  // ── 8. Center status ──
  check('STAFF cannot suspend a Center', (await api(`/admin/centers/${centerId}/status`, { token: staffTok, method: 'PATCH', body: { status: 'SUSPENDED' } })).status === 403);
  check('SUPER_ADMIN suspends', (await api(`/admin/centers/${centerId}/status`, { token: adminTok, method: 'PATCH', body: { status: 'SUSPENDED' } })).status === 200);
  check('suspended Center blocks its admin on the next request', (await api(`/academies/${created.body.slug}/me`, { token: staffTok, headers: { 'X-Academy-Id': centerId } })).status === 404);
  check('membership row is kept, not deleted', (await prisma.academyMembership.findUnique({ where: { id: m0.id } })).status === 'ACTIVE');
  await api(`/admin/centers/${createdT.body.id}/status`, { token: adminTok, method: 'PATCH', body: { status: 'SUSPENDED' } });
  check('suspending a Center does not suspend the teacher identity', (await prisma.teacherProfile.findFirst({ where: { user: { email: teacherOwner.owner.email } } })).status === 'APPROVED' && !!(await login(teacherOwner.owner.email)));
  check('PERSONAL academy cannot be driven by the Center status endpoint', (await api(`/admin/centers/${teacherOwner.id}/status`, { token: adminTok, method: 'PATCH', body: { status: 'SUSPENDED' } })).status === 400);
  check('SUPER_ADMIN reactivates', (await api(`/admin/centers/${centerId}/status`, { token: adminTok, method: 'PATCH', body: { status: 'ACTIVE' } })).status === 200);

  // ── 9. Views ──
  const centers = await api('/admin/academies?kind=CENTER', { token: adminTok });
  const personal = await api('/admin/academies?kind=PERSONAL', { token: adminTok });
  check('Centers view lists only CENTER kind', centers.body.academies.every((a) => a.kind === 'CENTER') && centers.body.academies.some((a) => a.id === centerId));
  check('Independent Teachers view lists only PERSONAL kind', personal.body.academies.every((a) => a.kind === 'PERSONAL') && personal.body.academies.some((a) => a.id === teacherOwner.id));
  check('default view is Centers (PERSONAL never leaks)', (await api('/admin/academies', { token: adminTok })).body.academies.every((a) => a.kind === 'CENTER'));

  // ── 10. Regression ──
  check('existing PERSONAL academies untouched', (await prisma.academy.count({ where: { kind: 'PERSONAL' } })) >= 6);
  check('teacher JWT still carries tenantId', JSON.parse(Buffer.from(teacherTok.split('.')[1], 'base64url').toString()).tenantId === teacherOwner.id);
  check('teacher still resolves own academy with no header', (await api(`/academies/${teacherOwner.slug}/me`, { token: teacherTok })).body?.role === 'OWNER');
}

main()
  .catch((e) => { console.error('\nUNCAUGHT:', e); fail++; })
  .finally(async () => {
    for (const id of cleanup.academyIds) await prisma.academy.delete({ where: { id } }).catch(() => {});
    // A teacher registered by this run was provisioned a PERSONAL academy that
    // RESTRICTs the user delete — remove it (and the profile) first, or the
    // user delete below fails silently and leaks a `renamed-*` teacher per run.
    for (const id of cleanup.userIds) {
      await prisma.academy.deleteMany({ where: { ownerUserId: id } }).catch(() => {});
      await prisma.teacherProfile.deleteMany({ where: { userId: id } }).catch(() => {});
      await prisma.user.delete({ where: { id } }).catch(() => {});
    }
    await prisma.$disconnect();
    console.log(`\n== ${pass} passed, ${fail} failed ==`);
    process.exit(fail ? 1 : 0);
  });
