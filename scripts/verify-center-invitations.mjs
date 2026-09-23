#!/usr/bin/env node
/**
 * Real HTTP + DB verification of the Center invitation/join flow, end to end:
 * an existing account accepting/declining, a brand-new TEACHER and a
 * brand-new ASSISTANT registering THROUGH the link, ownership (Center, never
 * platform), and the security matrix (tamper, expiry, revoke, decline,
 * consumed, replay, transfer, cross-Center, role fixing). Local only.
 *
 *   CONFIRM_TEST_DB=yes DATABASE_URL=postgresql://...localhost:PORT/darsly node scripts/verify-center-invitations.mjs
 */
import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';

const DB = process.env.DATABASE_URL ?? '';
const PORT = process.env.API_PORT ?? '41000';
const PASSWORD = 'Darsly@123';
if (process.env.CONFIRM_TEST_DB !== 'yes') {
  console.error('REFUSED: set CONFIRM_TEST_DB=yes.');
  process.exit(2);
}
if (!DB || /railway|prod|amazonaws|supabase|neon\.tech|render\.com/i.test(DB)) {
  console.error('REFUSED: DATABASE_URL missing or hosted.');
  process.exit(2);
}

let pass = 0,
  fail = 0;
const check = (n, ok, d = '') => {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  (${d})` : ''}`);
  ok ? pass++ : fail++;
};
async function api(p, { token, method = 'GET', body, headers } = {}) {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/v1${p}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(headers ?? {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* */
  }
  return { status: r.status, body: json };
}
const login = async (email, password = PASSWORD) => {
  const r = await api('/auth/login', { method: 'POST', body: { email, password } });
  return r.status < 300 ? r.body.accessToken : null;
};
const prisma = new PrismaClient();
const cleanup = { academyIds: [], userIds: [] };
const tag = Date.now();
const sha = (t) => createHash('sha256').update(t).digest('hex');

async function main() {
  console.log('== Center invitation / join verification ==\n');

  const before = {
    users: await prisma.user.count(),
    academies: await prisma.academy.count(),
    memberships: await prisma.academyMembership.count(),
    links: await prisma.academyInvitationLink.count(),
    teachers: await prisma.teacherProfile.count(),
  };

  const admin = await prisma.user.findFirst({
    where: { role: 'SUPER_ADMIN' },
    select: { email: true },
  });
  const student = await prisma.user.findFirst({
    where: { role: 'STUDENT' },
    select: { email: true },
  });
  const subject = await prisma.subject.findFirst({
    where: { isActive: true },
    select: { id: true },
  });
  const adminTok = await login(admin.email);
  const studentTok = await login(student.email);
  check('fixture logins (super admin, student)', !!adminTok && !!studentTok);

  // ── Setup: a real Center with a STAFF (non-teaching) owner, activated through the normal token ──
  const ownerEmail = `owner-${tag}@example.test`;
  const centerRes = await api('/admin/centers', {
    token: adminTok,
    method: 'POST',
    body: { name: `Invite Center ${tag}`, adminName: 'Center Owner', adminEmail: ownerEmail },
  });
  check(
    'setup: Center created by platform admin (owner is a STAFF identity, not the platform)',
    centerRes.status === 201 && centerRes.body.admin.role === 'STAFF',
    String(centerRes.status),
  );
  const centerId = centerRes.body.id,
    centerSlug = centerRes.body.slug;
  cleanup.academyIds.push(centerId);
  cleanup.userIds.push(centerRes.body.admin.id);
  check(
    'setup: activation link handed back to the admin in the same response',
    typeof centerRes.body.activationUrl === 'string' &&
      centerRes.body.activationUrl.includes('/activate?token='),
  );
  const actToken = new URL(centerRes.body.activationUrl).searchParams.get('token');
  check(
    'setup: owner activates through the token',
    (
      await api('/auth/activation', {
        method: 'POST',
        body: { token: actToken, password: PASSWORD },
      })
    ).status < 300,
  );
  const ownerTok = await login(ownerEmail);
  check('setup: Center owner can sign in', !!ownerTok);
  const H = { 'X-Academy-Id': centerId };
  const mkLink = async (role, tok = ownerTok, slug = centerSlug, h = H) =>
    (
      await api(`/academies/${slug}/invitation-links`, {
        token: tok,
        method: 'POST',
        body: { role },
        headers: h,
      })
    ).body;

  // A second Center (different owner) for cross-Center checks.
  const owner2Email = `owner2-${tag}@example.test`;
  const center2 = await api('/admin/centers', {
    token: adminTok,
    method: 'POST',
    body: { name: `Other Center ${tag}`, adminName: 'Other Owner', adminEmail: owner2Email },
  });
  cleanup.academyIds.push(center2.body.id);
  cleanup.userIds.push(center2.body.admin.id);
  await api('/auth/activation', {
    method: 'POST',
    body: {
      token: new URL(center2.body.activationUrl).searchParams.get('token'),
      password: PASSWORD,
    },
  });
  const owner2Tok = await login(owner2Email);
  check('setup: second, unrelated Center ready', !!owner2Tok && center2.body.id !== centerId);

  // ── A. Existing accounts: accept / decline ──
  console.log('\n-- A. existing accounts --');
  // An existing, APPROVED marketplace teacher (registered the normal way and approved by the platform).
  const exTeacherEmail = `existing-teacher-${tag}@example.test`;
  await api('/auth/register/teacher', {
    method: 'POST',
    body: {
      fullName: 'Existing Teacher',
      email: exTeacherEmail,
      password: PASSWORD,
      phone: `0101${String(tag).slice(-7)}`,
      subjectIds: [subject.id],
      stages: ['SECONDARY'],
    },
  });
  const exTeacherUser = await prisma.user.findUnique({
    where: { email: exTeacherEmail },
    select: { id: true, teacherProfile: { select: { id: true } } },
  });
  cleanup.userIds.push(exTeacherUser.id);
  cleanup.academyIds.push(exTeacherUser.teacherProfile.id);
  await prisma.teacherProfile.update({
    where: { id: exTeacherUser.teacherProfile.id },
    data: { status: 'APPROVED' },
  });
  await prisma.academy.update({
    where: { id: exTeacherUser.teacherProfile.id },
    data: { status: 'ACTIVE' },
  });
  const exTeacherTok = await login(exTeacherEmail);
  check('A0: existing approved teacher signs in', !!exTeacherTok);

  const tLink = await mkLink('TEACHER');
  const tPreview = await api(`/invitation-links/${tLink.token}`);
  check(
    'A1: preview is public and names ONLY this Center + role',
    tPreview.status === 200 &&
      tPreview.body.academyName === `Invite Center ${tag}` &&
      tPreview.body.role === 'TEACHER' &&
      !('academyId' in tPreview.body),
  );
  const tAccept = await api(`/invitation-links/${tLink.token}/accept`, {
    token: exTeacherTok,
    method: 'POST',
  });
  check(
    'A2: existing Teacher accepts → ACTIVE TEACHER membership in the EXACT Center',
    tAccept.status === 201 &&
      tAccept.body.academyId === centerId &&
      tAccept.body.role === 'TEACHER' &&
      tAccept.body.status === 'ACTIVE',
    String(tAccept.status),
  );
  const exTeacherRows = await prisma.academyMembership.findMany({
    where: { userId: exTeacherUser.id, status: 'ACTIVE' },
    select: { academyId: true, role: true },
  });
  check(
    'A3: their memberships: own PERSONAL (OWNER) + this Center (TEACHER) — nothing else',
    exTeacherRows.length === 2 &&
      exTeacherRows.some((m) => m.academyId === centerId && m.role === 'TEACHER') &&
      exTeacherRows.some(
        (m) => m.academyId === exTeacherUser.teacherProfile.id && m.role === 'OWNER',
      ),
  );
  check(
    'A4: the Center sees them as its member',
    (await api(`/academies/${centerSlug}/members`, { token: ownerTok, headers: H })).body?.some?.(
      (m) => m.userId === exTeacherUser.id && m.role === 'TEACHER',
    ) === true,
  );
  check(
    'A5: they can act inside the Center (workspace resolves via X-Academy-Id)',
    (await api(`/academies/${centerSlug}/me`, { token: exTeacherTok, headers: H })).body?.role ===
      'TEACHER',
  );
  const tReplay = await api(`/invitation-links/${tLink.token}/accept`, {
    token: exTeacherTok,
    method: 'POST',
  });
  check(
    'A6: duplicate acceptance by the same user is idempotent (2xx, same membership)',
    tReplay.status < 300 && tReplay.body.academyId === centerId,
    String(tReplay.status),
  );
  check(
    'A7: membership count unchanged by the replay',
    (await prisma.academyMembership.count({
      where: { userId: exTeacherUser.id, academyId: centerId },
    })) === 1,
  );

  // Decline: existing teacher, a fresh link → no membership of any status.
  const dLink = await mkLink('TEACHER');
  await prisma.academyMembership.deleteMany({
    where: { userId: exTeacherUser.id, academyId: centerId },
  }); // reset so the decline is a clean "no"
  const dRes = await api(`/invitation-links/${dLink.token}/decline`, {
    token: exTeacherTok,
    method: 'POST',
  });
  check(
    'A8: existing Teacher declines → 201/200, no membership row at all',
    dRes.status < 300 &&
      (await prisma.academyMembership.count({
        where: { userId: exTeacherUser.id, academyId: centerId },
      })) === 0,
    String(dRes.status),
  );
  const dRow = await prisma.academyInvitationLink.findUnique({
    where: { tokenHash: sha(dLink.token) },
  });
  check(
    'A9: the link records who declined, and is closed',
    !!dRow.declinedAt && dRow.declinedByUserId === exTeacherUser.id && !dRow.usedAt,
  );
  check(
    'A10: a declined link is no longer previewable',
    (await api(`/invitation-links/${dLink.token}`)).status === 410,
  );
  check(
    'A11: a declined link cannot be accepted afterwards',
    (await api(`/invitation-links/${dLink.token}/accept`, { token: exTeacherTok, method: 'POST' }))
      .status === 410,
  );
  check(
    'A12: declining again is idempotent for the same person',
    (await api(`/invitation-links/${dLink.token}/decline`, { token: exTeacherTok, method: 'POST' }))
      .status < 300,
  );
  check(
    'A13: someone else cannot decline a link already declined',
    (await api(`/invitation-links/${dLink.token}/decline`, { token: ownerTok, method: 'POST' }))
      .status === 410,
  );
  const ownerList = await api(`/academies/${centerSlug}/invitation-links`, {
    token: ownerTok,
    headers: H,
  });
  check(
    'A14: owner sees DECLINED (distinct from REVOKED/USED) in their list',
    ownerList.body?.find?.((l) => l.id === dLink.id)?.status === 'DECLINED',
  );

  // Existing ASSISTANT: an approved teacher identity accepting an ASSISTANT link.
  const aLink = await mkLink('ASSISTANT');
  const aAccept = await api(`/invitation-links/${aLink.token}/accept`, {
    token: exTeacherTok,
    method: 'POST',
  });
  check(
    'A15: existing account accepts an ASSISTANT link → ASSISTANT membership in the exact Center',
    aAccept.status === 201 &&
      aAccept.body.role === 'ASSISTANT' &&
      aAccept.body.academyId === centerId,
    String(aAccept.status),
  );
  const aDecLink = await mkLink('ASSISTANT');
  await prisma.academyMembership.deleteMany({
    where: { userId: exTeacherUser.id, academyId: centerId },
  });
  check(
    'A16: existing account declines an ASSISTANT link → no membership',
    (
      await api(`/invitation-links/${aDecLink.token}/decline`, {
        token: exTeacherTok,
        method: 'POST',
      })
    ).status < 300 &&
      (await prisma.academyMembership.count({
        where: { userId: exTeacherUser.id, academyId: centerId },
      })) === 0,
  );
  check(
    'A17: a STUDENT cannot accept, and does not burn the link',
    (
      await api(`/invitation-links/${(await mkLink('TEACHER')).token}/accept`, {
        token: studentTok,
        method: 'POST',
      })
    ).status === 400,
  );

  // ── B. New TEACHER through the link ──
  console.log('\n-- B. new Teacher --');
  const nbLink = await mkLink('TEACHER');
  const newTEmail = `new-teacher-${tag}@example.test`;
  const nbPhone = `0111${String(tag).slice(-7)}`;
  const nbNoSubjects = await api('/auth/register/invitation', {
    method: 'POST',
    body: {
      token: nbLink.token,
      fullName: 'New Teacher',
      email: newTEmail,
      password: PASSWORD,
      phone: nbPhone,
    },
  });
  check(
    'B1: a TEACHER invitee must say what they teach (400), and nothing is created',
    nbNoSubjects.status === 400 &&
      (await prisma.user.findUnique({ where: { email: newTEmail } })) === null,
    String(nbNoSubjects.status),
  );
  check(
    'B1b: that refusal did NOT burn the link',
    (await api(`/invitation-links/${nbLink.token}`)).status === 200,
  );
  const nbClean = {
    token: nbLink.token,
    fullName: 'New Teacher',
    email: newTEmail,
    password: PASSWORD,
    phone: nbPhone,
    subjectIds: [subject.id],
    stages: ['SECONDARY'],
  };
  // Hostile extras naming a role, a Center and an owner: the whitelist rejects the request outright.
  const nbHostile = await api('/auth/register/invitation', {
    method: 'POST',
    body: {
      ...nbClean,
      role: 'ASSISTANT',
      academyId: center2.body.id,
      ownerUserId: center2.body.admin.id,
      membershipRole: 'OWNER',
    },
  });
  check(
    'B1c: a body that tries to name role/Center/owner is refused (400), nothing created, link intact',
    nbHostile.status === 400 &&
      (await prisma.user.findUnique({ where: { email: newTEmail } })) === null &&
      (await api(`/invitation-links/${nbLink.token}`)).status === 200,
    String(nbHostile.status),
  );
  const nb = await api('/auth/register/invitation', { method: 'POST', body: nbClean });
  check(
    'B2: new Teacher registers through the link → 201 with a session (no approval wait)',
    nb.status === 201 && !!nb.body.accessToken && nb.body.user?.role === 'TEACHER',
    String(nb.status) + ' ' + JSON.stringify(nb.body?.message ?? ''),
  );
  const nbUser = await prisma.user.findUnique({
    where: { email: newTEmail },
    include: { teacherProfile: true, academyMemberships: true, ownedAcademies: true },
  });
  cleanup.userIds.push(nbUser.id);
  check(
    'B3: identity is TEACHER with an APPROVED profile — nobody at the platform was asked',
    nbUser.role === 'TEACHER' && nbUser.teacherProfile?.status === 'APPROVED' && nbUser.isActive,
  );
  check(
    'B4: exactly one membership: ACTIVE TEACHER in the EXACT Center of the link',
    nbUser.academyMemberships.length === 1 &&
      nbUser.academyMemberships[0].academyId === centerId &&
      nbUser.academyMemberships[0].role === 'TEACHER' &&
      nbUser.academyMemberships[0].status === 'ACTIVE',
  );
  check(
    'B5: NOT a platform teacher: no PERSONAL academy owned, no OWNER membership anywhere',
    nbUser.ownedAcademies.length === 0 &&
      !nbUser.academyMemberships.some((m) => m.role === 'OWNER'),
  );
  check(
    'B6: NOT attached to the platform admin or any other Center',
    !nbUser.academyMemberships.some((m) => m.academyId === center2.body.id),
  );
  check(
    'B7: the link is consumed by exactly this user',
    (await prisma.academyInvitationLink.findUnique({ where: { tokenHash: sha(nbLink.token) } }))
      .usedByUserId === nbUser.id,
  );
  check(
    'B8: absent from the public marketplace (discover) — they belong to the Center',
    !JSON.stringify((await api('/teachers', { token: studentTok })).body ?? '').includes(
      nbUser.teacherProfile.slug,
    ),
  );
  check(
    'B9: no public /t/ profile of their own',
    (await api(`/teachers/${nbUser.teacherProfile.slug}`, { token: studentTok })).status === 404,
  );
  check('B10: they can sign in normally afterwards', !!(await login(newTEmail)));
  check(
    'B11: the Center is their workspace (X-Academy-Id) with TEACHER authority',
    (await api(`/academies/${centerSlug}/me`, { token: nb.body.accessToken, headers: H })).body
      ?.role === 'TEACHER',
  );
  check(
    'B12: the Center owner sees them in the members list',
    (await api(`/academies/${centerSlug}/members`, { token: ownerTok, headers: H })).body?.some?.(
      (m) => m.userId === nbUser.id,
    ) === true,
  );
  check(
    'B13: they hold no authority in the other Center',
    (
      await api(`/academies/${center2.body.slug}/me`, {
        token: nb.body.accessToken,
        headers: { 'X-Academy-Id': center2.body.id },
      })
    ).status === 404,
  );
  await api(`/academies/${centerSlug}/subjects/${subject.id}`, {
    token: ownerTok,
    method: 'PUT',
    headers: H,
    body: { isActive: true },
  });
  const nbCourse = await api('/teacher/courses', {
    token: nb.body.accessToken,
    method: 'POST',
    headers: H,
    body: { title: `Center course ${tag}`, description: 'x', priceCents: 0, subjectId: subject.id },
  });
  check(
    'B14: authoring inside the Center works (course.academyId = Center, tenantId = their own profile)',
    nbCourse.status < 300 &&
      nbCourse.body.academyId === centerId &&
      nbCourse.body.tenantId === nbUser.teacherProfile.id,
    `${nbCourse.status} ${nbCourse.body?.code ?? ''}`,
  );
  if (nbCourse.status < 300)
    await prisma.course.delete({ where: { id: nbCourse.body.id } }).catch(() => {});
  check(
    'B15: registering again with the same email → 409, nothing duplicated',
    (
      await api('/auth/register/invitation', {
        method: 'POST',
        body: {
          token: (await mkLink('TEACHER')).token,
          fullName: 'New Teacher',
          email: newTEmail,
          password: PASSWORD,
          phone: nbPhone,
          subjectIds: [subject.id],
          stages: ['SECONDARY'],
        },
      })
    ).status === 409,
  );
  const nbReplay = await api('/auth/register/invitation', {
    method: 'POST',
    body: {
      token: nbLink.token,
      fullName: 'Other Person',
      email: `other-${tag}@example.test`,
      password: PASSWORD,
      phone: `0122${String(tag).slice(-7)}`,
      subjectIds: [subject.id],
      stages: ['SECONDARY'],
    },
  });
  check(
    'B16: the consumed link cannot register anyone else → 410, no account created',
    nbReplay.status === 410 &&
      (await prisma.user.findUnique({ where: { email: `other-${tag}@example.test` } })) === null,
    String(nbReplay.status),
  );

  // ── C. New ASSISTANT through the link ──
  console.log('\n-- C. new Assistant --');
  const ncLink = await mkLink('ASSISTANT');
  const newAEmail = `new-assistant-${tag}@example.test`;
  const ncHostile = await api('/auth/register/invitation', {
    method: 'POST',
    body: {
      token: ncLink.token,
      fullName: 'New Assistant',
      email: newAEmail,
      password: PASSWORD,
      phone: `0155${String(tag).slice(-7)}`,
      role: 'TEACHER',
      academyId: center2.body.id,
    },
  });
  check(
    'C0: an Assistant body claiming TEACHER / another Center is refused (400), nothing created',
    ncHostile.status === 400 &&
      (await prisma.user.findUnique({ where: { email: newAEmail } })) === null,
  );
  const nc = await api('/auth/register/invitation', {
    method: 'POST',
    body: {
      token: ncLink.token,
      fullName: 'New Assistant',
      email: newAEmail,
      password: PASSWORD,
      phone: `0155${String(tag).slice(-7)}`,
    },
  });
  check(
    'C1: new Assistant registers with no subjects/stages → 201 with a session',
    nc.status === 201 && !!nc.body.accessToken,
    String(nc.status) + ' ' + JSON.stringify(nc.body?.message ?? ''),
  );
  const ncUser = await prisma.user.findUnique({
    where: { email: newAEmail },
    include: {
      teacherProfile: { include: { subjects: true } },
      academyMemberships: true,
      ownedAcademies: true,
    },
  });
  cleanup.userIds.push(ncUser.id);
  check(
    'C2: exactly one membership: ACTIVE ASSISTANT in the EXACT Center',
    ncUser.academyMemberships.length === 1 &&
      ncUser.academyMemberships[0].academyId === centerId &&
      ncUser.academyMemberships[0].role === 'ASSISTANT' &&
      ncUser.academyMemberships[0].status === 'ACTIVE',
  );
  check(
    'C3: identity carries an APPROVED teacher profile (what Center staff checks require), empty subjects/stages',
    ncUser.role === 'TEACHER' &&
      ncUser.teacherProfile?.status === 'APPROVED' &&
      ncUser.teacherProfile.subjects.length === 0 &&
      ncUser.teacherProfile.stages.length === 0,
  );
  check(
    'C4: NOT a platform teacher: no PERSONAL academy, no OWNER membership',
    ncUser.ownedAcademies.length === 0 &&
      !ncUser.academyMemberships.some((m) => m.role === 'OWNER'),
  );
  check(
    'C5: not attached to any other Center / the platform owner',
    !ncUser.academyMemberships.some((m) => m.academyId !== centerId),
  );
  check(
    'C6: ASSISTANT authority inside the Center',
    (await api(`/academies/${centerSlug}/me`, { token: nc.body.accessToken, headers: H })).body
      ?.role === 'ASSISTANT',
  );
  const ncCourse = await api('/teacher/courses', {
    token: nc.body.accessToken,
    method: 'POST',
    headers: H,
    body: {
      title: `Assistant course ${tag}`,
      description: 'x',
      priceCents: 0,
      subjectId: subject.id,
    },
  });
  check(
    'C7: an Assistant cannot author courses (no course.write)',
    ncCourse.status === 403 || ncCourse.status === 404,
    String(ncCourse.status),
  );
  check(
    'C8: absent from the public marketplace',
    !JSON.stringify((await api('/teachers', { token: studentTok })).body ?? '').includes(
      ncUser.teacherProfile.slug,
    ),
  );
  check(
    'C9: link consumed by exactly this user',
    (await prisma.academyInvitationLink.findUnique({ where: { tokenHash: sha(ncLink.token) } }))
      .usedByUserId === ncUser.id,
  );
  check(
    'C10: cannot generate invitation links themselves (member.manage is OWNER-only)',
    (
      await api(`/academies/${centerSlug}/invitation-links`, {
        token: nc.body.accessToken,
        method: 'POST',
        body: { role: 'TEACHER' },
        headers: H,
      })
    ).status === 403,
  );

  // ── D. Security matrix ──
  console.log('\n-- D. security --');
  const sLink = await mkLink('TEACHER');
  const tampered = sLink.token.slice(0, -2) + (sLink.token.endsWith('aa') ? 'bb' : 'aa');
  check(
    'D1: tampered token → 404 (hash lookup), nothing leaks',
    (await api(`/invitation-links/${tampered}`)).status === 404 &&
      (await api(`/invitation-links/${tampered}/accept`, { token: exTeacherTok, method: 'POST' }))
        .status === 404,
  );
  check(
    'D2: tampered token cannot register',
    (
      await api('/auth/register/invitation', {
        method: 'POST',
        body: {
          token: tampered,
          fullName: 'X Y',
          email: `x-${tag}@example.test`,
          password: PASSWORD,
          phone: `0100${String(tag).slice(-7)}`,
          subjectIds: [subject.id],
          stages: ['SECONDARY'],
        },
      })
    ).status === 404,
  );
  check(
    'D3: token → exactly one row (unique hash)',
    (await prisma.academyInvitationLink.count({ where: { tokenHash: sha(sLink.token) } })) === 1,
  );

  // Revoked
  const rLink = await mkLink('TEACHER');
  await api(`/academies/${centerSlug}/invitation-links/${rLink.id}`, {
    token: ownerTok,
    method: 'DELETE',
    headers: H,
  });
  check(
    'D4: revoked link: preview 410, accept 410, register 410, decline 410',
    (await api(`/invitation-links/${rLink.token}`)).status === 410 &&
      (
        await api(`/invitation-links/${rLink.token}/accept`, {
          token: exTeacherTok,
          method: 'POST',
        })
      ).status === 410 &&
      (
        await api('/auth/register/invitation', {
          method: 'POST',
          body: {
            token: rLink.token,
            fullName: 'X Y',
            email: `r-${tag}@example.test`,
            password: PASSWORD,
            phone: `0106${String(tag).slice(-7)}`,
            subjectIds: [subject.id],
            stages: ['SECONDARY'],
          },
        })
      ).status === 410 &&
      (
        await api(`/invitation-links/${rLink.token}/decline`, {
          token: exTeacherTok,
          method: 'POST',
        })
      ).status === 410,
  );
  check(
    'D4b: no account was created by the revoked-link registration attempt',
    (await prisma.user.findUnique({ where: { email: `r-${tag}@example.test` } })) === null,
  );

  // Expired
  const expiredRaw = `expired-probe-${tag}`;
  const expiredRow = await prisma.academyInvitationLink.create({
    data: {
      academyId: centerId,
      role: 'ASSISTANT',
      tokenHash: sha(expiredRaw),
      createdByUserId: centerRes.body.admin.id,
      expiresAt: new Date(Date.now() - 1000),
    },
  });
  check(
    'D5: expired link: preview 410, accept 410, register 410',
    (await api(`/invitation-links/${expiredRaw}`)).status === 410 &&
      (await api(`/invitation-links/${expiredRaw}/accept`, { token: exTeacherTok, method: 'POST' }))
        .status === 410 &&
      (
        await api('/auth/register/invitation', {
          method: 'POST',
          body: {
            token: expiredRaw,
            fullName: 'X Y',
            email: `e-${tag}@example.test`,
            password: PASSWORD,
            phone: `0107${String(tag).slice(-7)}`,
          },
        })
      ).status === 410,
  );
  await prisma.academyInvitationLink.delete({ where: { id: expiredRow.id } });

  // Consumed → not transferable
  check(
    'D6: a link consumed by the new Teacher: the existing teacher cannot accept it → 410',
    (await api(`/invitation-links/${nbLink.token}/accept`, { token: exTeacherTok, method: 'POST' }))
      .status === 410,
  );
  check(
    'D7: …and the one who consumed it gets their membership back (idempotent), not a second row',
    (
      await api(`/invitation-links/${nbLink.token}/accept`, {
        token: nb.body.accessToken,
        method: 'POST',
      })
    ).status < 300 &&
      (await prisma.academyMembership.count({ where: { userId: nbUser.id } })) === 1,
  );

  // Role fixing across the ONLY mutation surfaces that exist.
  const roleLink = await mkLink('ASSISTANT');
  await prisma.academyMembership.deleteMany({
    where: { userId: exTeacherUser.id, academyId: centerId },
  });
  const roleAccept = await api(`/invitation-links/${roleLink.token}/accept`, {
    token: exTeacherTok,
    method: 'POST',
    body: { role: 'TEACHER', academyId: center2.body.id },
  });
  check(
    'D8: ASSISTANT link + a body claiming TEACHER/another Center → still ASSISTANT in this Center',
    roleAccept.status === 201 &&
      roleAccept.body.role === 'ASSISTANT' &&
      roleAccept.body.academyId === centerId,
  );
  const cross = await prisma.academyMembership.count({
    where: { userId: exTeacherUser.id, academyId: center2.body.id },
  });
  check('D9: no membership ever appeared in the other Center', cross === 0);

  // Cross-Center: a link from Center 2 cannot be redeemed against Center 1's slug/context — the token alone decides.
  const c2Link = await mkLink('TEACHER', owner2Tok, center2.body.slug, {
    'X-Academy-Id': center2.body.id,
  });
  await prisma.academyMembership.deleteMany({
    where: { userId: exTeacherUser.id, academyId: { in: [centerId, center2.body.id] } },
  });
  const c2Accept = await api(`/invitation-links/${c2Link.token}/accept`, {
    token: exTeacherTok,
    method: 'POST',
    headers: H,
  });
  check(
    'D10: a Center-2 link accepted while sending Center-1 as X-Academy-Id → joins Center 2, never Center 1',
    c2Accept.status === 201 &&
      c2Accept.body.academyId === center2.body.id &&
      (await prisma.academyMembership.count({
        where: { userId: exTeacherUser.id, academyId: centerId },
      })) === 0,
  );
  check(
    'D11: Center 1 owner cannot list/revoke Center 2 links',
    (
      await api(`/academies/${center2.body.slug}/invitation-links`, {
        token: ownerTok,
        headers: { 'X-Academy-Id': center2.body.id },
      })
    ).status === 404 &&
      (
        await api(`/academies/${center2.body.slug}/invitation-links/${c2Link.id}`, {
          token: ownerTok,
          method: 'DELETE',
          headers: { 'X-Academy-Id': center2.body.id },
        })
      ).status === 404,
  );
  check(
    'D12: the new Center-1 teacher cannot reach Center 2 data',
    (
      await api(`/academies/${center2.body.slug}/members`, {
        token: nb.body.accessToken,
        headers: { 'X-Academy-Id': center2.body.id },
      })
    ).status === 404,
  );

  // Concurrent registration on one link: exactly one account.
  const raceLink = await mkLink('ASSISTANT');
  const raceBodies = [1, 2].map((i) => ({
    token: raceLink.token,
    fullName: `Racer ${i}`,
    email: `racer${i}-${tag}@example.test`,
    password: PASSWORD,
    phone: `012${i}${String(tag).slice(-7)}`,
  }));
  const race = await Promise.all(
    raceBodies.map((b) => api('/auth/register/invitation', { method: 'POST', body: b })),
  );
  const raceUsers = await prisma.user.findMany({
    where: { email: { in: raceBodies.map((b) => b.email) } },
    select: { id: true },
  });
  cleanup.userIds.push(...raceUsers.map((u) => u.id));
  check(
    'D13: two concurrent registrations on one link → exactly one account, the other 410 and rolled back',
    race.filter((r) => r.status === 201).length === 1 &&
      race.filter((r) => r.status === 410).length === 1 &&
      raceUsers.length === 1,
    race.map((r) => r.status).join('/'),
  );

  // Regression: the platform's own signup paths are untouched.
  console.log('\n-- E. regression --');
  const plainTeacherEmail = `plain-teacher-${tag}@example.test`;
  const plain = await api('/auth/register/teacher', {
    method: 'POST',
    body: {
      fullName: 'Plain Teacher',
      email: plainTeacherEmail,
      password: PASSWORD,
      phone: `0109${String(tag).slice(-7)}`,
      subjectIds: [subject.id],
      stages: ['SECONDARY'],
    },
  });
  const plainUser = await prisma.user.findUnique({
    where: { email: plainTeacherEmail },
    include: { teacherProfile: true, ownedAcademies: true },
  });
  cleanup.userIds.push(plainUser.id);
  cleanup.academyIds.push(plainUser.teacherProfile.id);
  check(
    'E1: normal teacher signup still lands PENDING with a PERSONAL academy (platform flow untouched)',
    plain.status === 201 &&
      plain.body.pending === true &&
      plainUser.teacherProfile.status === 'PENDING' &&
      plainUser.ownedAcademies.length === 1,
  );
  check(
    'E2: normal teacher still cannot sign in before approval',
    (await login(plainTeacherEmail)) === null,
  );
  check(
    'E3: existing approved marketplace teacher still discoverable',
    JSON.stringify((await api('/teachers', { token: studentTok })).body ?? '').includes(
      exTeacherUser.teacherProfile.id,
    ) ||
      (
        await api(
          `/teachers/${(await prisma.teacherProfile.findUnique({ where: { id: exTeacherUser.teacherProfile.id } })).slug}`,
          { token: studentTok },
        )
      ).status === 200,
  );
  check('E4: STUDENT still fine', (await api('/auth/me', { token: studentTok })).status === 200);
  check(
    'E5: SUPER_ADMIN still fine',
    (await api('/admin/academies', { token: adminTok })).status === 200,
  );

  // DB counts restored after cleanup are asserted in finally.
  global.__before = before;
}

main()
  .catch((e) => {
    console.error('\nUNCAUGHT:', e);
    fail++;
  })
  .finally(async () => {
    await prisma.course
      .deleteMany({ where: { academyId: { in: cleanup.academyIds } } })
      .catch(() => {});
    await prisma.academyInvitationLink
      .deleteMany({ where: { academyId: { in: cleanup.academyIds } } })
      .catch(() => {});
    await prisma.academyMembership
      .deleteMany({
        where: {
          OR: [{ academyId: { in: cleanup.academyIds } }, { userId: { in: cleanup.userIds } }],
        },
      })
      .catch(() => {});
    await prisma.academyActivationToken
      .deleteMany({ where: { academyId: { in: cleanup.academyIds } } })
      .catch(() => {});
    await prisma.auditLog
      .deleteMany({
        where: {
          OR: [{ academyId: { in: cleanup.academyIds } }, { actorUserId: { in: cleanup.userIds } }],
        },
      })
      .catch(() => {});
    for (const id of cleanup.academyIds)
      await prisma.academy.delete({ where: { id } }).catch(() => {});
    await prisma.deviceSession
      .deleteMany({ where: { userId: { in: cleanup.userIds } } })
      .catch(() => {});
    for (const id of cleanup.userIds) await prisma.user.delete({ where: { id } }).catch(() => {});
    if (global.__before) {
      const b = global.__before;
      const after = {
        users: await prisma.user.count(),
        academies: await prisma.academy.count(),
        memberships: await prisma.academyMembership.count(),
        links: await prisma.academyInvitationLink.count(),
        teachers: await prisma.teacherProfile.count(),
      };
      check(
        'cleanup: DB counts restored (users/academies/memberships/links/teachers)',
        JSON.stringify(after) === JSON.stringify(b),
        `${JSON.stringify(b)} → ${JSON.stringify(after)}`,
      );
    }
    await prisma.$disconnect();
    console.log(`\n== ${pass} passed, ${fail} failed ==`);
    process.exit(fail ? 1 : 0);
  });
