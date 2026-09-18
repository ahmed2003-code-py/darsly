#!/usr/bin/env node
/**
 * Write endpoints: what happens to a body the client should never have sent.
 *
 * The 265-route matrix (audit-endpoint-matrix.mjs) already proves the role
 * boundary holds on every route. This is the layer beneath that: for a caller
 * who *is* allowed to call the route, does the body itself get checked —
 * missing fields, wrong types, out-of-range numbers, fields that don't exist
 * on the DTO (the mass-assignment / privilege-injection question), and does a
 * double-click on a state-changing action ever produce two of something that
 * should only exist once.
 *
 *   CONFIRM_TEST_DB=yes DATABASE_URL=... API_URL=... node scripts/audit-write-validation.mjs
 */
import { PrismaClient } from '@prisma/client';

const API = process.env.API_URL ?? 'http://127.0.0.1:3077/api/v1';
const DB = process.env.DATABASE_URL ?? '';
const PASSWORD = 'Darsly@123';

if (process.env.CONFIRM_TEST_DB !== 'yes') { console.error('REFUSED: set CONFIRM_TEST_DB=yes.'); process.exit(2); }
if (!DB) { console.error('REFUSED: DATABASE_URL is not set.'); process.exit(2); }
if (/railway|prod|amazonaws|supabase|neon\.tech|render\.com/i.test(DB)) {
  console.error('REFUSED: DATABASE_URL looks hosted.'); process.exit(2);
}

const prisma = new PrismaClient();
const tag = `wv-${Date.now()}`;
let pass = 0, fail = 0;
const findings = [];
const check = (n, ok, d = '') => {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  (${d})` : ''}`);
  if (ok) pass++; else { fail++; findings.push(`${n} — ${d}`); }
};

