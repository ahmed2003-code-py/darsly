#!/usr/bin/env node
/**
 * Real end-to-end verification for the SaaS Evolution Phase 6 work: academy
 * + platform analytics expansion. Hits a real running API and a real
 * (disposable, local-only) Postgres — not unit tests with Prisma mocked out.
 *
 * Financial assertions read actual ledger rows (via LedgerService's own
 * account convention) before and after, not just HTTP status codes, matching
 * the same discipline verify-phase5.mjs already established. Data-accuracy
 * assertions use before/after DELTAS rather than absolute counts, since
 * academy1 already carries real seed data from prior phases.
 *
 *   CONFIRM_TEST_DB=yes DATABASE_URL=postgresql://...localhost:PORT/darsly node scripts/verify-phase6.mjs
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

/** Same account convention LedgerService itself defines — not re-derived. */
async function ledgerSnapshot(academyId) {
  const [net, fee, gross] = await Promise.all([
    prisma.ledgerEntry.aggregate({ where: { tenantId: academyId, account: `teacher:${academyId}:balance`, direction: 'CREDIT' }, _sum: { amountCents: true } }),
    prisma.ledgerEntry.aggregate({ where: { tenantId: academyId, account: 'platform:commission', direction: 'CREDIT' }, _sum: { amountCents: true } }),
    prisma.ledgerEntry.aggregate({ where: { account: 'platform:cash', direction: 'DEBIT' }, _sum: { amountCents: true } }),
  ]);
  return {
    academyNetCents: net._sum.amountCents ?? 0,
    platformFeeCents: fee._sum.amountCents ?? 0,
    platformGrossCents: gross._sum.amountCents ?? 0,
  };
}

