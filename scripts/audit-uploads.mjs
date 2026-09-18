#!/usr/bin/env node
/**
 * File upload, at runtime.
 *
 * The magic-byte check was added and unit-tested earlier in this audit. This
 * asks the deployed endpoints the same questions: does a file that lies about
 * its type get in, does anything reach the image decoder that should not, can a
 * caller influence where a file is stored, and does any of it 500.
 *
 * The decoder question is the reason this matters. sharp picks its decoder from
 * the magic number and never reads the declared MIME, and this build reports
 * libheif support — so bytes that say PNG and are HEIF used to be routed
 * straight to the decoder behind the project's own advisories.
 *
 *   CONFIRM_TEST_DB=yes DATABASE_URL=... API_URL=... node scripts/audit-uploads.mjs
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

const API = process.env.API_URL ?? 'http://127.0.0.1:3077/api/v1';
const DB = process.env.DATABASE_URL ?? '';
const PASSWORD = 'Darsly@123';

if (process.env.CONFIRM_TEST_DB !== 'yes') { console.error('REFUSED: set CONFIRM_TEST_DB=yes.'); process.exit(2); }
if (!DB) { console.error('REFUSED: DATABASE_URL is not set.'); process.exit(2); }
if (/railway|prod|amazonaws|supabase|neon\.tech|render\.com/i.test(DB)) {
  console.error('REFUSED: DATABASE_URL looks hosted.'); process.exit(2);
}

const prisma = new PrismaClient();
const tag = `upload-${Date.now()}`;
let pass = 0, fail = 0;
const findings = [];
/**
 * A 404 is not counted as a refusal unless the caller says it is one.
 *
 * A probe aimed at a path that does not exist answers 404, which looks exactly
 * like a rejection and is not one — an entire section of this suite once
 * "passed" against a route that was not mounted, so by default a 404 is
 * reported as a MISS rather than evidence.
 *
 * But 404 is also a deliberate answer in two places here: AcademyMembershipGuard
 * returns it for a caller with no membership ("never reveal existence"), and
 * tenant-scoped lookups return it for another academy's row. Those probes pass
 * `notFoundIsRefusal` so a real refusal is not misfiled as a missed shot.
 */
const check = (n, ok, d = '', notFoundIsRefusal = false) => {
  if (/HTTP 404/.test(d) && !notFoundIsRefusal) {
    console.log(`   MISS  ${n}  (${d} — probe did not reach a route)`);
    fail++; findings.push(`${n} — MISSED: ${d}`);
    return;
  }
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  (${d})` : ''}`);
  if (ok) pass++; else { fail++; findings.push(`${n} — ${d}`); }
};

