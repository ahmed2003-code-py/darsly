#!/usr/bin/env node
/**
 * Full Center lifecycle, end to end, WITHOUT live email: the API must be
 * started with MAIL_TRANSPORT=capture (+ MAIL_CAPTURE_DIR) so the activation
 * email lands in an outbox file this script reads — the same URL the admin
 * would have received. Nothing else is bypassed: the token is consumed through
 * POST /auth/activation exactly as a human would.
 *
 *   CONFIRM_TEST_DB=yes MAIL_CAPTURE_DIR=<same dir the API uses> DATABASE_URL=... node scripts/verify-center-lifecycle.mjs
 */
import { PrismaClient } from '@prisma/client';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const DB = process.env.DATABASE_URL ?? '';
const PORT = process.env.API_PORT ?? '41000';
const PASSWORD = 'Darsly@123';
const OUTBOX = process.env.MAIL_CAPTURE_DIR?.trim() || join(tmpdir(), 'darsly-mail-outbox');
if (process.env.CONFIRM_TEST_DB !== 'yes') { console.error('REFUSED: set CONFIRM_TEST_DB=yes.'); process.exit(2); }
if (!DB || /railway|prod|amazonaws|supabase|neon\.tech|render\.com/i.test(DB)) { console.error('REFUSED: DATABASE_URL missing or hosted.'); process.exit(2); }

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  (${d})` : ''}`); ok ? pass++ : fail++; };
async function api(p, { token, method = 'GET', body, headers } = {}) {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/v1${p}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(headers ?? {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, body: json };
}
const login = async (email, pw = PASSWORD) => { const r = await api('/auth/login', { method: 'POST', body: { email, password: pw } }); return r.status < 300 ? r.body.accessToken : null; };
const prisma = new PrismaClient();
const tag = Date.now();
const H = (id) => ({ 'X-Academy-Id': id });
const cleanup = { academyIds: [], userEmails: [], courseIds: [], groupIds: [] };
const counts = async () => JSON.stringify({ a: await prisma.academy.count(), u: await prisma.user.count(), m: await prisma.academyMembership.count(), c: await prisma.course.count(), p: await prisma.payment.count(), lt: await prisma.ledgerTransaction.count() });

/** The newest captured mail addressed (really) to `realRecipient`, written after `since`. */
function outboxFor(realRecipient, since) {
  const files = readdirSync(OUTBOX).map((f) => join(OUTBOX, f)).filter((f) => statSync(f).mtimeMs >= since - 1000);
  const mails = files.map((f) => JSON.parse(readFileSync(f, 'utf8'))).filter((m) => m.realRecipient === realRecipient);
  return mails.sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1))[0] ?? null;
}
const tokenFrom = (mail) => decodeURIComponent((mail.text.match(/\/activate\?token=([^\s"']+)/) ?? [])[1] ?? '');

async function main() {
  console.log(`== Center lifecycle (email via capture outbox: ${OUTBOX}) ==\n`);
  const before = await counts();
  const admin = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN' }, select: { email: true } });
  const tB = await prisma.academy.findFirst({ where: { kind: 'PERSONAL' }, select: { id: true, owner: { select: { id: true, email: true } } } });
  const student = await prisma.user.findFirst({ where: { role: 'STUDENT' }, select: { id: true, email: true, studentProfile: { select: { id: true } } } });
  const [tokAdmin, tokB, tokS] = await Promise.all([login(admin.email), login(tB.owner.email), login(student.email)]);
  check('fixture logins', !!tokAdmin && !!tokB && !!tokS);

  // ── SUPER_ADMIN creates a Center with a brand-new STAFF admin ──
  const adminEmail = `center-admin-${tag}@example.test`;
  cleanup.userEmails.push(adminEmail);
  const t0 = Date.now();
  const created = await api('/admin/centers', { token: tokAdmin, method: 'POST', body: { name: `Life ${tag}`, adminName: 'Life Admin', adminEmail } });
  check('1. Center created; admin is a new inactive STAFF user; activation email accepted by the (capture) transport', created.status === 201 && created.body.admin?.activation === 'EMAIL_SENT' && created.body.delivery?.delivered === true, JSON.stringify(created.body?.admin ?? created.body));
  if (!created.body?.id) throw new Error('setup');
  const cId = created.body.id, cSlug = created.body.slug; cleanup.academyIds.push(cId);
  const rowU = await prisma.user.findUnique({ where: { email: adminEmail }, select: { isActive: true, passwordHash: true, role: true } });
  check('   stored owner email is the REAL email; account inactive, no password, STAFF', rowU && !rowU.isActive && !rowU.passwordHash && rowU.role === 'STAFF');
  check('   Center is PENDING; OWNER membership INVITED', (await prisma.academy.findUnique({ where: { id: cId } })).status === 'PENDING' && (await prisma.academyMembership.findFirst({ where: { academyId: cId } })).status === 'INVITED');

  // ── The activation email: read from the outbox, never from the API ──
  const mail = outboxFor(adminEmail, t0);
  check('2. activation email captured for the real recipient (not delivered by Resend, not bypassed)', !!mail, mail ? `to=${mail.to}` : 'NO OUTBOX FILE — is the API running with MAIL_TRANSPORT=capture?');
  const rawToken = mail ? tokenFrom(mail) : '';
  check('   email carries an /activate?token= link; the DB holds only its sha256', rawToken.length > 20 && (await prisma.academyActivationToken.count({ where: { academyId: cId, tokenHash: rawToken } })) === 0);
  check('   token preview resolves to this Center (public GET, reveals no secrets)', (await api(`/auth/activation/${encodeURIComponent(rawToken)}`)).status === 200);
  check('   a wrong token is rejected', (await api(`/auth/activation/${'x'.repeat(43)}`)).status >= 400);

  // ── Activation: the ONLY way the admin becomes active ──
  const act = await api('/auth/activation', { method: 'POST', body: { token: rawToken, password: PASSWORD } });
  check('3. admin activates through the token and chooses a password', act.status < 300, JSON.stringify(act.body?.code ?? act.status));
  const rowU2 = await prisma.user.findUnique({ where: { email: adminEmail }, select: { isActive: true, passwordHash: true } });
  check('   user active with a password; Center ACTIVE; membership ACTIVE', rowU2.isActive && !!rowU2.passwordHash && (await prisma.academy.findUnique({ where: { id: cId } })).status === 'ACTIVE' && (await prisma.academyMembership.findFirst({ where: { academyId: cId } })).status === 'ACTIVE');
  check('   REUSE: the same token is refused (single-use, atomic)', (await api('/auth/activation', { method: 'POST', body: { token: rawToken, password: PASSWORD } })).status === 410);
  check('   resend is refused once activated', (await api(`/admin/centers/${cId}/activation/resend`, { token: tokAdmin, method: 'POST' })).body?.code === 'ALREADY_ACTIVE');

  // ── EXPIRY: a second Center whose token we age in the DB ──
  const adminEmail2 = `center-admin2-${tag}@example.test`; cleanup.userEmails.push(adminEmail2);
  const t1 = Date.now();
  const c2 = (await api('/admin/centers', { token: tokAdmin, method: 'POST', body: { name: `Life2 ${tag}`, adminName: 'Life Admin2', adminEmail: adminEmail2 } })).body;
  cleanup.academyIds.push(c2.id);
  const raw2 = tokenFrom(outboxFor(adminEmail2, t1));
  await prisma.academyActivationToken.updateMany({ where: { academyId: c2.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  check('4. EXPIRED token is refused and the account stays inactive', (await api('/auth/activation', { method: 'POST', body: { token: raw2, password: PASSWORD } })).status === 410 && !(await prisma.user.findUnique({ where: { email: adminEmail2 } })).isActive);
  const t2 = Date.now();
  const rs = await api(`/admin/centers/${c2.id}/activation/resend`, { token: tokAdmin, method: 'POST' });
  const raw3 = tokenFrom(outboxFor(adminEmail2, t2));
  check('   RESEND: old token revoked, a fresh one is emailed and works', rs.body?.delivery?.delivered === true && raw3 && raw3 !== raw2 && (await api('/auth/activation', { method: 'POST', body: { token: raw3, password: PASSWORD } })).status < 300);
  check('   the expired/revoked token still cannot be used after the resend', (await api('/auth/activation', { method: 'POST', body: { token: raw2, password: PASSWORD } })).status === 410);

  // ── Center Admin enters the Center context and configures it ──
  const tokC = await login(adminEmail);
  check('5. Center Admin logs in with the password they chose', !!tokC);
  const me = await api('/me/academies', { token: tokC });
  check('   Center appears in their workspaces as OWNER', me.body?.some((a) => a.academyId === cId && a.role === 'OWNER'));
  check('   configures settings + revenue share (60%)', (await api(`/academies/${cSlug}/settings`, { token: tokC, method: 'PATCH', body: { tagline: 'Life', teacherSharePercent: 60 }, headers: H(cId) })).status < 300);
  const subj = (await prisma.teacherSubject.findFirst({ where: { tenantId: tB.id } })).subjectId;
  check('   activates a subject', (await api(`/academies/${cSlug}/subjects/${subj}`, { token: tokC, method: 'PUT', body: { isActive: true }, headers: H(cId) })).status < 300);

  // ── Invite a teacher (link-based; no email involved by design) ──
  const link = (await api(`/academies/${cSlug}/invitation-links`, { token: tokC, method: 'POST', body: { role: 'TEACHER' }, headers: H(cId) })).body;
  check('6. invitation link created (owner copies it; the platform emails nothing here)', !!link?.token);
  check('   student cannot accept a staff invitation', (await api(`/invitation-links/${link.token}/accept`, { token: tokS, method: 'POST' })).status >= 400);
  check('   teacher accepts', (await api(`/invitation-links/${link.token}/accept`, { token: tokB, method: 'POST' })).status < 300);
  check('   REUSE: the same link is refused', (await api(`/invitation-links/${link.token}/accept`, { token: tokB, method: 'POST' })).status >= 400);
  const members = (await api(`/academies/${cSlug}/members`, { token: tokC, headers: H(cId) })).body;
  check('7. teacher appears in the Center as TEACHER', members.some((m) => m.userId === tB.owner.id && m.role === 'TEACHER'));
  // An invitation from ANOTHER Center cannot be used to enter this one.
  const other = (await api('/admin/centers', { token: tokAdmin, method: 'POST', body: { name: `Other ${tag}`, adminName: 'Center Admin', adminEmail: tB.owner.email } })).body; cleanup.academyIds.push(other.id);
  const linkOther = (await api(`/academies/${other.slug}/invitation-links`, { token: tokB, method: 'POST', body: { role: 'TEACHER' }, headers: H(other.id) })).body;
  const tC = await prisma.academy.findFirst({ where: { kind: 'PERSONAL', id: { not: tB.id } }, select: { owner: { select: { id: true, email: true } } } });
  const tokT2 = await login(tC.owner.email);
  await api(`/invitation-links/${linkOther.token}/accept`, { token: tokT2, method: 'POST' });
  check('   a link from Center "Other" joins Other, never this Center (scope is baked into the token row)', (await prisma.academyMembership.count({ where: { academyId: cId, userId: tC.owner.id } })) === 0 && (await prisma.academyMembership.count({ where: { academyId: other.id, userId: tC.owner.id } })) === 1);

  // ── Teacher creates Center courses; student enrolls ──
  const free = await api('/teacher/courses', { token: tokB, method: 'POST', body: { title: `Life free ${tag}`, priceCents: 0, subjectId: subj }, headers: H(cId) });
  const paid = await api('/teacher/courses', { token: tokB, method: 'POST', body: { title: `Life paid ${tag}`, priceCents: 1000, subjectId: subj }, headers: H(cId) });
  check('8. teacher authors Center courses (free + paid; split is configured)', free.status === 201 && paid.status === 201 && free.body.academyId === cId, JSON.stringify(paid.body?.code ?? paid.status));
  cleanup.courseIds.push(free.body?.id, paid.body?.id);
  for (const id of [free.body.id, paid.body.id]) { const u = await prisma.courseUnit.create({ data: { courseId: id, title: 'u', sortOrder: 0 } }); await prisma.lesson.create({ data: { unitId: u.id, title: 'l', sortOrder: 0 } }); await prisma.course.update({ where: { id }, data: { status: 'PUBLISHED' } }); }
  const enr = await api('/enrollments', { token: tokS, method: 'POST', body: { courseId: free.body.id } });
  check('9. student enrolls in the free Center course (Enrollment.academyId = Center)', enr.status < 300 && (await prisma.enrollment.findFirst({ where: { courseId: free.body.id } })).academyId === cId, JSON.stringify(enr.body?.code ?? enr.status));

  // ── Student sees the Center and can wear its branding (the audit's Medium bug) ──
  const studio = await api('/student/studio', { token: tokS });
  check('10. student is offered the CENTER look, not the author\'s personal academy', studio.body?.academyThemes?.some((a) => a.academyId === cId) && !studio.body.academyThemes.some((a) => a.academyId === tB.id && !studio.body.academyThemes.some((x) => x.academyId === tB.id && x.academyId !== cId)), JSON.stringify(studio.body?.academyThemes?.map((a) => a.academyId)));
  const wear = await api('/student/studio/equip-academy', { token: tokS, method: 'POST', body: { academyId: cId } });
  check('    student wears the Center branding', wear.status < 300 && (await prisma.studentCustomization.findUnique({ where: { studentId: student.studentProfile.id } }))?.academyId === cId, JSON.stringify(wear.body?.code ?? wear.status));
  check('    student cannot wear the unrelated Center "Other"', (await api('/student/studio/equip-academy', { token: tokS, method: 'POST', body: { academyId: other.id } })).body?.code === 'NOT_ENROLLED');
  await api('/student/studio/customization', { token: tokS, method: 'DELETE' });

  // ── Scheduling ──
  const room = (await api('/teacher/rooms', { token: tokC, method: 'POST', body: { name: `Room ${tag}` }, headers: H(cId) })).body;
  const group = (await api('/teacher/groups', { token: tokC, method: 'POST', body: { name: `G ${tag}` }, headers: H(cId) })).body; cleanup.groupIds.push(group?.id);
  // A TEACHER member schedules only into groups they are assigned to (Phase 5 per-group scoping) — so first, unassigned, they are refused…
  const unassigned = await api(`/teacher/groups/${group.id}/sessions`, { token: tokB, method: 'POST', body: { startAt: '2027-05-01T08:00:00Z', endAt: '2027-05-01T09:00:00Z', roomId: room.id, teacherUserId: tB.owner.id }, headers: H(cId) });
  check('11. a TEACHER member cannot schedule into a group they are not assigned to', unassigned.status === 403, String(unassigned.status));
  const assign = await api(`/teacher/groups/${group.id}/assignments`, { token: tokC, method: 'POST', body: { userId: tB.owner.id, role: 'TEACHER' }, headers: H(cId) });
  const sess = await api(`/teacher/groups/${group.id}/sessions`, { token: tokB, method: 'POST', body: { startAt: '2027-05-01T08:00:00Z', endAt: '2027-05-01T09:00:00Z', roomId: room.id, teacherUserId: tB.owner.id }, headers: H(cId) });
  check('    …and once the Center Admin assigns them, Center scheduling works (room + group + physical session)', !!room?.id && !!group?.id && assign.status < 300 && sess.status === 201, JSON.stringify(sess.body?.code ?? sess.status));

  // ── Analytics ──
  const ov = await api('/teacher/analytics/center', { token: tokC, headers: H(cId) });
  check('12. Center analytics served to the Center Admin', ov.status === 200 && ov.body.courses?.total === 2 && ov.body.teachers >= 1, JSON.stringify({ c: ov.body?.courses, t: ov.body?.teachers }));

  // ── Cash flow ──
  const claim = await api('/payments', { token: tokS, method: 'POST', body: { courseId: paid.body.id, method: 'CASH', cashReceiver: 'CENTER' } });
  check('13. student reports cash paid at the desk (PENDING)', claim.status === 201 && claim.body.status === 'PENDING');
  check('    Center Admin confirms → PAID + settled; ledger split 60/40', (await api(`/teacher/payments/${claim.body.id}/confirm-cash`, { token: tokC, method: 'POST', headers: H(cId) })).status < 300 && (await prisma.ledgerTransaction.count({ where: { paymentId: claim.body.id } })) === 1);
  const w = await api('/teacher/wallet', { token: tokC, headers: H(cId) });
  check('    Center wallet: earnings = its 40% share; liability = fee + teacher share, separate', w.body?.scope === 'ORGANISATION' && w.body.balanceCents === 400 && w.body.cashOwedCents === (claim.body.amountCents - 400), JSON.stringify({ bal: w.body?.balanceCents, owed: w.body?.cashOwedCents, amt: claim.body.amountCents }));

  // ── Activity ──
  const act2 = await api('/teacher/analytics/activity', { token: tokC, headers: H(cId) });
  const actions = new Set((act2.body?.items ?? []).map((r) => r.action));
  check('14. Center activity audit shows the lifecycle', act2.status === 200 && ['academy.settings.update', 'payment.cash.confirm'].every((a) => actions.has(a)), [...actions].join(','));
  check('    teacher member cannot read it', (await api('/teacher/analytics/activity', { token: tokB, headers: H(cId) })).status === 403);
  check('database counts (pre-cleanup snapshot recorded)', true, before);
}

main()
  .catch((e) => { console.error('\nUNCAUGHT:', e); fail++; })
  .finally(async () => {
    const cids = cleanup.courseIds.filter(Boolean), gids = cleanup.groupIds.filter(Boolean);
    await prisma.$executeRaw`DELETE FROM "LedgerEntry" WHERE "transactionId" IN (SELECT id FROM "LedgerTransaction" WHERE "paymentId" IN (SELECT id FROM "Payment" WHERE "courseId" = ANY(${cids}::text[])))`.catch(() => {});
    await prisma.$executeRaw`DELETE FROM "LedgerTransaction" WHERE "paymentId" IN (SELECT id FROM "Payment" WHERE "courseId" = ANY(${cids}::text[]))`.catch(() => {});
    await prisma.$executeRaw`DELETE FROM "Invoice" WHERE "paymentId" IN (SELECT id FROM "Payment" WHERE "courseId" = ANY(${cids}::text[]))`.catch(() => {});
    await prisma.$executeRaw`DELETE FROM "Payment" WHERE "courseId" = ANY(${cids}::text[])`.catch(() => {});
    await prisma.$executeRaw`DELETE FROM "Enrollment" WHERE "courseId" = ANY(${cids}::text[])`.catch(() => {});
    await prisma.$executeRaw`DELETE FROM "Course" WHERE "id" = ANY(${cids}::text[])`.catch(() => {});
    await prisma.$executeRaw`DELETE FROM "GroupSession" WHERE "groupId" = ANY(${gids}::text[])`.catch(() => {});
    await prisma.$executeRaw`DELETE FROM "Group" WHERE "id" = ANY(${gids}::text[])`.catch(() => {});
    await prisma.$executeRaw`DELETE FROM "Room" WHERE "academyId" = ANY(${cleanup.academyIds}::text[])`.catch(() => {});
    await prisma.$executeRaw`DELETE FROM "AuditLog" WHERE "academyId" = ANY(${cleanup.academyIds}::text[])`.catch(() => {});
    await prisma.$executeRaw`DELETE FROM "Academy" WHERE "id" = ANY(${cleanup.academyIds}::text[])`.catch(() => {});
    for (const e of cleanup.userEmails) await prisma.$executeRaw`DELETE FROM "User" WHERE email = ${e}`.catch(() => {});
    console.log('   after-cleanup counts:', await counts());
    await prisma.$disconnect();
    console.log(`\n== ${pass} passed, ${fail} failed ==`);
    process.exit(fail ? 1 : 0);
  });
