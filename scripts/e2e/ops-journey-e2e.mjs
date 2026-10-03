#!/usr/bin/env node
/**
 * Center Operations — the integrated journey, end to end, on the real API and
 * PostgreSQL, with the day's page and close driven in a real browser (Arabic
 * RTL, English LTR, phone width). One synthetic learner goes through
 * registration, a group, a real class, a QR card, the desk, attendance, a fee
 * and a partial payment, a follow-up case, a paper exam, Student 360, the
 * day's report, its close, a legitimate correction and the re-close — with
 * negative checks for permissions, tenancy, duplicates and races. Platform
 * money and online assessments are hashed before and after.
 *
 * LOCAL E2E DATABASE ONLY (fixture from desk-seed.cjs).
 * Usage: DATABASE_URL=…/darsly_c3e2e WEB=http://localhost:4000 node scripts/e2e/ops-journey-e2e.mjs
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const { PrismaClient } = require('@prisma/client');

const url = new URL(process.env.DATABASE_URL ?? 'postgresql://x/none');
if (url.pathname !== '/darsly_c3e2e' || !['localhost', '127.0.0.1'].includes(url.hostname))
  throw new Error('refusing: not the local e2e database');
const F = JSON.parse(readFileSync(join(tmpdir(), 'darsly-desk-e2e.json'), 'utf8'));
const OUT = process.env.E2E_OUT ?? join(tmpdir(), 'darsly-ops-journey');
mkdirSync(OUT, { recursive: true });
const WEB = process.env.WEB ?? 'http://localhost:4000';
const API = `${WEB}/api/v1`;
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const AR = JSON.parse(
  readFileSync(new URL('../../apps/web/src/i18n/ar.json', import.meta.url), 'utf8'),
);
const EN = JSON.parse(
  readFileSync(new URL('../../apps/web/src/i18n/en.json', import.meta.url), 'utf8'),
);
const db = new PrismaClient();
const A = F.academyId;
const GA = F.groups.A.id;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = () => randomUUID().replace(/-/g, '');
const results = [];
let failed = 0;
const ok = (name, cond, detail = '') => {
  const line = `${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? ` — ${detail}` : ''}`;
  results.push(line);
  if (!cond) failed++;
  console.log(line);
};
const hashOf = async (tables) => {
  const out = {};
  for (const t of tables)
    out[t] = (
      await db.$queryRawUnsafe(
        `SELECT count(*)::int n, md5(coalesce(string_agg(t::text,'|' ORDER BY id),'')) h FROM "${t}" t`,
      )
    )[0];
  return out;
};
const UNRELATED = [
  'Payment',
  'PaymentEvent',
  'LedgerTransaction',
  'LedgerEntry',
  'WalletTransaction',
  'PayoutRequest',
  'LivePurchase',
  'CommercialTerms',
  'Quiz',
  'QuizAttempt',
  'Assignment',
  'AssignmentSubmission',
  'Challenge',
  'ChallengeAttempt',
  'PaperImport',
  'LiveSession',
];

const tokens = {};
async function token(who) {
  if (tokens[who]) return tokens[who];
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: F.emails[who], password: F.password }),
  });
  const j = await r.json();
  if (!j.accessToken) throw new Error(`login ${who}: ${r.status}`);
  return (tokens[who] = j.accessToken);
}
async function as(who, method, path, body, academy = A) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await token(who)}`,
      'x-academy-id': academy,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, json };
}
const must = (r, what) => {
  if (r.status >= 300)
    throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  return r.json;
};
const code = (r) => r.json?.code ?? r.status;

async function login(b, who, { lang = 'ar', width = 1280 } = {}) {
  const ctx = await b.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width, height: 900 });
  await p.evaluateOnNewDocument((l) => {
    try {
      localStorage.setItem('darsly_lang', l);
    } catch {
      /* first paint */
    }
  }, lang);
  await p.goto(`${WEB}/login`, { waitUntil: 'networkidle2' });
  await p.type('input[autocomplete=username]', F.emails[who]);
  await p.type('input[autocomplete=current-password]', F.password);
  await Promise.all([
    p.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => null),
    p.keyboard.press('Enter'),
  ]);
  await sleep(1000);
  return p;
}
const main = (p) =>
  p.evaluate(() => document.querySelector('main')?.innerText ?? document.body.innerText);
