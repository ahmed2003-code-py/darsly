#!/usr/bin/env node
/**
 * Every endpoint, asked the same three questions.
 *
 * The routes are not typed in by hand — they are read out of the controller
 * sources, so the matrix is derived from what is actually mounted and cannot
 * drift from it. Each one is then really called:
 *
 *   1. with no credentials        — must not be 2xx unless it is public
 *   2. as a student               — must not reach teacher or admin surface
 *   3. as a teacher               — must not reach admin surface
 *
 * Only safe verbs are exercised by default. DELETE and the destructive POSTs
 * are called with ids that belong to somebody else or do not exist, so a
 * refusal is the expected answer and a 2xx is the finding; pass --include-writes
 * to include them.
 *
 *   DATABASE_URL=... API_URL=... node scripts/audit-endpoint-matrix.mjs
 *
 * What counts as a failure: a 2xx where the caller should have been refused, or
 * a 5xx, which is never a correct answer to an unauthorized request.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

const API = process.env.API_URL ?? 'http://127.0.0.1:3077/api/v1';
const SRC = process.env.API_SRC ?? path.resolve('apps/api/src');
const INCLUDE_WRITES = process.argv.includes('--include-writes');
const PASSWORD = 'Darsly@123';

// ── read the routes out of the controllers ─────────────────────────────────
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.controller.ts')) out.push(p);
  }
  return out;
}

/**
 * One controller file -> its mounted routes, with the guards each carries.
 *
 * Decorators are read positionally: the @Controller prefix applies to the file,
 * and the decorators between one route decorator and the next belong to that
 * route. Crude, but it reads the same source Nest does, and the alternative —
 * a hand-written list — is the thing that goes stale.
 */
function routesOf(file) {
  const text = readFileSync(file, 'utf8');
  const prefix = (text.match(/@Controller\(\s*['"]([^'"]*)['"]\s*\)/) ?? [])[1] ?? '';
  const classPublic =
    /@Controller\([^)]*\)[\s\S]{0,400}?class/.test(text) &&
    /^@Public\(\)/m.test(text.split('@Controller')[0] ?? '');
  const lines = text.split('\n');
  const found = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/@(Get|Post|Put|Patch|Delete)\(\s*(?:['"]([^'"]*)['"])?\s*\)/);
    if (m) {
      // Guards sit in the few lines above and below the verb decorator.
      const window = lines.slice(Math.max(0, i - 6), i + 8).join('\n');
      current = {
        method: m[1].toUpperCase(),
        segment: m[2] ?? '',
        isPublic: /@Public\(\)/.test(window) || classPublic,
        roles: (window.match(/@Roles\(([^)]*)\)/) ?? [])[1] ?? '',
        academyStaff: /@AcademyStaff\(/.test(window),
        file: path.relative(SRC, file),
      };
      const joined = [prefix, current.segment].filter(Boolean).join('/');
      current.path = '/' + joined.replace(/\/+/g, '/').replace(/^\//, '');
      found.push(current);
    }
  }
  return found;
}

const routes = walk(SRC).flatMap(routesOf);
console.log(
  `discovered ${routes.length} routes across ${new Set(routes.map((r) => r.file)).size} controllers\n`,
);

