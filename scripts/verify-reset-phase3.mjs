#!/usr/bin/env node
/**
 * Real HTTP + DB verification for Architecture Reset Phase 3: shareable staff
 * invitation links, eligibility, atomic single-use, multi-Center membership,
 * removal cleanup. Local only.
 *
 *   CONFIRM_TEST_DB=yes DATABASE_URL=postgresql://...localhost:PORT/darsly node scripts/verify-reset-phase3.mjs
 */
import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';

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
const cleanup = { academyIds: [], userIds: [], groupIds: [] };
const tag = Date.now();

async function main() {
  console.log('== Reset Phase 3 verification ==\n');

  const teacherX = await prisma.academy.findFirst({ where: { kind: 'PERSONAL' }, select: { id: true, slug: true, owner: { select: { email: true } } } });
  const teacherB = await prisma.academy.findFirst({ where: { kind: 'PERSONAL', id: { not: teacherX.id } }, select: { id: true, slug: true, owner: { select: { email: true } } } });
  const student = await prisma.user.findFirst({ where: { role: 'STUDENT' }, select: { email: true } });
  const admin = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN' }, select: { email: true } });

  const ownerTok = await login(teacherX.owner.email);
  const teacherBTok = await login(teacherB.owner.email);
  const studentTok = await login(student.email);
  const adminTok = await login(admin.email);
  check('fixture logins (owner, teacher B, student, super admin)', !!ownerTok && !!teacherBTok && !!studentTok && !!adminTok);

  // Promote teacherX's own workspace into a real CENTER (Phase 2 op) so invitation
  // links are exercised against a genuine multi-teacher organisation.
  const centerRes = await api('/admin/centers', { token: adminTok, method: 'POST', body: { name: `Invite Center ${tag}`, adminName: 'ignored', adminEmail: teacherX.owner.email } });
  check('setup: teacherX designated OWNER of a real Center', centerRes.status === 201, String(centerRes.status));
  const centerId = centerRes.body.id, centerSlug = centerRes.body.slug;
  cleanup.academyIds.push(centerId);

  // ── 1. Creation permissions ──
  const createBody = { role: 'TEACHER' };
  const h = { 'X-Academy-Id': centerId };
  check('OWNER can create a TEACHER invitation link', (await api(`/academies/${centerSlug}/invitation-links`, { token: ownerTok, method: 'POST', body: createBody, headers: h })).status === 201);
  check('OWNER can create an ASSISTANT invitation link', (await api(`/academies/${centerSlug}/invitation-links`, { token: ownerTok, method: 'POST', body: { role: 'ASSISTANT' }, headers: h })).status === 201);
  check('invalid role (OWNER) rejected by validation', (await api(`/academies/${centerSlug}/invitation-links`, { token: ownerTok, method: 'POST', body: { role: 'OWNER' }, headers: h })).status === 400);
  check('STUDENT cannot create an invitation link', (await api(`/academies/${centerSlug}/invitation-links`, { token: studentTok, method: 'POST', body: createBody, headers: h })).status === 404);

  // ── 2. Generate the link we'll actually redeem ──
  const created = await api(`/academies/${centerSlug}/invitation-links`, { token: ownerTok, method: 'POST', body: createBody, headers: h });
  const rawToken = created.body.token;
  check('token is 32+ random bytes (base64url)', typeof rawToken === 'string' && rawToken.length >= 43);
  const stored = await prisma.academyInvitationLink.findFirst({ where: { academyId: centerId, role: 'TEACHER' }, orderBy: { createdAt: 'desc' } });
  check('raw token never stored — only its sha256 hash', /^[a-f0-9]{64}$/.test(stored.tokenHash) && stored.tokenHash !== rawToken);
  check('academyId in the stored row is the Center, from context', stored.academyId === centerId);
  const listBody = await api(`/academies/${centerSlug}/invitation-links`, { token: ownerTok, headers: h });
  check('list never returns a raw token', !JSON.stringify(listBody.body).includes(rawToken));

  // ── 3. Preview: safe, and reveals nothing once dead ──
  const preview = await api(`/invitation-links/${rawToken}`);
  check('preview shows only Center name + role + expiry, no ids', preview.status === 200 && preview.body.academyName && preview.body.role === 'TEACHER' && !('academyId' in preview.body) && !('id' in preview.body));
  check('unknown token → 404', (await api('/invitation-links/not-a-real-token')).status === 404);

  // ── 4. Eligibility ──
  check('STUDENT is refused acceptance', (await api(`/invitation-links/${rawToken}/accept`, { token: studentTok, method: 'POST' })).status === 400);
  check('an ineligible attempt does NOT burn the token — still previewable', (await api(`/invitation-links/${rawToken}`)).status === 200);

  const teacherBProfile = await prisma.teacherProfile.findFirst({ where: { userId: (await prisma.user.findUnique({ where: { email: teacherB.owner.email } })).id } });
  for (const status of ['PENDING', 'SUSPENDED', 'REJECTED']) {
    await prisma.teacherProfile.update({ where: { id: teacherBProfile.id }, data: { status } });
    const r = await api(`/invitation-links/${rawToken}/accept`, { token: teacherBTok, method: 'POST' });
    check(`${status} teacher is refused acceptance`, r.status === 400, String(r.status));
  }
  await prisma.teacherProfile.update({ where: { id: teacherBProfile.id }, data: { status: 'APPROVED' } });

  // ── 5. Explicit accept: success, atomic single-use, replay ──
  const accepted = await api(`/invitation-links/${rawToken}/accept`, { token: teacherBTok, method: 'POST' });
  check('approved teacher accepts → ACTIVE membership', accepted.status < 300 && accepted.body.status === 'ACTIVE' && accepted.body.role === 'TEACHER', String(accepted.status));
  const membershipRow = await prisma.academyMembership.findUnique({ where: { userId_academyId: { userId: teacherBProfile.userId, academyId: centerId } } });
  check('membership row: ACTIVE, correct role', membershipRow?.status === 'ACTIVE' && membershipRow?.role === 'TEACHER');
  check('replay of a used token → 410', (await api(`/invitation-links/${rawToken}/accept`, { token: teacherBTok, method: 'POST' })).status === 410);
  check('used token no longer previewable', (await api(`/invitation-links/${rawToken}`)).status !== 200);

  // ── 6. Already-a-member conflict ──
  const secondLink = await api(`/academies/${centerSlug}/invitation-links`, { token: ownerTok, method: 'POST', body: createBody, headers: h });
  check('an already-ACTIVE member gets a conflict, not a silent re-join', (await api(`/invitation-links/${secondLink.body.token}/accept`, { token: teacherBTok, method: 'POST' })).status === 409);

  // ── 7. Revocation and expiry ──
  const revokeTarget = await api(`/academies/${centerSlug}/invitation-links`, { token: ownerTok, method: 'POST', body: createBody, headers: h });
  check('OWNER revokes a pending link', (await api(`/academies/${centerSlug}/invitation-links/${revokeTarget.body.id}`, { token: ownerTok, method: 'DELETE', headers: h })).status < 300);
  check('revoked link is no longer previewable', (await api(`/invitation-links/${revokeTarget.body.token}`)).status !== 200);
  check('revoked link cannot be accepted', (await api(`/invitation-links/${revokeTarget.body.token}/accept`, { token: teacherBTok, method: 'POST' })).status === 410);

  const expiredRaw = 'phase3-expired-probe-token';
  const expiredRow = await prisma.academyInvitationLink.create({
    data: { academyId: centerId, role: 'ASSISTANT', tokenHash: createHash('sha256').update(expiredRaw).digest('hex'), createdByUserId: teacherX.owner.email, expiresAt: new Date(Date.now() - 1000) },
  });
  check('expired link cannot be accepted', (await api(`/invitation-links/${expiredRaw}/accept`, { token: teacherBTok, method: 'POST' })).status === 410);
  await prisma.academyInvitationLink.delete({ where: { id: expiredRow.id } }).catch(() => {});

  // ── 8. Concurrent redemption: exactly one wins ──
  const raceLink = await api(`/academies/${centerSlug}/invitation-links`, { token: ownerTok, method: 'POST', body: { role: 'ASSISTANT' }, headers: h });
  await prisma.academyMembership.deleteMany({ where: { academyId: centerId, userId: teacherBProfile.userId } }); // reset for a clean race
  const race = await Promise.all([1, 2].map(() => api(`/invitation-links/${raceLink.body.token}/accept`, { token: teacherBTok, method: 'POST' })));
  check('concurrent accept: exactly one success', race.filter((r) => r.status < 300).length === 1, race.map((r) => r.status).join('/'));

  // ── 9. Multi-Center: teacher B ends up in PERSONAL + Center X + a second Center ──
  const centerY = await api('/admin/centers', { token: adminTok, method: 'POST', body: { name: `Center Y ${tag}`, adminName: 'ignored', adminEmail: teacherX.owner.email } });
  cleanup.academyIds.push(centerY.body.id);
  const linkY = await api(`/academies/${centerY.body.slug}/invitation-links`, { token: ownerTok, method: 'POST', body: createBody, headers: { 'X-Academy-Id': centerY.body.id } });
  check('teacher B joins a second, independent Center', (await api(`/invitation-links/${linkY.body.token}/accept`, { token: teacherBTok, method: 'POST' })).status < 300);

  const bMemberships = await prisma.academyMembership.findMany({ where: { userId: teacherBProfile.userId, status: 'ACTIVE' }, select: { academyId: true } });
  const bAcademyIds = new Set(bMemberships.map((m) => m.academyId));
  check('teacher B: PERSONAL + Center X + Center Y all ACTIVE simultaneously', bAcademyIds.has(teacherB.id) && bAcademyIds.has(centerId) && bAcademyIds.has(centerY.body.id));
  const bProfileAfter = await prisma.teacherProfile.findUnique({ where: { id: teacherBProfile.id }, select: { slug: true, status: true } });
  check("teacher B's own PERSONAL slug/identity untouched by joining Centers", bProfileAfter.slug === teacherBProfile.slug && bProfileAfter.status === 'APPROVED');
  check('teacher B still resolves their own PERSONAL academy with no header', (await api(`/academies/${teacherB.slug}/me`, { token: teacherBTok })).body?.role === 'OWNER');

  // ── 10. Removal cleanup ──
  const group = await prisma.group.create({ data: { academyId: centerId, name: `Phase3 probe group ${tag}`, status: 'ACTIVE' } });
  cleanup.groupIds.push(group.id);
  await prisma.groupAssignment.create({ data: { groupId: group.id, userId: teacherBProfile.userId, role: 'TEACHER', academyId: centerId } });
  const bMembershipInX = await prisma.academyMembership.findUnique({ where: { userId_academyId: { userId: teacherBProfile.userId, academyId: centerId } } });
  check('OWNER removes teacher B from Center X', (await api(`/academies/${centerSlug}/members/${bMembershipInX.id}`, { token: ownerTok, method: 'DELETE', headers: h })).status < 300);
  check('membership → LEFT (not deleted)', (await prisma.academyMembership.findUnique({ where: { id: bMembershipInX.id } })).status === 'LEFT');
  check('GroupAssignments in that Center cleaned up', (await prisma.groupAssignment.count({ where: { academyId: centerId, userId: teacherBProfile.userId, deletedAt: null } })) === 0);
  check('teacher B still active globally and still ACTIVE in Center Y', (await login(teacherB.owner.email)) !== null && (await prisma.academyMembership.findUnique({ where: { userId_academyId: { userId: teacherBProfile.userId, academyId: centerY.body.id } } })).status === 'ACTIVE');

  check('cannot silently restore LEFT via generic member update (Phase 1 rule holds)', (await api(`/academies/${centerSlug}/members/${bMembershipInX.id}`, { token: ownerTok, method: 'PATCH', headers: h, body: { status: 'ACTIVE' } })).status === 400);
  const rejoinLink = await api(`/academies/${centerSlug}/invitation-links`, { token: ownerTok, method: 'POST', body: createBody, headers: h });
  const rejoined = await api(`/invitation-links/${rejoinLink.body.token}/accept`, { token: teacherBTok, method: 'POST' });
  check('rejoining requires a fresh invitation link + explicit accept', rejoined.status < 300 && rejoined.body.status === 'ACTIVE');

  // ── 11. Regression ──
  check('STAFF/teacher Center Admin from Phase 2 still works', (await api(`/academies/${centerSlug}/me`, { token: ownerTok, headers: h })).body?.role === 'OWNER');
  check('SUPER_ADMIN still works', (await api('/admin/academies', { token: adminTok })).status === 200);
  check('STUDENT still works', (await api('/auth/me', { token: studentTok })).status < 300);
  check("teacher X's own workspace unaffected by owning a Center too", (await api(`/academies/${teacherX.slug}/me`, { token: ownerTok })).body?.role === 'OWNER');
}

main()
  .catch((e) => { console.error('\nUNCAUGHT:', e); fail++; })
  .finally(async () => {
    for (const id of cleanup.groupIds) await prisma.group.delete({ where: { id } }).catch(() => {});
    await prisma.academyInvitationLink.deleteMany({ where: { academyId: { in: cleanup.academyIds } } }).catch(() => {});
    await prisma.academyMembership.deleteMany({ where: { academyId: { in: cleanup.academyIds } } }).catch(() => {});
    for (const id of cleanup.academyIds) await prisma.academy.delete({ where: { id } }).catch(() => {});
    for (const id of cleanup.userIds) await prisma.user.delete({ where: { id } }).catch(() => {});
    await prisma.$disconnect();
    console.log(`\n== ${pass} passed, ${fail} failed ==`);
    process.exit(fail ? 1 : 0);
  });
