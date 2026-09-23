#!/usr/bin/env node
/**
 * Encrypted HLS: does the content stay behind the authorization, or only the
 * page that links to it?
 *
 * The architecture is deliberate and worth stating, because what counts as a
 * bug depends on it. A bearer-authenticated call to POST /playback/sessions
 * issues a short-lived HMAC token. That token — not a header — authorizes the
 * manifest and the segments, because hls.js cannot attach bearer headers to
 * media requests. The AES key is the real gate: it is served only while the
 * PlaybackSession is live and the device session is not revoked.
 *
 * So the questions are not "can a URL be shared" (it can, briefly, by design)
 * but: is the session gate real, is the token bound to one asset, does it
 * actually expire, does ending a session actually revoke the key, and can a
 * token be forged or repointed at somebody else's video.
 *
 *   CONFIRM_TEST_DB=yes DATABASE_URL=... API_URL=... STORAGE_LOCAL_PATH=... \
 *     node scripts/audit-hls-video.mjs
 *
 * Creates its own asset, its own storage objects and its own students, and
 * deletes all of them afterwards.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { writeFile, mkdir, rm } from 'fs/promises';
import path from 'path';

const API = process.env.API_URL ?? 'http://127.0.0.1:3077/api/v1';
const DB = process.env.DATABASE_URL ?? '';
const STORAGE = path.resolve(process.env.STORAGE_LOCAL_PATH ?? './storage');
const PASSWORD = 'Darsly@123';

if (process.env.CONFIRM_TEST_DB !== 'yes') {
  console.error('REFUSED: set CONFIRM_TEST_DB=yes.');
  process.exit(2);
}
if (!DB) {
  console.error('REFUSED: DATABASE_URL is not set.');
  process.exit(2);
}
if (/railway|prod|amazonaws|supabase|neon\.tech|render\.com/i.test(DB)) {
  console.error('REFUSED: DATABASE_URL looks hosted.');
  process.exit(2);
}

const prisma = new PrismaClient();
const tag = `hls-${Date.now()}`;
let pass = 0,
  fail = 0;
const findings = [];
const check = (n, ok, d = '') => {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  (${d})` : ''}`);
  if (ok) pass++;
  else {
    fail++;
    findings.push(`${n} — ${d}`);
  }
};

async function api(p, { token, method = 'GET', body, raw = false, headers = {} } = {}) {
  const r = await fetch(`${API}${p}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* media, not json */
  }
  return { status: r.status, body: json, text, len: text.length };
}
const login = async (email) => {
  const r = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  if (r.status >= 300) throw new Error(`login ${email}: ${r.status}`);
  return r.body.accessToken;
};

const made = {
  users: [],
  students: [],
  lessons: [],
  assets: [],
  keys: [],
  courses: [],
  enrolments: [],
};
let storageDir = null;

async function newStudent(label) {
  const user = await prisma.user.create({
    data: {
      email: `${tag}-${label}@test.invalid`,
      fullName: `HLS ${label}`,
      passwordHash: await argon2.hash(PASSWORD),
      role: 'STUDENT',
      isActive: true,
    },
  });
  made.users.push(user.id);
  const student = await prisma.studentProfile.create({ data: { userId: user.id } });
  made.students.push(student.id);
  return { user, student, token: await login(user.email) };
}