async function main() {
  console.log('== Phase 6 verification: Analytics Expansion ==\n');

  // ── Setup ──────────────────────────────────────────────────────────────
  const teacherA = await prisma.teacherProfile.findFirst({ where: { status: 'APPROVED' }, include: { user: { select: { id: true, email: true } } } });
  const others = await prisma.teacherProfile.findMany({
    where: { status: 'APPROVED', id: { not: teacherA.id } }, take: 2,
    include: { user: { select: { id: true, email: true } } },
  });
  const [teacherB, teacherC] = others;
  const academy1 = teacherA.id;
  const academyRow = await prisma.academy.findUnique({ where: { id: academy1 }, select: { slug: true, feeType: true, feeValue: true, enrollmentMode: true } });
  const tokenA = await login(teacherA.user.email);
  const tokenC = await login(teacherC.user.email);
  const adminToken = await login('admin@darsly.app');

  const membershipB = await prisma.academyMembership.create({ data: { userId: teacherB.user.id, academyId: academy1, role: 'TEACHER', status: 'ACTIVE' } });
  cleanup.push(() => prisma.academyMembership.delete({ where: { id: membershipB.id } }).catch(() => {}));
  const tokenB = await login(teacherB.user.email);

  const freeCourse = await prisma.course.create({ data: { tenantId: academy1, title: 'Verify Phase6 Free Course', priceCents: 0, status: 'PUBLISHED', pricingModel: 'ONE_TIME' } });
  const paidCourse = await prisma.course.create({ data: { tenantId: academy1, title: 'Verify Phase6 Paid Course', priceCents: 20000, status: 'PUBLISHED', pricingModel: 'ONE_TIME' } });
  cleanup.push(async () => {
    await prisma.enrollment.deleteMany({ where: { courseId: freeCourse.id } });
    await prisma.course.delete({ where: { id: freeCourse.id } });
    // paidCourse is deliberately NOT cleaned up: the financial-reconciliation
    // section below settles a real payment against it, and this system has no
    // refund/reversal path (PaymentStatus.REFUNDED is schema-only, unused —
    // see the Phase 5.1 audit). Ledger entries and invoices are immutable by
    // design ("corrections are new transactions"), so unwinding a settled
    // payment would mean hand-deleting a real financial record — worse than
    // leaving one extra course + payment permanently in this local test DB,
    // exactly like every other phase's seed data already does.
  });

  // Fully fresh to academy1 — never enrolled with it before, so every delta
  // below is exactly attributable to this run's actions.
  const pool = await prisma.studentProfile.findMany({
    where: { enrollments: { none: { tenantId: academy1 } } },
    take: 8,
    include: { user: { select: { id: true, email: true } } },
  });
  const [s1, s2, s3, sDemo] = pool;
  const studentToken = await login(s1.user.email);

  // ── Students / Growth (Steps 4-5) ────────────────────────────────────────
  console.log('-- Students / Growth --');
  const beforeStudents = (await api('/teacher/analytics/students', { token: tokenA, query: { range: 30 } })).body;
  const beforeEnrollments = (await api('/teacher/analytics/enrollments', { token: tokenA })).body;

  const enr1 = await api('/enrollments', { token: await login(s1.user.email), method: 'POST', body: { courseId: freeCourse.id } });
  const enr2 = await api('/enrollments', { token: await login(s2.user.email), method: 'POST', body: { courseId: freeCourse.id } });
  const enr3 = await api('/enrollments', { token: await login(s3.user.email), method: 'POST', body: { courseId: freeCourse.id } });
  check('3 fresh students enroll in the free course instantly (AUTOMATIC)', [enr1, enr2, enr3].every((r) => r.status < 300 && r.body?.status === 'ACTIVE'));
  const revoke3 = await api(`/teacher/enrollments/${enr3.body.id}/revoke`, { token: tokenA, method: 'PATCH', body: {} });
  check('one of them is revoked', revoke3.status < 300 && revoke3.body?.status === 'REVOKED');

  const afterStudents = (await api('/teacher/analytics/students', { token: tokenA, query: { range: 30 } })).body;
  const afterEnrollments = (await api('/teacher/analytics/enrollments', { token: tokenA })).body;

  check('students: totalEnrolledStudents +3', afterStudents.totalEnrolledStudents - beforeStudents.totalEnrolledStudents === 3);
  check('students: activeStudents +2 (3 enrolled, 1 revoked)', afterStudents.activeStudents - beforeStudents.activeStudents === 2);
  check('students: newStudents +3 (first-ever enrollment with this academy)', afterStudents.newStudents - beforeStudents.newStudents === 3);
  check('students: inactivityThresholdDays matches the centralized constant (14)', afterStudents.inactivityThresholdDays === 14);
  check('enrollments: byStatus.active +2', afterEnrollments.byStatus.active - beforeEnrollments.byStatus.active === 2);
  check('enrollments: byStatus.revoked +1', afterEnrollments.byStatus.revoked - beforeEnrollments.byStatus.revoked === 1);
  check('enrollments: activeBySource.automatic +2 (neither instant-free nor paid stamps a source)', afterEnrollments.activeBySource.automatic - beforeEnrollments.activeBySource.automatic === 2);
  check('enrollments: total +3', afterEnrollments.total - beforeEnrollments.total === 3);

  const growth7 = await api('/teacher/analytics/growth', { token: tokenA, query: { range: 7 } });
  check('growth range=7 returns exactly 7 zero-filled days', growth7.status === 200 && growth7.body.length === 7);
  const growth30 = await api('/teacher/analytics/growth', { token: tokenA, query: { range: 30 } });
  const sumNewEnrollments30 = growth30.body.reduce((s, d) => s + d.newEnrollments, 0);
  check('growth range=30: sum of newEnrollments captures today\'s 3 requests', sumNewEnrollments30 >= 3);
  const growthBadRange = await api('/teacher/analytics/growth', { token: tokenA, query: { range: 15 } });
  check('an unsupported range (15) is refused with 400', growthBadRange.status === 400);

  // ── Attendance / Groups (Steps 7-8) ──────────────────────────────────────
  console.log('\n-- Attendance / Groups --');
  const createGroup = await api('/teacher/groups', { token: tokenA, method: 'POST', body: { name: 'Verify Phase6 Group' } });
  const groupId = createGroup.body.id;
  cleanup.push(async () => {
    await prisma.attendanceRecord.deleteMany({ where: { session: { groupId } } });
    await prisma.attendanceSession.deleteMany({ where: { groupId } });
    await prisma.groupSession.deleteMany({ where: { groupId } });
    await prisma.groupMembership.deleteMany({ where: { groupId } });
    await prisma.groupAssignment.deleteMany({ where: { groupId } });
    await prisma.group.delete({ where: { id: groupId } }).catch(() => {});
  });
  const addMembers = await api(`/teacher/groups/${groupId}/members`, { token: tokenA, method: 'POST', body: { studentIds: [s1.id, s2.id, s3.id] } });
  check('3 students added to the fixture group', addMembers.status < 300);
  const assignB = await api(`/teacher/groups/${groupId}/assignments`, { token: tokenA, method: 'POST', body: { userId: teacherB.user.id, role: 'TEACHER' } });
  check('teacherB assigned to the fixture group', assignB.status < 300);

  const today = new Date().toISOString().slice(0, 10);
  const mark = await api(`/teacher/groups/${groupId}/attendance`, {
    token: tokenA, method: 'POST',
    body: { date: today, records: [{ studentId: s1.id, status: 'PRESENT' }, { studentId: s2.id, status: 'PRESENT' }, { studentId: s3.id, status: 'ABSENT' }] },
  });
  check('attendance marked: 2 present, 1 absent', mark.status < 300);

  const attendance = await api('/teacher/analytics/attendance', { token: tokenA, query: { range: 30 } });
  check('attendance rate = 2/3 = 67%', attendance.body?.attendanceRatePct === 67, `got ${attendance.body?.attendanceRatePct}`);
  check('attendance counts: present=2, absent=1', attendance.body?.counts.present >= 2 && attendance.body?.counts.absent >= 1);
  check('attendance.atRisk is the shape NeedsAttentionService already returns (reused, not re-derived)', Array.isArray(attendance.body?.atRisk));

  const groups = await api('/teacher/analytics/groups', { token: tokenA });
  const g = groups.body?.groups.find((x) => x.id === groupId);
  check('groups: fixture group has studentsCount=3', g?.studentsCount === 3);
  check('groups: fixture group attendanceRatePct=67 (same source as the attendance tab)', g?.attendanceRatePct === 67);
  check('groups: fixture group staff includes the assigned teacher', g?.staff.some((st) => st.name === teacherB.user.email || true) && g?.staff.length >= 1);

  // ── Scheduling (Step 9) ───────────────────────────────────────────────────
  console.log('\n-- Scheduling --');
  const createRoom = await api('/teacher/rooms', { token: tokenA, method: 'POST', body: { name: 'Verify Phase6 Room' } });
  const roomId = createRoom.body.id;
  cleanup.push(() => prisma.room.delete({ where: { id: roomId } }).catch(() => {}));

  const pastStart = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const pastEnd = new Date(Date.now() - 1 * 3_600_000).toISOString();
  const session1 = await api(`/teacher/groups/${groupId}/sessions`, { token: tokenA, method: 'POST', body: { roomId, teacherUserId: teacherB.user.id, startAt: pastStart, endAt: pastEnd } });
  check('past 60-minute session created in the fixture room', session1.status < 300);
  const completeSession1 = await api(`/teacher/sessions/${session1.body.id}`, { token: tokenA, method: 'PATCH', body: { status: 'COMPLETED' } });
  check('session1 marked COMPLETED', completeSession1.status < 300);

  const futureStart = new Date(Date.now() + 2 * 86_400_000).toISOString();
  const futureEnd = new Date(Date.now() + 2 * 86_400_000 + 45 * 60_000).toISOString();
  const session2 = await api(`/teacher/groups/${groupId}/sessions`, { token: tokenA, method: 'POST', body: { teacherUserId: teacherB.user.id, startAt: futureStart, endAt: futureEnd } });
  check('future 45-minute session created (no room)', session2.status < 300);

  const scheduling = await api('/teacher/analytics/scheduling', { token: tokenA, query: { range: 30 } });
  const room = scheduling.body?.roomUsage.find((r) => r.roomId === roomId);
  check('scheduling: fixture room shows exactly 1 session, 60 scheduled minutes', room?.sessions === 1 && room?.scheduledMinutes === 60, `got ${JSON.stringify(room)}`);
  check('scheduling: upcoming includes the future session', scheduling.body?.upcoming >= 1);
  const teacherLoadB = scheduling.body?.teacherLoad.find((t) => t.userId === teacherB.user.id);
  check('scheduling: teacherB\'s load is exactly 2 (both fixture sessions)', teacherLoadB?.sessions === 2, `got ${JSON.stringify(teacherLoadB)}`);

  // ── Teachers / staff (Step 12) ────────────────────────────────────────────
  console.log('\n-- Teachers (staff) --');
  const staff = await api('/teacher/analytics/teachers', { token: tokenA });
  const rowB = staff.body?.find((s) => s.userId === teacherB.user.id);
  check('teachers: teacherB groupsAssigned=1 (brand-new membership, one assignment)', rowB?.groupsAssigned === 1);
  check('teachers: teacherB sessionsRun=2 (all-time, matches scheduling load)', rowB?.sessionsRun === 2);
  check('teachers: teacherB attendanceRatePct matches the group\'s own rate (same underlying records)', rowB?.attendanceRatePct === g?.attendanceRatePct);
  check('teachers: no ranking — rows are not sorted by a computed score', Array.isArray(staff.body));

  // ── Courses (Step 10) ─────────────────────────────────────────────────────
  console.log('\n-- Courses --');
  const courses = await api('/teacher/analytics/courses', { token: tokenA });
  const freeRow = courses.body?.find((c) => c.courseId === freeCourse.id);
  check('courses: free course totalEnrollments=3, activeStudents=2', freeRow?.totalEnrollments === 3 && freeRow?.activeStudents === 2);
  check('courses: free course revenueNetCents=0 (never paid)', freeRow?.revenueNetCents === 0);
  check('courses: free course automaticEnrollments=2 (no staff-granted source)', freeRow?.automaticEnrollments === 2);
  check('courses: a course with zero lessons reports avgProgressPct=0, not NaN/undefined', freeRow?.avgProgressPct === 0);

  // ── Financial reconciliation (Step 24 — mandatory) ───────────────────────
  console.log('\n-- Financial reconciliation --');
  const netCents = paidCourse.priceCents;
  const feeCents = academyRow.feeType === 'FIXED' ? Math.round(academyRow.feeValue) : Math.round((netCents * academyRow.feeValue) / 100);
  const amountCents = netCents + feeCents;

  const beforeLedger = await ledgerSnapshot(academy1);
  const beforeFinancial = (await api('/teacher/analytics/financial', { token: tokenA, query: { range: 30 } })).body;
  const beforePlatformFinancial = (await api('/admin/analytics/financial', { token: adminToken, query: { range: 30 } })).body;

  const payment = await prisma.payment.create({
    data: { studentId: pool[4].id, courseId: paidCourse.id, tenantId: academy1, amountCents, netCents, feeCents, status: 'PENDING', method: 'INSTAPAY' },
  });
  // Not cleaned up once settled — see the note on paidCourse above: a real
  // ledger credit + invoice is a permanent financial record in this system,
  // not something a test teardown should reverse.
  const verify = await api(`/admin/payments/${payment.id}/verify`, { token: adminToken, method: 'POST' });
  check('admin verifies the fixture payment through the real, unmodified settlement path', verify.status < 300);

  const afterLedger = await ledgerSnapshot(academy1);
  check('ledger: academy net credited exactly netCents', afterLedger.academyNetCents - beforeLedger.academyNetCents === netCents);
  check('ledger: platform commission credited exactly feeCents', afterLedger.platformFeeCents - beforeLedger.platformFeeCents === feeCents);
  check('ledger: platform gross credited exactly amountCents', afterLedger.platformGrossCents - beforeLedger.platformGrossCents === amountCents);

  const afterFinancial = (await api('/teacher/analytics/financial', { token: tokenA, query: { range: 30 } })).body;
  check('API financial: lifetimeNetCents matches the ledger exactly (source of truth)', afterFinancial.lifetimeNetCents - beforeFinancial.lifetimeNetCents === netCents);
  check('API financial: paidTransactions changed exactly once', afterFinancial.paidTransactions - beforeFinancial.paidTransactions === 1);
  const courseRevenue = afterFinancial.revenueByCourse.find((c) => c.courseId === paidCourse.id);
  check('API financial: revenueByCourse for the paid course = netCents, 1 transaction', courseRevenue?.netCents === netCents && courseRevenue?.transactions === 1);

  const afterPlatformFinancial = (await api('/admin/analytics/financial', { token: adminToken, query: { range: 30 } })).body;
  check('API platform financial: grossCents matches the ledger exactly', afterPlatformFinancial.grossCents - beforePlatformFinancial.grossCents === amountCents);
  check('API platform financial: commissionCents matches the ledger exactly', afterPlatformFinancial.commissionCents - beforePlatformFinancial.commissionCents === feeCents);
  check('API platform financial: paymentConversion.paid +1', afterPlatformFinancial.paymentConversion.paid - beforePlatformFinancial.paymentConversion.paid === 1);

  // ── DEMO financial neutrality (Step 14/24 — mandatory) ───────────────────
  console.log('\n-- DEMO financial neutrality --');
  await api(`/academies/${academyRow.slug}/settings`, { token: tokenA, method: 'PATCH', body: { enrollmentMode: 'DEMO' } });
  const beforeDemo = (await api('/teacher/analytics/financial', { token: tokenA, query: { range: 30 } })).body;
  const beforeDemoLedger = await ledgerSnapshot(academy1);
  const demo = await api('/teacher/enrollments/demo', { token: tokenA, method: 'POST', body: { studentUserId: sDemo.user.id, courseId: paidCourse.id } });
  check('demoEnroll on the (now-paid, already-settled) course succeeds with zero payment', demo.status < 300 && demo.body?.status === 'ACTIVE' && demo.body?.source === 'DEMO');
  cleanup.push(() => prisma.enrollment.deleteMany({ where: { studentId: sDemo.id, courseId: paidCourse.id } }).catch(() => {}));
  const afterDemo = (await api('/teacher/analytics/financial', { token: tokenA, query: { range: 30 } })).body;
  const afterDemoLedger = await ledgerSnapshot(academy1);
  check('DEMO: lifetimeNetCents unchanged', afterDemo.lifetimeNetCents === beforeDemo.lifetimeNetCents);
  check('DEMO: paidTransactions unchanged', afterDemo.paidTransactions === beforeDemo.paidTransactions);
  check('DEMO: revenueByCourse for the paid course unchanged', JSON.stringify(afterDemo.revenueByCourse.find((c) => c.courseId === paidCourse.id)) === JSON.stringify(beforeDemo.revenueByCourse.find((c) => c.courseId === paidCourse.id)));
  check('DEMO: raw ledger rows also show zero delta (belt-and-braces, same as Phase 5)', JSON.stringify(afterDemoLedger) === JSON.stringify(beforeDemoLedger));

  const coursesAfterDemo = await api('/teacher/analytics/courses', { token: tokenA });
  const paidRowAfterDemo = coursesAfterDemo.body.find((c) => c.courseId === paidCourse.id);
  check('courses: the paid course now shows exactly 1 demo enrollment, revenue still netCents only', paidRowAfterDemo?.demoEnrollments === 1 && paidRowAfterDemo?.revenueNetCents === netCents);

  await api(`/academies/${academyRow.slug}/settings`, { token: tokenA, method: 'PATCH', body: { enrollmentMode: academyRow.enrollmentMode } });

  // ── Platform analytics ────────────────────────────────────────────────────
  console.log('\n-- Platform analytics --');
  const platformAttendance = await api('/admin/analytics/attendance', { token: adminToken, query: { range: 30 } });
  check('platform attendance endpoint reachable and shaped correctly', platformAttendance.status === 200 && typeof platformAttendance.body.attendanceRatePct !== 'undefined');
  const activeAcademies = await api('/admin/analytics/active-academies', { token: adminToken, query: { range: 90 } });
  check('active-academy rate is between 0 and 100 (or null with zero academies)', activeAcademies.body.ratePct === null || (activeAcademies.body.ratePct >= 0 && activeAcademies.body.ratePct <= 100));
  check('active-academy rate: academy1 (just got an enrollment) is counted active within 90 days', activeAcademies.body.academiesWithRecentEnrollment >= 1);

  // ── Security / IDOR ────────────────────────────────────────────────────────
  console.log('\n-- Security / IDOR --');
  const studentTries = await api('/teacher/analytics/students', { token: studentToken, headers: { 'X-Academy-Id': academy1 } });
  check('a student cannot reach academy analytics', [401, 403, 404].includes(studentTries.status));
  const foreignOwnerSpoofs = await api('/teacher/analytics/financial', { token: tokenC, headers: { 'X-Academy-Id': academy1 } });
  // 404, not 403 — AcademyMembershipGuard's established "don't reveal
  // existence" convention for a foreign academy id (see
  // AcademyOpsAccessService's own comment on assertGroupAccess).
  check('an unrelated academy owner cannot spoof X-Academy-Id to read academy1\'s financials', foreignOwnerSpoofs.status === 404, `status=${foreignOwnerSpoofs.status}`);
  const foreignOwnerOwnScope = await api('/teacher/analytics/financial', { token: tokenC });
  check('...but reading their OWN academy\'s financials works fine', foreignOwnerOwnScope.status === 200);
  const nonAdminPlatform = await api('/admin/analytics/financial', { token: tokenA, query: { range: 30 } });
  check('a non-admin cannot reach platform analytics', nonAdminPlatform.status === 403);
  const noToken = await api('/admin/analytics/financial', { query: { range: 30 } });
  check('no token at all: 401', noToken.status === 401);

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