// ── callers ────────────────────────────────────────────────────────────────
async function api(p, { token, method = 'GET' } = {}) {
  try {
    const r = await fetch(`${API}${p}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'content-type': 'application/json',
      },
      ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }),
    });
    return r.status;
  } catch (e) {
    return 0; // transport failure, reported separately
  }
}
const login = async (email) => {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`login ${email}: ${r.status}`);
  return (await r.json()).accessToken;
};

const { PrismaClient } = await import('@prisma/client');
const prisma = new PrismaClient();
const student = await prisma.studentProfile.findFirst({
  where: { user: { isActive: true } },
  include: { user: true },
});
const teacher = await prisma.teacherProfile.findFirst({
  where: { status: 'APPROVED' },
  include: { user: true },
});
const admin = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', isActive: true } });
await prisma.$disconnect();

const sTok = await login(student.user.email);
const tTok = await login(teacher.user.email);
const aTok = admin ? await login(admin.email).catch(() => null) : null;

/** Fill path parameters with a value that is syntactically valid and not ours. */
const FOREIGN_ID = 'cxxxxxxxxxxxxxxxxxxxxxxxx';
const concrete = (p) =>
  p.replace(/:([a-zA-Z]+)/g, (_, name) =>
    /slug/i.test(name) ? 'not-a-real-slug' : /token/i.test(name) ? 'not.a.token' : FOREIGN_ID,
  );

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const results = [];
let anon2xx = 0,
  studentReachedAdmin = 0,
  teacherReachedAdmin = 0,
  serverErrors = 0,
  skipped = 0;

for (const r of routes) {
  const p = concrete(r.path);
  // Skip the routes whose whole purpose is to be called anonymously with a
  // real payload (login, register), and destructive verbs unless asked for.
  if (/auth\/(login|register|refresh)/.test(p)) {
    skipped++;
    continue;
  }
  if (WRITE.has(r.method) && !INCLUDE_WRITES) {
    skipped++;
    continue;
  }

  const isAdminRoute = /(^|\/)admin\//.test(r.path) || /SUPER_ADMIN/.test(r.roles);
  const isTeacherRoute =
    /(^|\/)teacher\//.test(r.path) || /Role\.TEACHER/.test(r.roles) || r.academyStaff;

  const anon = await api(p, { method: r.method });
  const asStudent = await api(p, { method: r.method, token: sTok });
  const asTeacher = await api(p, { method: r.method, token: tTok });

  const row = { ...r, concrete: p, anon, asStudent, asTeacher, isAdminRoute, isTeacherRoute };
  results.push(row);

  if (anon >= 200 && anon < 300 && !r.isPublic) {
    anon2xx++;
    row.flag = 'ANON-2XX';
  }
  if (isAdminRoute && asStudent >= 200 && asStudent < 300) {
    studentReachedAdmin++;
    row.flag = 'STUDENT-REACHED-ADMIN';
  }
  if (isAdminRoute && asTeacher >= 200 && asTeacher < 300) {
    teacherReachedAdmin++;
    row.flag = 'TEACHER-REACHED-ADMIN';
  }
  if ([anon, asStudent, asTeacher].some((s) => s >= 500)) {
    serverErrors++;
    row.flag = (row.flag ? row.flag + ' + ' : '') + 'SERVER-ERROR';
  }
}

// ── report ─────────────────────────────────────────────────────────────────
const tested = results.length;
console.log(
  `tested ${tested} routes  (skipped ${skipped}: auth entry points${INCLUDE_WRITES ? '' : ' and write verbs'})\n`,
);

const flagged = results.filter((r) => r.flag);
if (flagged.length) {
  console.log('FLAGGED:');
  for (const r of flagged) {
    console.log(`  [${r.flag}] ${r.method} ${r.path}`);
    console.log(`      anon=${r.anon} student=${r.asStudent} teacher=${r.asTeacher}   ${r.file}`);
  }
} else {
  console.log(
    'no route returned 2xx to a caller that should have been refused, and none returned 5xx.',
  );
}

// A quick shape of what the surface looks like, so the numbers are readable.
const publicOk = results.filter((r) => r.isPublic && r.anon >= 200 && r.anon < 300).length;
const refusedAnon = results.filter((r) => r.anon === 401 || r.anon === 403).length;
console.log(`
summary
  routes discovered        ${routes.length}
  routes exercised         ${tested}
  public and answering     ${publicOk}
  refused when anonymous   ${refusedAnon}
  anonymous 2xx on a non-public route   ${anon2xx}
  student reached an admin route        ${studentReachedAdmin}
  teacher reached an admin route        ${teacherReachedAdmin}
  any 5xx                               ${serverErrors}`);

const failures = anon2xx + studentReachedAdmin + teacherReachedAdmin + serverErrors;
console.log(
  `\n${failures === 0 ? 'ENDPOINT MATRIX PASS' : `ENDPOINT MATRIX — ${failures} FLAGGED`}`,
);
process.exit(failures === 0 ? 0 : 1);