try {
  const teacher = await prisma.teacherProfile.findFirst({ where: { status: 'APPROVED' } });
  const otherTeacher = await prisma.teacherProfile.findFirst({
    where: { status: 'APPROVED', id: { not: undefined }, NOT: { id: teacher?.id } },
  });
  if (!teacher) throw new Error('no approved teacher — seed the database');

  // ── an asset with real files on disk ────────────────────────────────────
  const keyRow = await prisma.hlsEncryptionKey.create({ data: { keyHex: 'a'.repeat(32) } });
  made.keys.push(keyRow.id);
  const asset = await prisma.videoAsset.create({
    data: {
      tenantId: teacher.id,
      originalKey: `${tag}/source.mp4`,
      status: 'READY',
      hlsMasterKey: '',
      encryptionKeyId: keyRow.id,
      durationSec: 30,
      renditions: [{ height: 360, bandwidth: 400000, playlistKey: 'v360/index.m3u8' }],
    },
  });
  made.assets.push(asset.id);
  await prisma.videoAsset.update({
    where: { id: asset.id },
    data: { hlsMasterKey: `hls/${asset.id}/master.m3u8` },
  });

  storageDir = path.join(STORAGE, 'hls', asset.id);
  await mkdir(path.join(storageDir, 'v360'), { recursive: true });
  await writeFile(
    path.join(storageDir, 'master.m3u8'),
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=640x360\nv360/index.m3u8\n',
  );
  await writeFile(
    path.join(storageDir, 'v360', 'index.m3u8'),
    // 'darsly:key' is the literal the transcoder bakes in (KEY_URI_PLACEHOLDER)
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-KEY:METHOD=AES-128,URI="darsly:key"\n#EXTINF:6.0,\nseg0.ts\n#EXT-X-ENDLIST\n',
  );
  await writeFile(
    path.join(storageDir, 'v360', 'seg0.ts'),
    Buffer.from('ENCRYPTED-SEGMENT-BYTES-FOR-TEST'),
  );

  // A second asset, to test cross-asset reuse of a valid token.
  const asset2 = await prisma.videoAsset.create({
    data: {
      tenantId: teacher.id,
      originalKey: `${tag}/other.mp4`,
      status: 'READY',
      encryptionKeyId: keyRow.id,
      durationSec: 30,
      renditions: [],
    },
  });
  made.assets.push(asset2.id);
  const dir2 = path.join(STORAGE, 'hls', asset2.id);
  await mkdir(dir2, { recursive: true });
  await writeFile(
    path.join(dir2, 'master.m3u8'),
    '#EXTM3U\n# OTHER ASSET — MUST NOT BE REACHABLE\n',
  );

  // ── a gated lesson on a course, and two students ───────────────────────
  const course = await prisma.course.create({
    data: {
      tenantId: teacher.id,
      title: `${tag} course`,
      status: 'PUBLISHED',
      priceCents: 10000,
      currency: 'EGP',
      pricingModel: 'ONE_TIME',
    },
  });
  made.courses.push(course.id);
  const unit = await prisma.courseUnit.create({
    data: { courseId: course.id, title: `${tag} unit`, sortOrder: 0 },
  });
  const lesson = await prisma.lesson.create({
    data: {
      unitId: unit.id,
      title: `${tag} gated lesson`,
      type: 'VIDEO',
      isFreePreview: false,
      sortOrder: 0,
      videoAssetId: asset.id,
    },
  });
  made.lessons.push(lesson.id);

  const enrolled = await newStudent('enrolled');
  const outsider = await newStudent('outsider');
  const enr = await prisma.enrollment.create({
    data: {
      studentId: enrolled.student.id,
      courseId: course.id,
      tenantId: teacher.id,
      status: 'ACTIVE',
      approvedAt: new Date(),
    },
  });
  made.enrolments.push(enr.id);

  // ── 1. who may start a session ─────────────────────────────────────────
  console.log('\n=== 1. STARTING A PLAYBACK SESSION ===');
  const started = await api('/playback/sessions', {
    method: 'POST',
    token: enrolled.token,
    body: { lessonId: lesson.id },
  });
  check(
    'an enrolled student can start a session',
    started.status < 300,
    `HTTP ${started.status} ${JSON.stringify(started.body).slice(0, 120)}`,
  );

  const outsiderStart = await api('/playback/sessions', {
    method: 'POST',
    token: outsider.token,
    body: { lessonId: lesson.id },
  });
  check(
    'a non-enrolled student cannot',
    outsiderStart.status >= 400,
    `HTTP ${outsiderStart.status}`,
  );

  const anonStart = await api('/playback/sessions', {
    method: 'POST',
    body: { lessonId: lesson.id },
  });
  check('an unauthenticated caller cannot', anonStart.status === 401, `HTTP ${anonStart.status}`);

  if (started.status >= 300) throw new Error('cannot continue without a session');
  const payload = started.body ?? {};
  const masterUrl = payload.masterUrl ?? payload.url ?? payload.hlsUrl ?? '';
  const token = (masterUrl.match(/hls\/([^/]+)\/master\.m3u8/) ?? [])[1] ?? payload.token ?? '';
  const sessionId = payload.playbackSessionId ?? payload.sessionId ?? payload.id ?? '';
  console.log(
    `   session ${String(sessionId).slice(0, 10)}  token ${token ? token.slice(0, 18) + '…' : '(none found)'}`,
  );
  if (!token) {
    console.log('   ! could not extract a token; payload keys: ' + Object.keys(payload).join(', '));
  }

  // ── 2. the media chain with a valid token ──────────────────────────────
  console.log('\n=== 2. THE MEDIA CHAIN WITH A VALID TOKEN ===');
  const master = await api(`/playback/hls/${token}/master.m3u8`);
  check('the master playlist is served', master.status === 200, `HTTP ${master.status}`);
  const media = await api(`/playback/hls/${token}/v360/index.m3u8`);
  check('the media playlist is served', media.status === 200, `HTTP ${media.status}`);
  check(
    'the key URI is rewritten to this session',
    media.text.includes(`/playback/key/${token}`),
    media.text.includes('darsly:key') ? 'placeholder left in place' : 'rewritten',
  );
  const seg = await api(`/playback/hls/${token}/v360/seg0.ts`);
  check('the segment is served', seg.status === 200, `HTTP ${seg.status}`);
  const keyRes = await api(`/playback/key/${token}`);
  check('the AES key is served to a live session', keyRes.status === 200, `HTTP ${keyRes.status}`);

  // ── 3. token integrity ─────────────────────────────────────────────────
  console.log('\n=== 3. TOKEN INTEGRITY ===');
  const flip = (t) => {
    const i = t.lastIndexOf('.');
    const sig = t.slice(i + 1);
    return t.slice(0, i + 1) + (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
  };
  const tampered = flip(token);
  check(
    'a tampered signature is refused (master)',
    (await api(`/playback/hls/${tampered}/master.m3u8`)).status >= 400,
    '',
  );
  check(
    'a tampered signature is refused (segment)',
    (await api(`/playback/hls/${tampered}/v360/seg0.ts`)).status >= 400,
    '',
  );
  check(
    'a tampered signature is refused (key)',
    (await api(`/playback/key/${tampered}`)).status >= 400,
    '',
  );

  // Re-sign the body with a different asset id — only possible with the secret,
  // so this proves the body is authenticated, not merely present.
  const [body] = token.split('.');
  const decoded = JSON.parse(
    Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(),
  );
  const repointed =
    Buffer.from(JSON.stringify({ ...decoded, aid: asset2.id }))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '') +
    '.' +
    token.split('.')[1];
  const cross = await api(`/playback/hls/${repointed}/master.m3u8`);
  check(
    'a token repointed at another asset is refused',
    cross.status >= 400,
    `HTTP ${cross.status}`,
  );
  check(
    'and the other asset was not served',
    !cross.text.includes('MUST NOT BE REACHABLE'),
    cross.text.includes('MUST NOT BE REACHABLE') ? 'LEAKED' : 'not served',
  );

  // ── 4. path traversal out of the asset ─────────────────────────────────
  console.log('\n=== 4. PATH TRAVERSAL OUT OF THE ASSET ===');
  for (const [label, p] of [
    ['..%2f..%2f to another asset', `/playback/hls/${token}/..%2f${asset2.id}/master.m3u8`],
    ['encoded dot-dot in rendition', `/playback/hls/${token}/%2e%2e/${asset2.id}/master.m3u8`],
    ['dot-dot in file', `/playback/hls/${token}/v360/..%2f..%2f${asset2.id}%2fmaster.m3u8`],
    ['absolute-ish key', `/playback/hls/${token}/v360/%2fetc%2fpasswd`],
  ]) {
    const r = await api(p);
    const leaked = r.text.includes('MUST NOT BE REACHABLE') || r.text.includes('root:');
    check(
      `${label} is refused`,
      r.status >= 400 && !leaked,
      `HTTP ${r.status}${leaked ? ' — LEAKED' : ''}`,
    );
  }

  // ── 5. ending the session must revoke the key ──────────────────────────
  console.log('\n=== 5. ENDING THE SESSION REVOKES THE KEY ===');
  const ended = await api(`/playback/sessions/${sessionId}/end`, {
    method: 'POST',
    token: enrolled.token,
  });
  check('the session can be ended', ended.status < 300, `HTTP ${ended.status}`);
  const keyAfter = await api(`/playback/key/${token}`);
  check(
    'the AES key is refused after the session ends',
    keyAfter.status >= 400,
    `HTTP ${keyAfter.status}`,
  );
  // The segments remain reachable until the token expires — that is the design,
  // and it is only safe because the key is gone. Assert the tradeoff explicitly.
  const segAfter = await api(`/playback/hls/${token}/v360/seg0.ts`);
  console.log(
    `   note: encrypted segment after session end -> HTTP ${segAfter.status} (design: still served, useless without the key)`,
  );

  // ── 6. another student cannot start a session on this lesson ───────────
  console.log('\n=== 6. CROSS-USER AND CROSS-COURSE ===');
  const outsiderSess = await api('/playback/sessions', {
    method: 'POST',
    token: outsider.token,
    body: { lessonId: lesson.id },
  });
  check(
    'a non-enrolled student still cannot obtain a session',
    outsiderSess.status >= 400,
    `HTTP ${outsiderSess.status}`,
  );

  const otherCourseLesson = await prisma.lesson.findFirst({
    where: { isFreePreview: false, unit: { course: { tenantId: { not: teacher.id } } } },
  });
  if (otherCourseLesson) {
    const r = await api('/playback/sessions', {
      method: 'POST',
      token: enrolled.token,
      body: { lessonId: otherCourseLesson.id },
    });
    check(
      "a session cannot be started on another academy's gated lesson",
      r.status >= 400,
      `HTTP ${r.status}`,
    );
  }

  // ── 7. expiry ──────────────────────────────────────────────────────────
  console.log('\n=== 7. EXPIRY ===');
  check('the token carries an expiry', typeof decoded.exp === 'number', `exp=${decoded.exp}`);
  const ttl = decoded.exp - Math.floor(Date.now() / 1000);
  check('the expiry is short-lived (<= 15 minutes)', ttl > 0 && ttl <= 900, `${ttl}s remaining`);
  // Forge an already-expired token body. Without the secret the signature will
  // not verify, so this asserts the ordering: signature first, then expiry —
  // either refusal is correct, a 200 is not.
  const expiredBody =
    Buffer.from(JSON.stringify({ ...decoded, exp: 1 }))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '') +
    '.' +
    token.split('.')[1];
  check(
    'an expired/forged token is refused',
    (await api(`/playback/hls/${expiredBody}/master.m3u8`)).status >= 400,
    '',
  );

  // ── 8. raw storage must not be reachable through the API ───────────────
  console.log('\n=== 8. RAW STORAGE OBJECTS ===');
  for (const p of [
    `/playback/hls/${asset.id}/master.m3u8`, // asset id where a token belongs
    `/files/hls/${asset.id}/v360/seg0.ts`,
    `/storage/hls/${asset.id}/master.m3u8`,
  ]) {
    const r = await api(p);
    check(`${p.slice(0, 44)}… is not served`, r.status >= 400, `HTTP ${r.status}`);
  }
} catch (e) {
  console.error('\nERROR:', e.message);
  fail++;
} finally {
  for (const id of made.enrolments)
    await prisma.enrollment.delete({ where: { id } }).catch(() => {});
  for (const id of made.lessons) await prisma.lesson.delete({ where: { id } }).catch(() => {});
  for (const id of made.students) {
    await prisma.playbackSession.deleteMany({ where: { studentId: id } }).catch(() => {});
    await prisma.studentProfile.delete({ where: { id } }).catch(() => {});
  }
  for (const id of made.courses) {
    await prisma.courseUnit.deleteMany({ where: { courseId: id } }).catch(() => {});
    await prisma.course.delete({ where: { id } }).catch(() => {});
  }
  for (const id of made.assets) {
    await rm(path.join(STORAGE, 'hls', id), { recursive: true, force: true }).catch(() => {});
    await prisma.videoAsset.delete({ where: { id } }).catch(() => {});
  }
  for (const id of made.keys)
    await prisma.hlsEncryptionKey.delete({ where: { id } }).catch(() => {});
  for (const id of made.users) await prisma.user.delete({ where: { id } }).catch(() => {});
  await prisma.$disconnect();
}

console.log(
  `\n${fail === 0 ? 'HLS GATE PASS' : `HLS GATE — ${fail} FAILURE(S)`}  —  ${pass} passed, ${fail} failed`,
);
if (findings.length) {
  console.log('\nfailures:');
  for (const f of findings) console.log('  ' + f);
}
process.exit(fail === 0 ? 0 : 1);
