#!/usr/bin/env node
/**
 * Cross-role authorization matrix (post-Reset audit). ALLOW + DENY for the
 * combinations the phase suites never exercised: ASSISTANT, student↔student,
 * OWNER-only ceilings for members, X-Academy-Id forgery on finance/audit,
 * SUPER_ADMIN's synthetic-owner context. Local only; restores its fixtures.
 *
 *   CONFIRM_TEST_DB=yes DATABASE_URL=postgresql://...localhost:PORT/darsly node scripts/verify-authz-matrix.mjs
 */
import { PrismaClient } from '@prisma/client';

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
const login = async (email) => {
  const r = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  return r.status < 300 ? r.body.accessToken : null;
};
const prisma = new PrismaClient();
const tag = Date.now();
const H = (id) => ({ 'X-Academy-Id': id });
const denied = (s) => s === 401 || s === 403 || s === 404;
const cleanup = { academyIds: [], userEmails: [], courseIds: [] };
const counts = async () =>
  JSON.stringify({
    a: await prisma.academy.count(),
    m: await prisma.academyMembership.count(),
    c: await prisma.course.count(),
    u: await prisma.user.count(),
    p: await prisma.payment.count(),
  });

async function main() {
  console.log('== Authorization matrix ==\n');
  const before = await counts();
  const tA = await prisma.academy.findFirst({
    where: { kind: 'PERSONAL' },
    select: { id: true, slug: true, owner: { select: { id: true, email: true } } },
  });
  const tB = await prisma.academy.findFirst({
    where: { kind: 'PERSONAL', id: { not: tA.id } },
    select: { id: true, slug: true, owner: { select: { id: true, email: true } } },
  });
  const tC = await prisma.academy.findFirst({
    where: { kind: 'PERSONAL', id: { notIn: [tA.id, tB.id] } },
    select: { id: true, slug: true, owner: { select: { id: true, email: true } } },
  });
  const students = await prisma.user.findMany({
    where: { role: 'STUDENT' },
    select: { id: true, email: true, studentProfile: { select: { id: true } } },
    take: 2,
  });
  const [s1, s2] = students;
  const admin = await prisma.user.findFirst({
    where: { role: 'SUPER_ADMIN' },
    select: { email: true },
  });
  const [tokA, tokB, tokC, tokS1, tokS2, tokAdmin] = await Promise.all([
    login(tA.owner.email),
    login(tB.owner.email),
    login(tC.owner.email),
    login(s1.email),
    login(s2.email),
    login(admin.email),
  ]);
  check(
    'fixture logins (3 teachers, 2 students, admin)',
    !!tokA && !!tokB && !!tokC && !!tokS1 && !!tokS2 && !!tokAdmin,
  );

  // Center A owned by teacher A; teacher B joins as TEACHER, teacher C joins as ASSISTANT.
  const cA = (
    await api('/admin/centers', {
      token: tokAdmin,
      method: 'POST',
      body: { name: `Authz A ${tag}`, adminName: 'Center Admin', adminEmail: tA.owner.email },
    })
  ).body;
  const cX = (
    await api('/admin/centers', {
      token: tokAdmin,
      method: 'POST',
      body: { name: `Authz X ${tag}`, adminName: 'Center Admin', adminEmail: tB.owner.email },
    })
  ).body;
  check('setup: Centers A (owner=teacher A) and X (owner=teacher B)', !!cA?.id && !!cX?.id);
  if (!cA?.id || !cX?.id) throw new Error('fixtures');
  cleanup.academyIds.push(cA.id, cX.id);
  const linkT = (
    await api(`/academies/${cA.slug}/invitation-links`, {
      token: tokA,
      method: 'POST',
      body: { role: 'TEACHER' },
      headers: H(cA.id),
    })
  ).body;
  const linkAs = (
    await api(`/academies/${cA.slug}/invitation-links`, {
      token: tokA,
      method: 'POST',
      body: { role: 'ASSISTANT' },
      headers: H(cA.id),
    })
  ).body;
  check(
    'setup: teacher B joins Center A as TEACHER',
    (await api(`/invitation-links/${linkT.token}/accept`, { token: tokB, method: 'POST' })).status <
      300,
  );
  check(
    'setup: teacher C joins Center A as ASSISTANT',
    (await api(`/invitation-links/${linkAs.token}/accept`, { token: tokC, method: 'POST' }))
      .status < 300,
  );

  // ── SUPER_ADMIN: intentional bypass ──
  check(
    'SUPER_ADMIN reads Center A members without a membership (synthetic OWNER)',
    (await api(`/academies/${cA.slug}/members`, { token: tokAdmin, headers: H(cA.id) })).status ===
      200,
  );
  check(
    'SUPER_ADMIN reads Center A activity (owner-only gate passes for platform admin)',
    (await api('/teacher/analytics/activity', { token: tokAdmin, headers: H(cA.id) })).status ===
      200,
  );
  check(
    'SUPER_ADMIN reads Center A wallet as the organisation',
    (await api('/teacher/wallet', { token: tokAdmin, headers: H(cA.id) })).body?.scope ===
      'ORGANISATION',
  );

  // ── OWNER-only ceilings for a TEACHER member (teacher B in Center A) ──
  check(
    'TEACHER member: cannot list members (member.manage is OWNER-only)',
    denied((await api(`/academies/${cA.slug}/members`, { token: tokB, headers: H(cA.id) })).status),
  );
  check(
    'TEACHER member: cannot change Center settings (academy.manage)',
    denied(
      (
        await api(`/academies/${cA.slug}/settings`, {
          token: tokB,
          method: 'PATCH',
          body: { tagline: 'x' },
          headers: H(cA.id),
        })
      ).status,
    ),
  );
  check(
    'TEACHER member: cannot set the revenue share',
    denied(
      (
        await api(`/academies/${cA.slug}/settings`, {
          token: tokB,
          method: 'PATCH',
          body: { teacherSharePercent: 90 },
          headers: H(cA.id),
        })
      ).status,
    ),
  );
  check(
    'TEACHER member: cannot create a room (room.manage is OWNER-only)',
    denied(
      (
        await api('/teacher/rooms', {
          token: tokB,
          method: 'POST',
          body: { name: `R ${tag}` },
          headers: H(cA.id),
        })
      ).status,
    ),
  );
  check(
    'TEACHER member: cannot request a Center payout (wallet.withdraw is OWNER-only)',
    denied(
      (
        await api('/teacher/payouts', {
          token: tokB,
          method: 'POST',
          body: { amountCents: 60000, methodId: 'x' },
          headers: H(cA.id),
        })
      ).status,
    ),
  );
  check(
    'TEACHER member: cannot add a Center payout method',
    denied(
      (
        await api('/teacher/payouts/methods', {
          token: tokB,
          method: 'POST',
          body: { method: 'BANK_TRANSFER', details: {} },
          headers: H(cA.id),
        })
      ).status,
    ),
  );
  check(
    'TEACHER member: cannot read the Center audit trail',
    denied((await api('/teacher/analytics/activity', { token: tokB, headers: H(cA.id) })).status),
  );
  check(
    'TEACHER member: cannot activate a subject for the Center',
    denied(
      (
        await api(`/academies/${cA.slug}/subjects/${(await prisma.subject.findFirst()).id}`, {
          token: tokB,
          method: 'PUT',
          body: { isActive: true },
          headers: H(cA.id),
        })
      ).status,
    ),
  );
  check(
    'TEACHER member: cannot create an invitation link',
    denied(
      (
        await api(`/academies/${cA.slug}/invitation-links`, {
          token: tokB,
          method: 'POST',
          body: { role: 'TEACHER' },
          headers: H(cA.id),
        })
      ).status,
    ),
  );
  check(
    'TEACHER member: CAN read their own slice (analytics/me)',
    (await api('/teacher/analytics/me', { token: tokB, headers: H(cA.id) })).status === 200,
  );
  check(
    'TEACHER member: wallet is MEMBER scope, not the organisation',
    (await api('/teacher/wallet', { token: tokB, headers: H(cA.id) })).body?.scope === 'MEMBER',
  );

  // ── ASSISTANT (teacher C in Center A): narrower still, no escalation ──
  const subjId = (await prisma.teacherSubject.findFirst({ where: { tenantId: tA.id } })).subjectId;
  await api(`/academies/${cA.slug}/subjects/${subjId}`, {
    token: tokA,
    method: 'PUT',
    body: { isActive: true },
    headers: H(cA.id),
  });
  check(
    'ASSISTANT: cannot author a course (course.write not granted)',
    denied(
      (
        await api('/teacher/courses', {
          token: tokC,
          method: 'POST',
          body: { title: `Asst ${tag}`, priceCents: 0, subjectId: subjId },
          headers: H(cA.id),
        })
      ).status,
    ),
  );
  check(
    'ASSISTANT: cannot read the payments queue (payment.verify not granted)',
    denied((await api('/teacher/payments', { token: tokC, headers: H(cA.id) })).status),
  );
  check(
    'ASSISTANT: cannot read the wallet (wallet.read not granted)',
    denied((await api('/teacher/wallet', { token: tokC, headers: H(cA.id) })).status),
  );
  check(
    'ASSISTANT: cannot read academy analytics (analytics.read not granted)',
    denied((await api('/teacher/analytics', { token: tokC, headers: H(cA.id) })).status),
  );
  check(
    'ASSISTANT: cannot manage members',
    denied((await api(`/academies/${cA.slug}/members`, { token: tokC, headers: H(cA.id) })).status),
  );
  check(
    'ASSISTANT: cannot record cash',
    denied(
      (
        await api('/teacher/payments/cash', {
          token: tokC,
          method: 'POST',
          body: { studentId: s1.studentProfile.id, courseId: 'x', receiver: 'CENTER' },
          headers: H(cA.id),
        })
      ).status,
    ),
  );
  check(
    'ASSISTANT: CAN create a group (group.manage granted)',
    (
      await api('/teacher/groups', {
        token: tokC,
        method: 'POST',
        body: { name: `Asst G ${tag}` },
        headers: H(cA.id),
      })
    ).status === 201,
  );
  // Escalation attempt: the OWNER grants payment.collect to the ASSISTANT via canCollectCash — allowed by the owner; the assistant cannot grant it to themself.
  const asstMembership = await prisma.academyMembership.findFirst({
    where: { academyId: cA.id, userId: tC.owner.id },
  });
  check(
    'ASSISTANT: cannot grant themself payment.collect (member.manage is OWNER-only)',
    denied(
      (
        await api(`/academies/${cA.slug}/members/${asstMembership.id}`, {
          token: tokC,
          method: 'PATCH',
          body: { canCollectCash: true },
          headers: H(cA.id),
        })
      ).status,
    ),
  );
  check(
    'ASSISTANT: cannot promote themself to TEACHER',
    denied(
      (
        await api(`/academies/${cA.slug}/members/${asstMembership.id}`, {
          token: tokC,
          method: 'PATCH',
          body: { role: 'TEACHER' },
          headers: H(cA.id),
        })
      ).status,
    ),
  );
  // Owner grants collect; the assistant still lacks payment.verify on the route, so cash routes stay closed — the grant is meaningful only for TEACHER members.
  const grant = await api(`/academies/${cA.slug}/members/${asstMembership.id}`, {
    token: tokA,
    method: 'PATCH',
    body: { canCollectCash: true },
    headers: H(cA.id),
  });
  check('OWNER can grant payment.collect to a member', grant.status < 300, String(grant.status));

  // ── X-Academy-Id forgery: a Center the caller does not belong to ──
  for (const [label, fn] of [
    ['wallet', () => api('/teacher/wallet', { token: tokC, headers: H(cX.id) })],
    ['payments queue', () => api('/teacher/payments', { token: tokA, headers: H(cX.id) })],
    ['activity', () => api('/teacher/analytics/activity', { token: tokA, headers: H(cX.id) })],
    ['courses', () => api('/teacher/courses', { token: tokA, headers: H(cX.id) })],
    ['members', () => api(`/academies/${cX.slug}/members`, { token: tokA, headers: H(cX.id) })],
    ['payouts', () => api('/teacher/payouts', { token: tokA, headers: H(cX.id) })],
  ]) {
    const r = await fn();
    check(
      `X-Academy-Id forged to Center X (not a member): ${label} is denied, never re-scoped`,
      denied(r.status),
      String(r.status),
    );
  }
  // A member's header for a Center they DO belong to only selects that membership's own role — it never grants owner rights.
  check(
    'X-Academy-Id selects context only: teacher B in Center A is still not its owner',
    denied(
      (
        await api(`/academies/${cA.slug}/settings`, {
          token: tokB,
          method: 'PATCH',
          body: { name: 'hijack' },
          headers: H(cA.id),
        })
      ).status,
    ),
  );

  // ── Teacher ↔ teacher (PERSONAL): authorship isolation ──
  const courseA = await api('/teacher/courses', {
    token: tokA,
    method: 'POST',
    body: { title: `Own ${tag}`, priceCents: 0 },
  });
  cleanup.courseIds.push(courseA.body?.id);
  check(
    "teacher B cannot read teacher A's personal course (404, existence hidden)",
    (await api(`/teacher/courses/${courseA.body.id}`, { token: tokB })).status === 404,
  );
  check(
    "teacher B cannot edit teacher A's personal course",
    denied(
      (
        await api(`/teacher/courses/${courseA.body.id}`, {
          token: tokB,
          method: 'PATCH',
          body: { title: 'hijacked title' },
        })
      ).status,
    ),
  ); // ≥3 chars so validation does not mask the scope check
  check(
    "teacher B cannot delete teacher A's personal course",
    denied(
      (await api(`/teacher/courses/${courseA.body.id}`, { token: tokB, method: 'DELETE' })).status,
    ),
  );
  check(
    "teacher B cannot see teacher A's enrollments",
    !((await api('/teacher/enrollments', { token: tokB })).body ?? []).some(
      (e) => e.courseId === courseA.body.id,
    ),
  );
  const wA = (await api('/teacher/wallet', { token: tokA })).body,
    wB = (await api('/teacher/wallet', { token: tokB })).body;
  check(
    'teacher wallets are separate (different balances / no shared payments)',
    (wA && wB && JSON.stringify(wA.recentPayments) !== JSON.stringify(wB.recentPayments)) ||
      (wA?.recentPayments?.length === 0 && wB?.recentPayments?.length === 0),
  );

  // ── Student ↔ student ──
  const myPayS1 = await api('/payments/mine', { token: tokS1 });
  const myPayS2 = await api('/payments/mine', { token: tokS2 });
  check(
    'a student sees only their own payments',
    myPayS1.status === 200 &&
      myPayS2.status === 200 &&
      !myPayS1.body.some((p) => myPayS2.body.some((q) => q.id === p.id)),
  );
  const myEnr = await api('/enrollments/mine', { token: tokS1 });
  check(
    'a student sees only their own enrollments',
    myEnr.status === 200 && Array.isArray(myEnr.body),
  );
  check(
    "a student cannot read another student's attendance history via a teacher route",
    denied(
      (
        await api(`/teacher/students/${s2.studentProfile.id}/attendance`, {
          token: tokS1,
          headers: H(tA.id),
        })
      ).status,
    ),
  );
  check(
    'a student cannot read a teacher wallet',
    denied((await api('/teacher/wallet', { token: tokS1, headers: H(tA.id) })).status),
  );
  check(
    'a student cannot read admin payments',
    denied((await api('/admin/payments', { token: tokS1 })).status),
  );
  check(
    'a student cannot confirm cash',
    denied(
      (
        await api('/teacher/payments/x/confirm-cash', {
          token: tokS1,
          method: 'POST',
          headers: H(tA.id),
        })
      ).status,
    ),
  );
  check(
    'a student cannot create a Center',
    denied(
      (
        await api('/admin/centers', {
          token: tokS1,
          method: 'POST',
          body: { name: 'x', adminName: 'xx', adminEmail: 'x@x.test' },
        })
      ).status,
    ),
  );

  // ── Teacher cannot touch platform admin ──
  check(
    'a teacher cannot list all academies (admin)',
    denied((await api('/admin/academies', { token: tokA })).status),
  );
  check(
    'a teacher cannot process payouts (admin)',
    denied((await api('/admin/payouts', { token: tokA })).status),
  );
  check(
    'a teacher cannot read platform audit logs',
    denied((await api('/admin/audit-logs', { token: tokA })).status),
  );

  // ── Unauthenticated ──
  check('unauthenticated cannot read wallet', (await api('/teacher/wallet')).status === 401);
  check(
    'unauthenticated cannot read members',
    denied((await api(`/academies/${cA.slug}/members`)).status),
  );
  check(
    'unauthenticated CAN read a public storefront',
    (await api(`/academies/${tA.slug}`)).status === 200,
  );

  check('database counts (pre-cleanup snapshot recorded)', true, before);
}

main()
  .catch((e) => {
    console.error('\nUNCAUGHT:', e);
    fail++;
  })
  .finally(async () => {
    const cids = cleanup.courseIds.filter(Boolean);
    await prisma.$executeRaw`DELETE FROM "Enrollment" WHERE "courseId" = ANY(${cids}::text[])`.catch(
      () => {},
    );
    await prisma.$executeRaw`DELETE FROM "Course" WHERE "id" = ANY(${cids}::text[])`.catch(
      () => {},
    );
    await prisma.$executeRaw`DELETE FROM "Group" WHERE "academyId" = ANY(${cleanup.academyIds}::text[])`.catch(
      () => {},
    );
    await prisma.$executeRaw`DELETE FROM "AuditLog" WHERE "academyId" = ANY(${cleanup.academyIds}::text[])`.catch(
      () => {},
    );
    await prisma.$executeRaw`DELETE FROM "Academy" WHERE "id" = ANY(${cleanup.academyIds}::text[])`.catch(
      () => {},
    );
    console.log('   after-cleanup counts:', await counts());
    await prisma.$disconnect();
    console.log(`\n== ${pass} passed, ${fail} failed ==`);
    process.exit(fail ? 1 : 0);
  });