async function api(p, { token, method = 'GET', body } = {}) {
  const r = await fetch(`${API}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json };
}
const login = async (email) => {
  const r = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  if (r.status >= 300) throw new Error(`login ${email}: ${r.status}`);
  return r.body.accessToken;
};

const madeSessions = [];

try {
  const teacher = await prisma.teacherProfile.findFirst({ where: { status: 'APPROVED' }, include: { user: true } });
  const student = await prisma.studentProfile.findFirst({ where: { user: { isActive: true } }, include: { user: true } });
  const academy = await prisma.academy.findUnique({ where: { id: teacher.id } });
  const tTok = await login(teacher.user.email);
  const sTok = await login(student.user.email);
  console.log(`teacher ${teacher.user.email}  academy /${academy.slug}\n`);

  // ── 1. POST teacher/live — CreateLiveDto ─────────────────────────────────
  console.log('=== 1. CREATE LIVE SESSION — BODY VALIDATION ===');
  const base = { title: `${tag} probe`, startsAt: new Date(Date.now() + 3600_000).toISOString() };
  const create = (body) => api('/teacher/live', { method: 'POST', token: tTok, body });

  {
    const r = await create({ startsAt: base.startsAt });
    check('missing required title is rejected', r.status === 400, `HTTP ${r.status}`);

    const r2 = await create({ ...base, title: 'x'.repeat(300) });
    check('title beyond MaxLength(160) is rejected', r2.status === 400, `HTTP ${r2.status}`);

    const r3 = await create({ ...base, durationMin: 'not-a-number' });
    check('non-numeric durationMin is rejected, not coerced', r3.status === 400, `HTTP ${r3.status}`);

    const r4 = await create({ ...base, durationMin: -30 });
    check('negative durationMin is rejected', r4.status === 400, `HTTP ${r4.status}`);

    const r5 = await create({ ...base, durationMin: 10_000 });
    check('durationMin past the 720-minute ceiling is rejected', r5.status === 400, `HTTP ${r5.status}`);

    const r6 = await create({ ...base, capacity: 0 });
    check('capacity of 0 is rejected (Min 1)', r6.status === 400, `HTTP ${r6.status}`);

    const r7 = await create({ ...base, startsAt: 'not a date' });
    check('a non-ISO8601 startsAt is rejected', r7.status === 400, `HTTP ${r7.status}`);

    // The privilege-injection question: can a field that isn't on the DTO —
    // one that would let a caller assign themselves ownership or bypass
    // tenant scoping if it were silently accepted — get through?
    const r8 = await create({ ...base, tenantId: 'someone-elses-academy', isOwner: true, teacherId: 'not-me' });
    check('unrecognized fields (tenantId/isOwner/teacherId) are rejected outright, not silently dropped',
      r8.status === 400, `HTTP ${r8.status}`);

    const r9 = await create({ ...base, joinUrl: 'javascript:alert(1)' });
    check('a non-http(s) joinUrl scheme is rejected', r9.status === 400, `HTTP ${r9.status}`);

    // A SQL-meta-character title is legitimate content (a course could be
    // titled anything) — it must be *stored literally*, not executed.
    const weirdTitle = `${tag} O'Brien "quotes" <b>html</b> --`;
    const r10 = await create({ ...base, title: weirdTitle, startsAt: new Date(Date.now() + 7200_000).toISOString() });
    check('a title with quotes/HTML/SQL punctuation is accepted as literal content', r10.status === 201 || r10.status === 200, `HTTP ${r10.status}`);
    if (r10.body?.id) {
      madeSessions.push(r10.body.id);
      const row = await prisma.liveSession.findUnique({ where: { id: r10.body.id } });
      check('…and stored byte-for-byte, not mangled or executed', row?.title === weirdTitle, row?.title);
    }
  }

  // ── 2. role injection on academy membership ──────────────────────────────
  console.log('\n=== 2. ADD MEMBER — ROLE INJECTION ===');
  {
    const addMember = (body) => api(`/academies/${academy.slug}/members`, { method: 'POST', token: tTok, body });
    const r1 = await addMember({ email: `${tag}-nope@test.invalid`, role: 'SUPER_ADMIN' });
    check('role:"SUPER_ADMIN" is rejected (not in the DTO\'s allowed set)', r1.status === 400, `HTTP ${r1.status}`);

    const r2 = await addMember({ email: `${tag}-nope2@test.invalid`, role: 'OWNER' });
    check('role:"OWNER" is rejected the same way', r2.status === 400, `HTTP ${r2.status}`);

    const r3 = await addMember({ email: `${tag}-nope3@test.invalid`, role: 'TEACHER', isPlatformAdmin: true, status: 'ACTIVE', membershipId: 'x' });
    check('extra fields riding along with a valid role are rejected outright', r3.status === 400, `HTTP ${r3.status}`);
  }

  // ── 3. settings PATCH — field/type bounds and unknown-field injection ────
  console.log('\n=== 3. ACADEMY SETTINGS — BODY VALIDATION ===');
  {
    const patch = (body) => api(`/academies/${academy.slug}/settings`, { method: 'PATCH', token: tTok, body });
    const r1 = await patch({ colorPrimary: 'not-a-hex-color' });
    check('a non-hex colorPrimary is rejected', r1.status === 400, `HTTP ${r1.status}`);

    const r2 = await patch({ maxConcurrentSessions: 11 });
    check('maxConcurrentSessions past its Max(10) is rejected', r2.status === 400, `HTTP ${r2.status}`);

    const r3 = await patch({ id: 'someone-elses-id', ownerId: 'x', verified: true, isPlatformOwned: true });
    check('unrecognized settings fields (id/ownerId/verified) are rejected outright', r3.status === 400, `HTTP ${r3.status}`);
  }

  // ── 4. pagination bounds and output shape on a public list ──────────────
  console.log('\n=== 4. PUBLIC TEACHER SEARCH — PAGINATION & OUTPUT SHAPE ===');
  {
    const r1 = await api('/teachers?page=-1');
    check('a negative page is rejected, not silently clamped to page 1', r1.status === 400, `HTTP ${r1.status}`);

    const r2 = await api('/teachers?page=999999999');
    check('an absurd page number does not 500 (past-Max rejected or empty page)', r2.status === 400 || (r2.status === 200 && Array.isArray(r2.body?.items ?? r2.body)), `HTTP ${r2.status}`);

    const r3 = await api('/teachers?pageSize=999999');
    check('pageSize past its cap is rejected, not honored', r3.status === 400, `HTTP ${r3.status}`);

    const r4 = await api('/teachers?page=abc');
    check('a non-numeric page is rejected, not parsed as NaN into a query', r4.status === 400, `HTTP ${r4.status}`);

    const r5 = await api('/teachers?page=1&pageSize=5');
    check('a well-formed request still succeeds', r5.status === 200, `HTTP ${r5.status}`);
    const rows = Array.isArray(r5.body) ? r5.body : (r5.body?.items ?? r5.body?.data ?? []);
    if (Array.isArray(rows) && rows.length) {
      const leaked = rows.some((t) => 'passwordHash' in (t ?? {}) || 'passwordHash' in (t?.user ?? {}));
      check('no row exposes passwordHash', !leaked, leaked ? 'passwordHash present!' : 'clean');
    } else {
      console.log('   (empty page — shape check skipped, not a failure)');
    }
  }

  // ── 5. duplicate / concurrent booking ────────────────────────────────────
  console.log('\n=== 5. CONCURRENT BOOKING — DOUBLE-CLICK ===');
  {
    const target = await prisma.liveSession.findFirst({
      where: { tenantId: academy.id, deletedAt: null, startsAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (target) {
      await prisma.liveBooking.deleteMany({ where: { sessionId: target.id, studentId: student.id } });
      const [a, b] = await Promise.all([
        api(`/live/${target.id}/book`, { method: 'POST', token: sTok }),
        api(`/live/${target.id}/book`, { method: 'POST', token: sTok }),
      ]);
      check('neither concurrent booking request 500s', a.status < 500 && b.status < 500, `${a.status}, ${b.status}`);
      const count = await prisma.liveBooking.count({ where: { sessionId: target.id, studentId: student.id } });
      check('exactly one booking row exists after the race', count === 1, `${count} row(s)`);
      // book() is deliberately idempotent under a race (Serializable + a P2002
      // catch on the loser) rather than making the loser fail outright — both
      // requests report ok:true, but exactly one of them is the actual creator
      // and the other is told it was already booked. Duplication is what would
      // be the bug; both sides answering success is the intended UX for a
      // double-click.
      const winners = [a, b].filter((r) => r.status >= 200 && r.status < 300 && !r.body?.alreadyBooked).length;
      const echoes = [a, b].filter((r) => r.status >= 200 && r.status < 300 && r.body?.alreadyBooked === true).length;
      check('exactly one request created the booking and the other was told alreadyBooked:true',
        winners === 1 && echoes === 1, `winners=${winners} alreadyBooked=${echoes}`);
      await prisma.liveBooking.deleteMany({ where: { sessionId: target.id, studentId: student.id } });
    } else {
      console.log('   SKIP  no future live session available in this academy to book');
    }
  }
} catch (e) {
  console.error('\nERROR:', e.message);
  fail++;
} finally {
  for (const id of madeSessions) await prisma.liveSession.delete({ where: { id } }).catch(() => {});
  await prisma.$disconnect();
}

console.log(`\n${fail === 0 ? 'WRITE-VALIDATION GATE PASS' : `WRITE-VALIDATION GATE — ${fail} FAILURE(S)`}  —  ${pass} passed, ${fail} failed`);
if (findings.length) { console.log('\nfailures:'); for (const f of findings) console.log('  ' + f); }
process.exit(fail === 0 ? 0 : 1);