async function api(p, { token, method = 'GET', body } = {}) {
  const r = await fetch(`${API}${p}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}
const login = async (email) => {
  const r = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  if (r.status >= 300) throw new Error(`login ${email}: ${r.status}`);
  return r.body.accessToken;
};

// ── payloads, by what their BYTES are, not what they claim ────────────────
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]), Buffer.alloc(64)]);
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0x40, 0, 0, 0]), Buffer.from('WEBPVP8 ', 'latin1'), Buffer.alloc(48)]);
/** ISO-BMFF with the HEIC brand — what routes a buffer to libheif inside sharp. */
const HEIF = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1'),
  Buffer.from([0, 0, 0, 0]), Buffer.from('mif1heic', 'latin1'), Buffer.alloc(64),
]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(64)]);
const HTML = Buffer.from('<!doctype html><script>alert(document.cookie)</script>', 'latin1');
const JS = Buffer.from('module.exports = () => require("child_process").exec("id");', 'latin1');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>', 'latin1');
const PDF = Buffer.from('%PDF-1.4\n%oops\n', 'latin1');
const TRUNCATED_PNG = Buffer.from([0x89, 0x50, 0x4e]);           // 3 bytes, not a signature
const ZERO = Buffer.alloc(0);
/** A polyglot: a real PNG signature with markup appended after it. */
const POLYGLOT = Buffer.concat([PNG, HTML]);

const dataUrl = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;

const made = { users: [], students: [] };

try {
  const teacher = await prisma.teacherProfile.findFirst({ where: { status: 'APPROVED' }, include: { user: true } });
  if (!teacher) throw new Error('no approved teacher — seed the database');
  const tToken = await login(teacher.user.email);

  const user = await prisma.user.create({
    data: {
      email: `${tag}@test.invalid`, fullName: 'Upload Probe',
      passwordHash: await argon2.hash(PASSWORD), role: 'STUDENT', isActive: true,
    },
  });
  made.users.push(user.id);
  const student = await prisma.studentProfile.create({ data: { userId: user.id } });
  made.students.push(student.id);
  const sToken = await login(user.email);

  // ── 1. avatar: the data-URL path ───────────────────────────────────────
  console.log('\n=== 1. AVATAR (base64 data URL) ===');
  const avatar = (mime, buf) => api('/me/avatar', { method: 'POST', token: sToken, body: { dataUrl: dataUrl(mime, buf) } });
  {
    const good = await avatar('image/png', PNG);
    check('a real PNG is accepted', good.status < 300, `HTTP ${good.status} ${JSON.stringify(good.body).slice(0, 90)}`);
    for (const [label, mime, buf] of [
      ['HEIF bytes declared as PNG', 'image/png', HEIF],
      ['HTML declared as PNG', 'image/png', HTML],
      ['JavaScript declared as PNG', 'image/png', JS],
      ['SVG declared as PNG', 'image/png', SVG],
      ['PDF declared as JPEG', 'image/jpeg', PDF],
      ['GIF declared as WebP', 'image/webp', GIF],
      ['JPEG bytes declared as PNG', 'image/png', JPEG],
      ['a truncated signature', 'image/png', TRUNCATED_PNG],
      ['an empty file', 'image/png', ZERO],
      ['SVG declared honestly', 'image/svg+xml', SVG],
      ['a PDF declared honestly', 'application/pdf', PDF],
    ]) {
      const r = await avatar(mime, buf);
      check(`${label} is refused`, r.status >= 400 && r.status < 500, `HTTP ${r.status}`);
    }
    // A polyglot starts with a genuine PNG signature. The magic check is a
    // gate, not a parser, so accepting it is correct — what must not happen is
    // it being served back as anything but an image.
    const poly = await avatar('image/png', POLYGLOT);
    console.log(`   note: PNG signature + appended markup -> HTTP ${poly.status} (signature is genuine; nosniff governs how it is served)`);

    const oversized = await avatar('image/png', Buffer.concat([PNG, Buffer.alloc(400 * 1024)]));
    check('an oversized avatar is refused', oversized.status >= 400 && oversized.status < 500, `HTTP ${oversized.status}`);
  }

  // ── 2. course thumbnail: data URL or remote URL ────────────────────────
  console.log('\n=== 2. COURSE THUMBNAIL (data URL or link) ===');
  {
    const course = await prisma.course.findFirst({ where: { tenantId: teacher.id } });
    const setThumb = (v) => api(`/teacher/courses/${course.id}`, { method: 'PATCH', token: tToken, body: { thumbnailUrl: v } });
    for (const [label, value] of [
      ['a javascript: URL', 'javascript:alert(1)'],
      ['a data:text/html URL', 'data:text/html;base64,' + HTML.toString('base64')],
      ['an SVG data URL', 'data:image/svg+xml;base64,' + SVG.toString('base64')],
      ['HEIF bytes declared as PNG', dataUrl('image/png', HEIF)],
      ['a file: URL', 'file:///etc/passwd'],
      ['HTML declared as PNG', dataUrl('image/png', HTML)],
    ]) {
      const r = await setThumb(value);
      check(`${label} is refused`, r.status >= 400 && r.status < 500, `HTTP ${r.status}`);
    }
    const ok = await setThumb(dataUrl('image/png', PNG));
    check('a real PNG data URL is accepted', ok.status < 300, `HTTP ${ok.status}`);
    // Restore whatever it was, so the seeded course is left as found.
    await prisma.course.update({ where: { id: course.id }, data: { thumbnailUrl: course.thumbnailUrl } }).catch(() => {});
  }

  // ── 3. authorization on the upload routes themselves ───────────────────
  console.log('\n=== 3. UPLOAD ROUTE AUTHORIZATION ===');
  {
    const anon = await api('/me/avatar', { method: 'POST', body: { dataUrl: dataUrl('image/png', PNG) } });
    check('avatar upload requires authentication', anon.status === 401, `HTTP ${anon.status}`);

    // AcademyMembershipGuard answers 404 for a caller with no membership,
    // deliberately — see its own comment: "never reveal existence".
    const asStudent = await api('/academy/media', { method: 'POST', token: sToken, body: { kind: 'LOGO', dataUrl: dataUrl('image/png', PNG) } });
    check('a student cannot upload academy media', asStudent.status >= 400, `HTTP ${asStudent.status}`, true);

    const otherCourse = await prisma.course.findFirst({ where: { tenantId: { not: teacher.id } } });
    if (otherCourse) {
      const r = await api(`/teacher/courses/${otherCourse.id}`, {
        method: 'PATCH', token: tToken, body: { thumbnailUrl: dataUrl('image/png', PNG) },
      });
      // The same route served this teacher's OWN course a moment ago, so a 404
      // here is the tenant scope refusing, not a missing route.
      check("a teacher cannot set another academy's thumbnail", r.status >= 400, `HTTP ${r.status}`, true);
    }
  }

  // ── 4. the storage key must not be caller-controlled ───────────────────
  console.log('\n=== 4. STORAGE PATH CONTROL ===');
  {
    for (const [label, extra] of [
      ['a storageKey field', { storageKey: '../../../etc/passwd' }],
      ['a key field', { key: '../../evil' }],
      ['a path field', { path: '/etc/passwd' }],
      ['a fileName with traversal', { fileName: '../../../evil.png' }],
    ]) {
      const r = await api('/me/avatar', { method: 'POST', token: sToken, body: { dataUrl: dataUrl('image/png', PNG), ...extra } });
      // The whitelist pipe should reject the unknown field outright; anything
      // other than a 4xx would mean the caller reached the storage layer.
      check(`${label} does not reach storage`, r.status >= 400 && r.status < 500, `HTTP ${r.status}`);
    }
  }

  // ── 5. nothing 500s ────────────────────────────────────────────────────
  console.log('\n=== 5. MALFORMED PAYLOADS DO NOT CRASH THE SERVICE ===');
  {
    for (const [label, body] of [
      ['no dataUrl at all', {}],
      ['dataUrl as a number', { dataUrl: 12345 }],
      ['dataUrl as an array', { dataUrl: ['data:image/png;base64,AAAA'] }],
      ['dataUrl as an object', { dataUrl: { toString: 'x' } }],
      ['a bare string', { dataUrl: 'not-a-data-url' }],
      ['a data URL with no comma', { dataUrl: 'data:image/png;base64' }],
      ['invalid base64', { dataUrl: 'data:image/png;base64,!!!!not-base64!!!!' }],
      ['a unicode filename', { dataUrl: dataUrl('image/png', PNG), name: 'اختبار .png' }],
      ['a 2MB string', { dataUrl: 'data:image/png;base64,' + 'A'.repeat(2_000_000) }],
    ]) {
      const r = await api('/me/avatar', { method: 'POST', token: sToken, body });
      check(`${label} -> no 5xx`, r.status < 500, `HTTP ${r.status}`);
    }
  }

  // ── 6. the health of the service afterwards ────────────────────────────
  console.log('\n=== 6. SERVICE STILL HEALTHY ===');
  {
    const h = await api('/health');
    check('the API is still answering after every probe', h.status === 200, `HTTP ${h.status}`);
  }
} catch (e) {
  console.error('\nERROR:', e.message);
  fail++;
} finally {
  for (const id of made.students) await prisma.studentProfile.delete({ where: { id } }).catch(() => {});
  for (const id of made.users) await prisma.user.delete({ where: { id } }).catch(() => {});
  await prisma.$disconnect();
}

console.log(`\n${fail === 0 ? 'UPLOAD GATE PASS' : `UPLOAD GATE — ${fail} FAILURE(S)`}  —  ${pass} passed, ${fail} failed`);
if (findings.length) { console.log('\nfailures:'); for (const f of findings) console.log('  ' + f); }
process.exit(fail === 0 ? 0 : 1);