const dialogText = (p) =>
  p.evaluate(() =>
    [...document.querySelectorAll('[role=dialog]')].map((d) => d.innerText).join('\n'),
  );
async function waitFor(fn, ms = 15000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn()) return true;
    await sleep(200);
  }
  return false;
}
const clickText = (p, sel, text) =>
  p.evaluate(
    (s, x) => {
      const el = [...document.querySelectorAll(s)]
        .reverse()
        .find((e) => e.textContent.trim().includes(x) && !e.disabled);
      el?.click();
      return !!el;
    },
    sel,
    text,
  );
const shot = (p, n) => p.screenshot({ path: join(OUT, `${n}.png`), fullPage: true });

const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
const before = await hashOf(UNRELATED);
try {
  // 1–2 Register a learner straight into group A (Reception).
  // Synthetic guardian number (never called or messaged). C1's duplicate rule is
  // name + phone: two children with the same name and no phone are two people.
  const phone = `+2010000096${String(Date.now() % 100).padStart(2, '0')}`;
  const body = {
    fullName: 'رحلة كاملة — طالب تجربة',
    groupId: GA,
    guardianName: 'ولي أمر تجربة',
    guardianPhone: phone,
  };
  const reg = must(
    await as('reception', 'POST', '/center-students', { requestKey: key(), ...body }),
    'register',
  );
  const S = { id: reg.student.id, studentId: reg.student.studentId, code: reg.student.code };
  const dup = await as('reception', 'POST', '/center-students', { requestKey: key(), ...body });
  const ids = await db.academyStudent.count({ where: { academyId: A, fullName: body.fullName } });
  ok(
    '1–2 registered once into group A; the same name + phone again is flagged as a possible duplicate, not silently re-created',
    !!S.id && code(dup) === 'STUDENT_POSSIBLE_DUPLICATE' && ids === 1,
    `second: ${code(dup)}`,
  );
  // 3 The real class on now.
  const cls = F.classes.A;
  ok(
    '3 a real scheduled class of group A is on now',
    !!(await db.groupSession.findUnique({ where: { id: cls } })),
  );
  // 4 Issue a QR card and resolve it at the desk.
  const card = must(await as('reception', 'POST', `/desk/cards/${S.id}/issue`, {}), 'card');
  const resolved = must(
    await as('reception', 'POST', '/desk/resolve', { token: card.token }),
    'resolve',
  );
  ok('4 QR card issued and resolved to the learner', JSON.stringify(resolved).includes(S.id));
  // 5 Check in by card; a repeat is not a second record.
  const ci = await Promise.all([
    as('reception', 'POST', '/desk/check-in', { token: card.token, sessionId: cls }),
    as('reception', 'POST', '/desk/check-in', { token: card.token, sessionId: cls }),
  ]);
  const recs = await db.attendanceRecord.findMany({
    where: { studentId: S.studentId, session: { groupSessionId: cls } },
  });
  ok(
    '5 checked in by card once (double scan = one record, PRESENT/LATE, method QR)',
    ci.every((r) => r.status < 300) &&
      recs.length === 1 &&
      ['PRESENT', 'LATE'].includes(recs[0].status) &&
      recs[0].method === 'QR',
  );
  // 7–9 A fee, a partial payment, the receipt, the balance; a retried payment is one payment.
  must(
    await as('owner', 'POST', `/center-fees/students/${S.id}/charges`, {
      requestKey: key(),
      description: 'اشتراك الشهر',
      amountCents: 50_000,
      dueOn: new Intl.DateTimeFormat('en-CA', {
        timeZone: (await db.academy.findUnique({ where: { id: A } })).timezone,
      }).format(new Date()),
    }),
    'charge',
  );
  const pk = key();
  const pays = await Promise.all([
    as('reception', 'POST', `/center-fees/students/${S.id}/collections`, {
      requestKey: pk,
      amountCents: 20_000,
      method: 'CASH',
    }),
    as('reception', 'POST', `/center-fees/students/${S.id}/collections`, {
      requestKey: pk,
      amountCents: 20_000,
      method: 'CASH',
    }),
  ]);
  const receipt = pays.find((p) => p.status < 300)?.json?.receipt;
  const nCol = await db.centerCollection.count({ where: { academyStudentId: S.id } });
  const sum = must(
    await as('reception', 'GET', `/center-fees/students/${S.id}/summary`),
    'summary',
  );
  const rc = must(
    await as('reception', 'GET', `/center-fees/collections/${receipt.collectionId}`),
    'receipt',
  );
  ok(
    '7–9 charge 500, partial 200 once (double submit), receipt numbered, 300 still owed',
    nCol === 1 && !!rc.receiptNumber && sum.outstandingCents === 30_000,
    `owed ${sum.outstandingCents}`,
  );
  // 10 A follow-up case: opened, assigned, a contact logged.
  const fu = must(
    await as('owner', 'POST', '/follow-up/cases', {
      requestKey: key(),
      academyStudentId: S.id,
      reason: 'MANUAL',
      note: 'متابعة بعد التسجيل',
    }),
    'case',
  );
  must(
    await as('owner', 'POST', `/follow-up/cases/${fu.case.id}/assign`, {
      assignedToUserId: (await db.user.findFirst({ where: { email: F.emails.reception } })).id,
    }),
    'assign',
  );
  must(
    await as('reception', 'POST', `/follow-up/students/${S.id}/contacts`, {
      requestKey: key(),
      channel: 'PHONE_CALL',
      outcome: 'REACHED',
      party: 'OTHER',
      followUpId: fu.case.id,
    }),
    'contact',
  );
  ok(
    '10 follow-up case opened, assigned to Reception, contact logged',
    (await db.studentContact.count({ where: { academyStudentId: S.id } })) === 1,
  );
  // 11–12 A paper exam: the learner scored, everyone else absent; published.
  const today = (await as('owner', 'GET', '/daily-ops/day')).json.date;
  const ex = must(
    await as('teacher', 'POST', '/paper-exams', {
      requestKey: key(),
      groupId: GA,
      title: 'رحلة — امتحان الشهر',
      examDate: today,
      maxScore: 3000,
      passScore: 1500,
    }),
    'exam',
  ).exam;
  const roster = must(await as('teacher', 'GET', `/paper-exams/${ex.id}`), 'sheet').rows;
  must(
    await as('teacher', 'PUT', `/paper-exams/${ex.id}/results`, {
      requestKey: key(),
      rows: roster.map((r) =>
        r.academyStudentId === S.id
          ? { academyStudentId: S.id, status: 'SCORED', score: 2450 }
          : { academyStudentId: r.academyStudentId, status: 'ABSENT' },
      ),
    }),
    'marks',
  );
  must(await as('teacher', 'POST', `/paper-exams/${ex.id}/publish`), 'publish');
  ok(
    '11–12 exam recorded and published (the new learner is on the roster)',
    roster.some((r) => r.academyStudentId === S.id),
  );
  // 13 Grade visibility.
  const tg = await as('teacher', 'GET', `/paper-exams/by-student/${S.studentId}`);
  ok(
    '13 teacher sees the grade; Reception does not',
    tg.json.items?.[0]?.score === 2450 &&
      (await as('reception', 'GET', `/paper-exams/by-student/${S.studentId}`)).status === 403,
  );
  // 6 Close attendance (teacher, the group's teacher).
  must(await as('teacher', 'POST', `/class-ops/sessions/${cls}/close`), 'close attendance');

  // 14 Student 360 in the browser (owner): fees, follow-up, grades all about this learner.
  const o = await login(b, 'owner');
  await o.goto(`${WEB}/staff/students/${S.studentId}?academy=${A}`, { waitUntil: 'networkidle2' });
  const tab = async (label) => {
    await o.evaluate(
      (x) =>
        [...document.querySelectorAll('main [role=tab]')]
          .find((e) => e.textContent.trim() === x)
          ?.click(),
      label,
    );
    await sleep(1200);
    return main(o);
  };
  await waitFor(async () => (await main(o)).includes(AR.care.tab.grades));
  const tFees = await tab(AR.care.tab.fees);
  const tFu = await tab(AR.care.tab.followup);
  const tGr = await tab(AR.care.tab.grades);
  ok(
    "14 Student 360: the fees, follow-up and grades tabs all show this learner's records",
    /300|200/.test(tFees) && tFu.includes('متابعة بعد التسجيل') && /24\.5\s*\/\s*30/.test(tGr),
    '',
  );
  await shot(o, '360-grades');

  // 15 The day's report in the browser.
  await o.goto(`${WEB}/center/day?academy=${A}`, { waitUntil: 'networkidle2' });
  await waitFor(async () => (await main(o)).includes(AR.day.section.collections));
  const day = await main(o);
  const api = must(await as('owner', 'GET', '/daily-ops/day'), 'day');
  ok(
    '15 the day page shows classes, attendance, desk, collections, follow-up and exams',
    [
      AR.day.section.classes,
      AR.day.section.attendance,
      AR.day.section.desk,
      AR.day.section.collections,
      AR.day.section.followUp,
      AR.day.section.exams,
    ].every((x) => day.includes(x)),
  );
  ok(
    "15 …and the figures include this learner's check-in, the 200 collection, the case and the exam",
    api.figures.desk.checkIns >= 1 &&
      api.figures.collections.received.amountCents >= 20_000 &&
      api.figures.followUp.opened >= 1 &&
      api.figures.exams.published >= 1,
  );
  ok(
    '15 open items listed (classes still on, unclosed attendance) separate from facts',
    day.includes(AR.day.attention) && api.exceptions.length >= 1,
  );
  await shot(o, 'day-ar');

  // Negative: who may see and close the day.
  const foreign = await as('owner', 'GET', '/daily-ops/day', undefined, F.foreignAcademyId);
  ok(
    "neg: Reception and the teacher cannot open the day (403); another academy's day is not even found (404, no data)",
    (await as('reception', 'GET', '/daily-ops/day')).status === 403 &&
      (await as('teacher', 'GET', '/daily-ops/day')).status === 403 &&
      foreign.status === 404 &&
      !foreign.json?.figures,
  );
  const rp = await login(b, 'reception');
  ok('neg: Reception has no «اليوم» menu entry', !(await rp.$('a[href="/center/day"]')));
  await rp.close();

  // 16 Close the day in the browser: exceptions require a note; a double click is one close.
  await clickText(o, 'main button', AR.day.close);
  await waitFor(async () => (await dialogText(o)).includes(AR.day.note));
  await o.evaluate(() => document.querySelector('[role=dialog] textarea')?.focus());
  await o.keyboard.type('حصص لسه شغالة — هنقفل الحضور بعدين');
  const sb = await (
    await o.evaluateHandle(() => document.querySelector('[role=dialog] button[type=submit]'))
  )
    .asElement()
    .boundingBox();
  await o.mouse.click(sb.x + sb.width / 2, sb.y + sb.height / 2, { clickCount: 2, delay: 30 });
  await waitFor(
    async () =>
      (await db.centerDayClose.count({ where: { academyId: A } })) >= 1 && !(await dialogText(o)),
  );
  await sleep(500);
  const v1 = await db.centerDayClose.findMany({ where: { academyId: A } });
  ok(
    '16 closed with a note, once (double click), version 1',
    v1.length === 1 && v1[0].version === 1 && v1[0].exceptionNote?.includes('حصص'),
  );
  await waitFor(async () => (await main(o)).includes(AR.day.history));
  ok('16 the page shows the close and its history', (await main(o)).includes(AR.day.history));

  // Unchanged day: two re-closes at once (different keys, with reasons) — both refused, no meaningless version.
  const race = await Promise.all([
    as('owner', 'POST', '/daily-ops/close', {
      date: today,
      requestKey: key(),
      exceptionNote: 'سباق',
      reason: 'سباق أ',
    }),
    as('owner', 'POST', '/daily-ops/close', {
      date: today,
      requestKey: key(),
      exceptionNote: 'سباق',
      reason: 'سباق ب',
    }),
  ]);
  const vs = (
    await db.centerDayClose.findMany({ where: { academyId: A }, orderBy: { version: 'asc' } })
  ).map((x) => x.version);
  ok(
    'race: re-closing an unchanged day (twice at once) is refused — still only version 1',
    JSON.stringify(vs) === JSON.stringify([1]) && race.every((r) => code(r) === 'DAY_UNCHANGED'),
    vs.join(','),
  );

  // 17 A legitimate correction after the close: reverse the payment. History stays; the page shows drift.
  must(
    await as('owner', 'POST', `/center-fees/collections/${receipt.collectionId}/reverse`, {
      reason: 'اتسجل على الطالب الغلط',
    }),
    'reverse',
  );
  await o.reload({ waitUntil: 'networkidle2' });
  await waitFor(async () => (await main(o)).includes(AR.day.section.collections));
  const drift = must(await as('owner', 'GET', '/daily-ops/day'), 'day2');
  ok(
    '17 after a correction the page says what changed since the close',
    drift.latest.drift.includes('collections') &&
      (await main(o)).includes(AR.day.section.collections),
  );
  const snap = await db.centerDayClose.findFirst({ where: { academyId: A, version: 1 } });
  ok(
    '17 the earlier close is unchanged (append-only) and the receipt still exists, marked reversed',
    snap.figures.collections.reversedToday.amountCents === 0 &&
      !!(await db.centerCollection.findUnique({ where: { id: receipt.collectionId } })).reversedAt,
  );
  await clickText(o, 'main button', AR.day.closeAgain);
  await waitFor(async () => (await dialogText(o)).includes(AR.day.reason));
  const areas = await o.$$('[role=dialog] textarea');
  for (const [i, t] of areas.entries()) {
    await t.focus();
    await o.keyboard.type(
      i === areas.length - 1 ? 'تصحيح: إيصال اتلغى بعد القفل' : 'حصص لسه شغالة',
    );
  }
  await clickText(o, '[role=dialog] button[type=submit]', AR.day.closeAgain);
  await waitFor(async () => (await db.centerDayClose.count({ where: { academyId: A } })) === 2);
  const last = await db.centerDayClose.findFirst({
    where: { academyId: A },
    orderBy: { version: 'desc' },
  });
  ok(
    '17 closed again with a reason: version 2 records the reversal',
    last.version === 2 &&
      last.reason?.includes('تصحيح') &&
      last.figures.collections.reversedToday.amountCents === 20_000,
  );
  ok(
    'an open or closed day never blocks: attendance and money still work after the close',
    (await as('reception', 'GET', `/center-fees/students/${S.id}/summary`)).status === 200,
  );

  // English LTR and a phone.
  const e = await login(b, 'owner', { lang: 'en', width: 390 });
  await e.goto(`${WEB}/center/day?academy=${A}`, { waitUntil: 'networkidle2' });
  await waitFor(async () => (await main(e)).includes(EN.day.section.collections));
  ok(
    'English, phone (390): the day page is LTR, in English, with no sideways scroll',
    (await e.evaluate(() => document.documentElement.dir)) === 'ltr' &&
      (await main(e)).includes(EN.day.title) &&
      (await e.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1,
  );
  await shot(e, 'day-en-390');
  await e.close();
  const p = await login(b, 'owner', { width: 360 });
  await p.goto(`${WEB}/center/day?academy=${A}`, { waitUntil: 'networkidle2' });
  await waitFor(async () => (await main(p)).includes(AR.day.section.collections));
  ok(
    'Arabic, phone (360): no sideways scroll; no raw translation keys',
    (await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1 &&
      !/day\.|exams\.|err\./.test(await main(p)),
  );
  await shot(p, 'day-ar-360');
  await p.close();
  await o.close();

  // 18 Nothing unrelated changed.
  ok(
    '18 platform money, online assessments and Live untouched by the whole journey',
    JSON.stringify(await hashOf(UNRELATED)) === JSON.stringify(before),
  );
} catch (err) {
  ok('journey ran to the end', false, String(err?.stack ?? err).slice(0, 500));
} finally {
  writeFileSync(
    join(OUT, 'results.txt'),
    results.join('\n') + `\n${results.length - failed}/${results.length}\n`,
  );
  console.log(`\n${results.length - failed}/${results.length} — screenshots in ${OUT}`);
  await b.close();
  await db.$disconnect();
  process.exitCode = failed ? 1 : 0;
}
