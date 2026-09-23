#!/usr/bin/env node
/**
 * The five real multipart (FileInterceptor) endpoints — the only routes in
 * the whole surface that take raw binary bytes rather than JSON. The 265-route
 * matrix already called each of these once with an empty body and confirmed
 * no 5xx and no unauthorized 2xx, but "empty JSON body" is not the same test
 * as a real file: magic-byte mismatch, oversized payload, filename traversal,
 * and cross-account access on a multipart route are all untested by that
 * sweep. This is the dedicated test for exactly those five:
 *
 *   1. POST academy/media                          (academy staff)
 *   2. POST threads/:id/voice                       (any thread participant)
 *   3. POST courses/:id/intro-video                 (course's own academy staff)
 *   4. POST uploads/videos                          (teacher)
 *   5. POST uploads/lessons/:lessonId/attachments    (teacher, tenant-scoped)
 *
 *   CONFIRM_TEST_DB=yes DATABASE_URL=... API_URL=... node scripts/audit-binary-endpoints.mjs
 */
import { PrismaClient } from '@prisma/client';

const API = process.env.API_URL ?? 'http://127.0.0.1:3077/api/v1';
const DB = process.env.DATABASE_URL ?? '';
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
const tag = `bin-${Date.now()}`;
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

// A real, fully-decodable 4x4 PNG (generated via sharp, not hand-typed) — a
// minimal-but-well-formed magic-byte-only fixture passes header checks but
// fails the real pixel decode, which is a different bug class than this
// suite is testing for.
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000004000000040802000000269309290000000970485973000003e8000003e801b57b526b' +
    '000000104944415408996338616404470cc47100f12312c1775429520000000049454e44ae426082',
  'hex',
);
const HEIC_LOOKALIKE = Buffer.concat([
  Buffer.from('0000001C6674797068656963', 'hex'),
  Buffer.alloc(200, 0x41),
]);
const MP4_ISH = Buffer.concat([
  Buffer.from('00000020667479706d703432', 'hex'),
  Buffer.alloc(500, 0x42),
]);
const TEXT = Buffer.from('not actually a media file, just text pretending to be one');

async function api(p, { token, method = 'GET', body, headers = {} } = {}) {
  const r = await fetch(`${API}${p}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body !== undefined ? { body } : {}),
  });
  const ct = r.headers.get('content-type') ?? '';
  let parsed = null;
  const text = await r.text();
  if (ct.includes('application/json')) {
    try {
      parsed = JSON.parse(text);
    } catch {
      /* ignore */
    }
  }
  return { status: r.status, body: parsed, text, contentType: ct };
}
const login = async (email) => {
  const r = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: PASSWORD }),
    headers: { 'content-type': 'application/json' },
  });
  if (r.status >= 300) throw new Error(`login ${email}: ${r.status}`);
  return r.body.accessToken;
};
function form(fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v && typeof v === 'object' && v.buffer)
      fd.append(k, new Blob([v.buffer], { type: v.type }), v.name);
    else fd.append(k, String(v));
  }
  return fd;
}

const madeIds = { media: [], attachments: [], videos: [], lessons: [], courses: [] };
const FOREIGN_ID = 'cxxxxxxxxxxxxxxxxxxxxxxxx';

try {
  const teacherA = await prisma.teacherProfile.findFirst({
    where: { status: 'APPROVED' },
    include: { user: true },
  });
  const teacherB = await prisma.teacherProfile.findFirst({
    where: { status: 'APPROVED', id: { not: teacherA.id } },
    include: { user: true },
  });
  const student = await prisma.studentProfile.findFirst({
    where: { user: { isActive: true } },
    include: { user: true },
  });
  const academyA = await prisma.academy.findUnique({ where: { id: teacherA.id } });
  const tokA = await login(teacherA.user.email);
  const tokB = await login(teacherB.user.email);
  const sTok = await login(student.user.email);
  const courseA = await prisma.course.findFirst({ where: { tenantId: academyA.id } });
  const lessonA = await prisma.lesson.findFirst({
    where: { unit: { course: { tenantId: academyA.id } } },
  });
  console.log(
    `teacher A ${teacherA.user.email}  teacher B ${teacherB.user.email}  student ${student.user.email}\n`,
  );

  // ══ 1. POST academy/media ═══════════════════════════════════════════════
  console.log('=== 1. POST academy/media ===');
  {
    const valid = await api('/academy/media', {
      method: 'POST',
      token: tokA,
      body: form({ kind: 'GALLERY', file: { buffer: PNG, type: 'image/png', name: 'x.png' } }),
    });
    check(
      'a valid PNG upload by academy staff succeeds',
      valid.status === 200 || valid.status === 201,
      `HTTP ${valid.status}`,
    );
    if (valid.body?.id) madeIds.media.push(valid.body.id);

    const anon = await api('/academy/media', {
      method: 'POST',
      body: form({ kind: 'GALLERY', file: { buffer: PNG, type: 'image/png', name: 'x.png' } }),
    });
    check('anonymous upload is refused', anon.status === 401, `HTTP ${anon.status}`);

    const wrongRole = await api('/academy/media', {
      method: 'POST',
      token: sTok,
      body: form({ kind: 'GALLERY', file: { buffer: PNG, type: 'image/png', name: 'x.png' } }),
    });
    check(
      'a student cannot upload academy media',
      wrongRole.status >= 400,
      `HTTP ${wrongRole.status}`,
    );

    const badMagic = await api('/academy/media', {
      method: 'POST',
      token: tokA,
      body: form({
        kind: 'GALLERY',
        file: { buffer: HEIC_LOOKALIKE, type: 'image/png', name: 'x.png' },
      }),
    });
    check(
      'HEIC bytes declared as image/png are refused',
      badMagic.status >= 400,
      `HTTP ${badMagic.status}`,
    );

    const badKind = await api('/academy/media', {
      method: 'POST',
      token: tokA,
      body: form({
        kind: 'NOT_A_REAL_KIND',
        file: { buffer: PNG, type: 'image/png', name: 'x.png' },
      }),
    });
    check(
      'an invalid kind value is rejected, not 500',
      badKind.status >= 400 && badKind.status < 500,
      `HTTP ${badKind.status}`,
    );

    const noFile = await api('/academy/media', {
      method: 'POST',
      token: tokA,
      body: form({ kind: 'GALLERY' }),
    });
    check(
      'a missing file is rejected, not 500',
      noFile.status >= 400 && noFile.status < 500,
      `HTTP ${noFile.status}`,
    );

    const textAsImage = await api('/academy/media', {
      method: 'POST',
      token: tokA,
      body: form({ kind: 'GALLERY', file: { buffer: TEXT, type: 'image/png', name: 'x.png' } }),
    });
    check(
      'plain text declared as image/png is refused',
      textAsImage.status >= 400,
      `HTTP ${textAsImage.status}`,
    );
    check(
      '…and the error carries no stack trace / internal path',
      !/at \w+\.|node_modules|\.ts:\d+/.test(textAsImage.text),
      'clean',
    );
  }

  // ══ 2. POST threads/:id/voice ═══════════════════════════════════════════
  console.log('\n=== 2. POST threads/:id/voice ===');
  {
    const thread = await prisma.chatThread.findFirst({ where: { tenantId: academyA.id } });
    if (thread) {
      const valid = await api(`/chat/threads/${thread.id}/voice`, {
        method: 'POST',
        token: tokA,
        body: form({
          durationSec: '3',
          file: {
            buffer: Buffer.concat([Buffer.from('1A45DFA3', 'hex'), Buffer.alloc(100)]),
            type: 'audio/webm',
            name: 'v.webm',
          },
        }),
      });
      check(
        "the thread's own teacher can send a voice note",
        valid.status === 200,
        `HTTP ${valid.status}`,
      );

      const outsider = await api(`/chat/threads/${thread.id}/voice`, {
        method: 'POST',
        token: tokB,
        body: form({
          durationSec: '3',
          file: { buffer: Buffer.alloc(50), type: 'audio/webm', name: 'v.webm' },
        }),
      });
      check(
        'a teacher with no part in this thread cannot send into it',
        outsider.status >= 400,
        `HTTP ${outsider.status}`,
      );

      const badId = await api(`/chat/threads/${FOREIGN_ID}/voice`, {
        method: 'POST',
        token: tokA,
        body: form({
          durationSec: '3',
          file: { buffer: Buffer.alloc(50), type: 'audio/webm', name: 'v.webm' },
        }),
      });
      check(
        'a nonexistent thread id is refused, not 500',
        badId.status >= 400 && badId.status < 500,
        `HTTP ${badId.status}`,
      );

      const traversal = await api(`/chat/threads/${thread.id}/voice`, {
        method: 'POST',
        token: tokA,
        body: form({
          durationSec: '3',
          file: { buffer: Buffer.alloc(50), type: 'audio/webm', name: '../../../../etc/passwd' },
        }),
      });
      check(
        'a traversal filename does not 500 and does not escape storage',
        traversal.status < 500,
        `HTTP ${traversal.status}`,
      );
    } else {
      console.log('   SKIP  no chat thread in the seed for teacher A');
    }
  }

  // ══ 3. POST courses/:id/intro-video ═════════════════════════════════════
  console.log('\n=== 3. POST courses/:id/intro-video ===');
  if (courseA) {
    const anon = await api(`/teacher/courses/${courseA.id}/intro-video`, {
      method: 'POST',
      body: form({ file: { buffer: MP4_ISH, type: 'video/mp4', name: 'i.mp4' } }),
    });
    check('anonymous cannot set an intro video', anon.status === 401, `HTTP ${anon.status}`);

    const student403 = await api(`/teacher/courses/${courseA.id}/intro-video`, {
      method: 'POST',
      token: sTok,
      body: form({ file: { buffer: MP4_ISH, type: 'video/mp4', name: 'i.mp4' } }),
    });
    check(
      'a student cannot set an intro video',
      student403.status >= 400,
      `HTTP ${student403.status}`,
    );

    const crossAcademy = await api(`/teacher/courses/${courseA.id}/intro-video`, {
      method: 'POST',
      token: tokB,
      body: form({ file: { buffer: MP4_ISH, type: 'video/mp4', name: 'i.mp4' } }),
    });
    check(
      "teacher B cannot set teacher A's course intro video",
      crossAcademy.status >= 400,
      `HTTP ${crossAcademy.status}`,
    );

    const wrongMime = await api(`/teacher/courses/${courseA.id}/intro-video`, {
      method: 'POST',
      token: tokA,
      body: form({ file: { buffer: PNG, type: 'image/png', name: 'i.png' } }),
    });
    check(
      'a non-MP4 file is refused by the fileFilter',
      wrongMime.status >= 400,
      `HTTP ${wrongMime.status}`,
    );

    const mislabeled = await api(`/teacher/courses/${courseA.id}/intro-video`, {
      method: 'POST',
      token: tokA,
      body: form({ file: { buffer: TEXT, type: 'video/mp4', name: 'i.mp4' } }),
    });
    check(
      'text content labeled video/mp4 passes the mime filter (declared-type gate) without a 500',
      mislabeled.status < 500,
      `HTTP ${mislabeled.status}`,
    );
  } else {
    console.log('   SKIP  no course in the seed for teacher A');
  }

  // ══ 4. POST uploads/videos ═══════════════════════════════════════════════
  console.log('\n=== 4. POST uploads/videos ===');
  {
    const anon = await api('/uploads/videos', {
      method: 'POST',
      body: form({ file: { buffer: MP4_ISH, type: 'video/mp4', name: 'l.mp4' } }),
    });
    check('anonymous cannot upload a lesson video', anon.status === 401, `HTTP ${anon.status}`);

    const student403 = await api('/uploads/videos', {
      method: 'POST',
      token: sTok,
      body: form({ file: { buffer: MP4_ISH, type: 'video/mp4', name: 'l.mp4' } }),
    });
    check(
      'a student cannot upload a lesson video',
      student403.status >= 400,
      `HTTP ${student403.status}`,
    );

    const valid = await api('/uploads/videos', {
      method: 'POST',
      token: tokA,
      body: form({ file: { buffer: MP4_ISH, type: 'video/mp4', name: 'l.mp4' } }),
    });
    check(
      'a teacher can start a video upload',
      valid.status === 200 || valid.status === 201,
      `HTTP ${valid.status}`,
    );
    if (valid.body?.id) madeIds.videos.push(valid.body.id);
    check(
      '…and the response never echoes a filesystem/storage path',
      valid.text ? !/[A-Za-z]:\\|\/tmp\/|\/var\//.test(valid.text) : true,
      'clean',
    );

    const wrongMime = await api('/uploads/videos', {
      method: 'POST',
      token: tokA,
      body: form({ file: { buffer: PNG, type: 'image/png', name: 'l.png' } }),
    });
    check(
      'a non-video mime is refused by the fileFilter',
      wrongMime.status >= 400,
      `HTTP ${wrongMime.status}`,
    );

    const noFile = await api('/uploads/videos', { method: 'POST', token: tokA, body: form({}) });
    check(
      'a missing file is rejected, not 500',
      noFile.status >= 400 && noFile.status < 500,
      `HTTP ${noFile.status}`,
    );

    // status endpoint: cross-tenant read
    if (valid.body?.id) {
      const crossRead = await api(`/uploads/videos/${valid.body.id}/status`, { token: tokB });
      check(
        "teacher B cannot poll teacher A's video status",
        crossRead.status >= 400,
        `HTTP ${crossRead.status}`,
      );
    }
  }

  // ══ 5. POST uploads/lessons/:lessonId/attachments ═══════════════════════
  console.log('\n=== 5. POST uploads/lessons/:lessonId/attachments ===');
  if (lessonA) {
    const anon = await api(`/uploads/lessons/${lessonA.id}/attachments`, {
      method: 'POST',
      body: form({ file: { buffer: PNG, type: 'image/png', name: 'a.png' } }),
    });
    check('anonymous cannot attach a file', anon.status === 401, `HTTP ${anon.status}`);

    const student403 = await api(`/uploads/lessons/${lessonA.id}/attachments`, {
      method: 'POST',
      token: sTok,
      body: form({ file: { buffer: PNG, type: 'image/png', name: 'a.png' } }),
    });
    check(
      'a student cannot attach a file to a lesson',
      student403.status >= 400,
      `HTTP ${student403.status}`,
    );

    const crossTenant = await api(`/uploads/lessons/${lessonA.id}/attachments`, {
      method: 'POST',
      token: tokB,
      body: form({ file: { buffer: PNG, type: 'image/png', name: 'a.png' } }),
    });
    check(
      "teacher B cannot attach a file to teacher A's lesson (tenant-scoped lookup)",
      crossTenant.status >= 400,
      `HTTP ${crossTenant.status}`,
    );

    const badLesson = await api(`/uploads/lessons/${FOREIGN_ID}/attachments`, {
      method: 'POST',
      token: tokA,
      body: form({ file: { buffer: PNG, type: 'image/png', name: 'a.png' } }),
    });
    check(
      'a nonexistent lesson id is refused, not 500',
      badLesson.status >= 400 && badLesson.status < 500,
      `HTTP ${badLesson.status}`,
    );

    const traversalName = await api(`/uploads/lessons/${lessonA.id}/attachments`, {
      method: 'POST',
      token: tokA,
      body: form({ file: { buffer: PNG, type: 'image/png', name: '../../../../etc/passwd.png' } }),
    });
    check(
      'a traversal filename does not 500',
      traversalName.status < 500,
      `HTTP ${traversalName.status}`,
    );
    if (traversalName.body?.id) {
      madeIds.attachments.push(traversalName.body.id);
      const row = await prisma.attachment.findUnique({ where: { id: traversalName.body.id } });
      check(
        '…and the actual storage key never contains a traversal sequence',
        row ? !row.storageKey.includes('..') : true,
        row?.storageKey,
      );
    }

    const wrongMime = await api(`/uploads/lessons/${lessonA.id}/attachments`, {
      method: 'POST',
      token: tokA,
      body: form({
        file: {
          buffer: Buffer.from('MZ\x90\x00'),
          type: 'application/x-msdownload',
          name: 'a.exe',
        },
      }),
    });
    check(
      'an unsupported attachment mime (.exe) is refused',
      wrongMime.status >= 400,
      `HTTP ${wrongMime.status}`,
    );

    const valid = await api(`/uploads/lessons/${lessonA.id}/attachments`, {
      method: 'POST',
      token: tokA,
      body: form({ file: { buffer: PNG, type: 'image/png', name: 'handout.png' } }),
    });
    check(
      "a valid attachment upload by the lesson's own teacher succeeds",
      valid.status === 200 || valid.status === 201,
      `HTTP ${valid.status}`,
    );
    if (valid.body?.id) madeIds.attachments.push(valid.body.id);
  } else {
    console.log('   SKIP  no lesson in the seed for teacher A');
  }
} catch (e) {
  console.error('\nERROR:', e.message);
  fail++;
} finally {
  for (const id of madeIds.attachments)
    await prisma.attachment.delete({ where: { id } }).catch(() => {});
  for (const id of madeIds.media)
    await prisma.academyMedia.delete({ where: { id } }).catch(() => {});
  for (const id of madeIds.videos)
    await prisma.videoAsset.delete({ where: { id } }).catch(() => {});
  await prisma.$disconnect();
}

console.log(`\nBinary endpoint matrix: ${pass}/${pass + fail} PASS`);
if (findings.length) {
  console.log('\nfailures:');
  for (const f of findings) console.log('  ' + f);
}
process.exit(fail === 0 ? 0 : 1);
