#!/usr/bin/env node
/**
 * C6 paper exams & grades — real browser E2E: real Chrome, the real API, real
 * PostgreSQL, the fixture from desk-seed.cjs. A teacher creates an exam, types
 * the marks with the keyboard, meets an unsaved-changes guard, a refused
 * publication, a concurrent edit, publishes, makes a makeup; the owner
 * corrects; follow-up shows the low grade to those who may see grades only;
 * the desk still checks the learner in. Every outcome is checked in the
 * database; platform money, the C4 books and the online assessments are
 * hashed before and after and must not change.
 *
 * LOCAL E2E DATABASE ONLY. Flips the paperExams flag and a teacher's group
 * assignment in that database (and restores them) to see the UI react.
 *
 * Usage: DATABASE_URL=…/darsly_c3e2e WEB=http://localhost:4000 node scripts/e2e/exams-e2e.mjs
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const { PrismaClient } = require('@prisma/client');

const url = new URL(process.env.DATABASE_URL ?? 'postgresql://x/none');
if (url.pathname !== '/darsly_c3e2e' || !['localhost', '127.0.0.1'].includes(url.hostname))
  throw new Error('refusing: not the local e2e database');
const F = JSON.parse(readFileSync(join(tmpdir(), 'darsly-desk-e2e.json'), 'utf8'));
const OUT = process.env.E2E_OUT ?? join(tmpdir(), 'darsly-exams-e2e');
mkdirSync(OUT, { recursive: true });
const WEB = process.env.WEB ?? 'http://localhost:4000';
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const AR = JSON.parse(
  readFileSync(new URL('../../apps/web/src/i18n/ar.json', import.meta.url), 'utf8'),
);
const db = new PrismaClient();
const A = F.academyId;
const GA = F.groups.A.id;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const PLATFORM = [
  'Payment',
  'PaymentEvent',
  'LedgerTransaction',
  'LedgerEntry',
  'WalletTransaction',
  'PayoutRequest',
  'LivePurchase',
  'CommercialTerms',
];
const C4 = [
  'CenterFeePlan',
  'CenterCharge',
  'CenterAdjustment',
  'CenterCollection',
  'CenterAllocation',
];
const ONLINE = [
  'Quiz',
  'QuizQuestion',
  'QuizAttempt',
  'Assignment',
  'AssignmentSubmission',
  'Challenge',
  'ChallengeAttempt',
  'PaperImport',
];

async function login(b, who, { width = 1280, height = 900 } = {}) {
  const ctx = await b.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width, height });
  await p.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem('darsly_lang', 'ar');
    } catch {
      /* first paint */
    }
  });
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
const bodyText = (p) => p.evaluate(() => document.body.innerText);
const dialogText = (p) =>
  p.evaluate(() =>
    [...document.querySelectorAll('[role=dialog]')].map((d) => d.innerText).join('\n'),
  );
async function waitFor(fn, ms = 12000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn()) return true;
    await sleep(150);
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
/** The sheet's learner rows, in screen order: name and whether the input is there. */
const sheetNames = (p) =>
  p.evaluate(() =>
    [...document.querySelectorAll('main ul li')].map(
      (li) => li.querySelector('span span')?.textContent ?? '',
    ),
  );
const focusInput = (p, name) =>
  p.evaluate((n) => {
    const li = [...document.querySelectorAll('main ul li')].find(
      (l) => l.querySelector('span span')?.textContent === n,
    );
    const i = li?.querySelector('input');
    i?.focus();
    i?.select();
    return !!i;
  }, name);
const rowText = (p, name) =>
  p.evaluate(
    (n) =>
      [...document.querySelectorAll('main ul li')].find(
        (l) => l.querySelector('span span')?.textContent === n,
      )?.innerText ?? '',
    name,
  );
const rowButton = (p, name, text) =>
  p.evaluate(
    (n, x) => {
      const li = [...document.querySelectorAll('main ul li')].find(
        (l) => l.querySelector('span span')?.textContent === n,
      );
      const b = li && [...li.querySelectorAll('button')].find((e) => e.textContent.includes(x));
      b?.click();
      return !!b;
    },
    name,
    text,
  );
const shot = (p, n) => p.screenshot({ path: join(OUT, `${n}.png`), fullPage: true });
const academy = await db.academy.findUniqueOrThrow({
  where: { id: A },
  select: { timezone: true },
});
const today = new Intl.DateTimeFormat('en-CA', { timeZone: academy.timezone }).format(new Date());
const setFlag = async (on) => {
  await db.academyFeatureFlag.updateMany({
    where: { academyId: A, key: 'paperExams' },
    data: { enabled: on },
  });
  await sleep(31_000); // the API caches a flag for 30 s
};
const resultOf = async (examId, name) => {
  const s = await db.academyStudent.findFirst({ where: { academyId: A, fullName: name } });
  return db.paperExamResult.findUnique({
    where: { examId_academyStudentId: { examId, academyStudentId: s.id } },
  });
};

const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
const before = {
  platform: await hashOf(PLATFORM),
  c4: await hashOf(C4),
  online: await hashOf(ONLINE),
};
try {
  // ── The teacher: their exams, their group only ───────────────────────
  const t = await login(b, 'teacher');
  ok('teacher: Exams & grades in the navigation', (await bodyText(t)).includes(AR.nav.exams));
  await t.goto(`${WEB}/center/exams?academy=${A}`, { waitUntil: 'networkidle2' });
  await waitFor(async () => (await bodyText(t)).includes(AR.exams.list.new));
  ok('teacher: the exams page opens, empty', (await bodyText(t)).includes(AR.exams.list.empty));
  await clickText(t, 'button', AR.exams.list.new);
  await waitFor(async () => (await dialogText(t)).includes(AR.exams.form.newTitle));
  const groupOptions = await t.evaluate(() =>
    [...document.querySelectorAll('[role=dialog] select option')].map((o) => o.textContent),
  );
  ok(
    'teacher: only their assigned group is offered',
    groupOptions.length === 2 && groupOptions[1] === F.groups.A.name,
    groupOptions.join(' | '),
  );
  const fill = async (label, value) => {
    await t.evaluate((l) => {
      const lab = [...document.querySelectorAll('[role=dialog] label')].find((x) =>
        x.textContent.includes(l),
      );
      const i = lab?.querySelector('input,textarea');
      i?.focus();
    }, label);
    await t.keyboard.type(value);
  };
  await fill(AR.exams.form.title, 'فيزياء — الفصل التالت');
  await t.evaluate((d) => {
    const i = document.querySelector('[role=dialog] input[type=date]');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(i, d);
    i.dispatchEvent(new Event('input', { bubbles: true }));
  }, today);
  await fill(AR.exams.form.max, '30');
  await fill(AR.exams.form.pass, '15');
  const create = await t.evaluateHandle(() =>
    document.querySelector('[role=dialog] button[type=submit]'),
  );
  const cb = await create.asElement().boundingBox();
  await t.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2, { clickCount: 2, delay: 30 });
  await waitFor(async () => /\/center\/exams\/[0-9a-f-]{36}/.test(t.url()));
  const exams = await db.paperExam.findMany({ where: { academyId: A } });
  ok(
    'double click: exactly one exam, 30.00 / 15.00, a draft',
    exams.length === 1 &&
      exams[0].maxScore === 3000 &&
      exams[0].passScore === 1500 &&
      exams[0].status === 'DRAFT',
    exams.length,
  );
  const exam = exams[0];

  // ── The sheet: the roster of the exam date, typed fast ───────────────
  await waitFor(async () => (await sheetNames(t)).length > 3);
  const roster = await db.$queryRaw`
    SELECT count(*)::int n FROM "GroupMembership" m JOIN "AcademyStudent" s ON s."studentId" = m."studentId" AND s."academyId" = m."academyId"
    WHERE m."groupId" = ${GA} AND m."deletedAt" IS NULL`;
  const names = await sheetNames(t);
  ok(
    'the sheet lists the group on the exam date',
    names.length === roster[0].n,
    `${names.length} of ${roster[0].n}`,
  );
  ok(
    'progress shows 0 entered',
    (await bodyText(t)).includes(
      AR.exams.sheet.progress.replace('{{graded}}', '0').replace('{{total}}', String(names.length)),
    ),
  );
  await focusInput(t, names[0]);
  await t.keyboard.type('26.5');
  await t.keyboard.press('Enter');
  await t.keyboard.type('٢٨');
  await t.keyboard.press('Enter');
  // Puppeteer types an Arabic letter without a keydown, so the shortcuts are
  // pressed as A (غ) and E (ع) — the same handler.
  await t.keyboard.press('a'); // absent
  await t.keyboard.press('e'); // excused
  await t.keyboard.type('0');
  await t.keyboard.press('Enter');
  await t.keyboard.type('31');
  await sleep(300);
  ok(
    'above the full mark: said on the row, Save disabled',
    (await rowText(t, names[5])).includes('أكبر من الدرجة النهائية') &&
      (await t.evaluate(
        (s) =>
          [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === s)
            ?.disabled,
        AR.exams.sheet.save,
      )),
  );
  await focusInput(t, names[5]);
  await t.keyboard.type('30');
  await shot(t, 'sheet-typing');
  await t.keyboard.down('Control');
  await t.keyboard.press('s');
  await t.keyboard.up('Control');
  await waitFor(async () => (await db.paperExamResult.count({ where: { examId: exam.id } })) === 6);
  const got = await Promise.all(names.slice(0, 6).map((n) => resultOf(exam.id, n)));
  ok(
    'saved exactly: 26.50, 28 (Arabic digits), absent, excused, 0 as a SCORE, 30',
    JSON.stringify(got.map((r) => [r?.status, r?.score])) ===
      JSON.stringify([
        ['SCORED', 2650],
        ['SCORED', 2800],
        ['ABSENT', null],
        ['EXCUSED', null],
        ['SCORED', 0],
        ['SCORED', 3000],
      ]),
    JSON.stringify(got.map((r) => [r?.status, r?.score])),
  );

  // ── Leaving with unsaved marks asks first ────────────────────────────
  await focusInput(t, names[6]);
  await t.keyboard.type('10');
  await clickText(t, 'main a', AR.exams.sheet.back);
  const asked = await waitFor(
    async () => (await dialogText(t)).includes(AR.exams.sheet.unsavedTitle),
    4000,
  );
  ok('unsaved marks: leaving asks first', asked);
  await clickText(t, '[role=dialog] button', AR.common.cancel);
  await sleep(400);
  ok(
    '…and staying keeps the page and the typed mark',
    t.url().includes(exam.id) &&
      (await t.evaluate(
        (n) =>
          [...document.querySelectorAll('main ul li')]
            .find((l) => l.querySelector('span span')?.textContent === n)
            ?.querySelector('input')?.value,
        names[6],
      )) === '10',
  );
  ok(
    'publish is disabled while anything is unsaved',
    await t.evaluate(
      (s) =>
        [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === s)?.disabled,
      AR.exams.publish.do,
    ),
  );
  await clickText(t, 'button', AR.exams.sheet.save);
  await waitFor(async () => (await db.paperExamResult.count({ where: { examId: exam.id } })) === 7);

  // ── Publishing with learners missing is refused, and says who ────────
  await clickText(t, 'button', AR.exams.publish.do);
  await waitFor(async () => (await dialogText(t)).includes(AR.exams.publish.title));
  await clickText(t, '[role=dialog] button', AR.exams.publish.do);
  await waitFor(async () => (await bodyText(t)).includes(AR.err.eRosterIncomplete));
  ok(
    'publish refused: learners without a result are named',
    (await bodyText(t)).includes(AR.err.eRosterIncomplete) &&
      (await db.paperExam.findUnique({ where: { id: exam.id } })).status === 'DRAFT',
  );
  await shot(t, 'publish-refused');

  // ── Two graders, one learner: no silent last write ───────────────────
  const o = await login(b, 'owner');
  await o.goto(`${WEB}/center/exams/${exam.id}?academy=${A}`, { waitUntil: 'networkidle2' });
  await waitFor(async () => (await sheetNames(o)).length > 3);
  const contested = names[7];
  await focusInput(o, contested);
  await o.keyboard.type('12');
  await clickText(o, 'button', AR.exams.sheet.save);
  await waitFor(async () => !!(await resultOf(exam.id, contested)));
  await focusInput(t, contested);
  await t.keyboard.type('14');
  await clickText(t, 'button', AR.exams.sheet.save);
  const conflictShown = await waitFor(async () =>
    (await rowText(t, contested)).includes('حد تاني حفظ 12'),
  );
  ok(
    'the second grader is told: someone else saved 12',
    conflictShown,
    await rowText(t, contested),
  );
  ok('…and nothing was overwritten', (await resultOf(exam.id, contested))?.score === 1200);
  ok(
    'save is held until the grader chooses',
    await t.evaluate(
      (s) =>
        [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === s)?.disabled,
      AR.exams.sheet.save,
    ),
  );
  await rowButton(t, contested, AR.exams.sheet.useTheirs);
  await sleep(300);

  // ── Everyone else absent, with the keyboard; then publish ────────────
  const missing = [];
  for (const n of await sheetNames(t)) if (!(await resultOf(exam.id, n))) missing.push(n);
  await focusInput(t, missing[0]);
  for (let i = 0; i < missing.length; i++) {
    await t.keyboard.press('a');
    await sleep(40);
  }
  await clickText(t, 'button', AR.exams.sheet.save);
  await waitFor(
    async () => (await db.paperExamResult.count({ where: { examId: exam.id } })) === names.length,
  );
  ok(
    'every learner now has a result',
    (await db.paperExamResult.count({ where: { examId: exam.id } })) === names.length,
  );
  await sleep(500);
  await clickText(t, 'button', AR.exams.publish.do);
  await waitFor(async () => (await dialogText(t)).includes(AR.exams.publish.title));
  await clickText(t, '[role=dialog] button', AR.exams.publish.do);
  await waitFor(
    async () => (await db.paperExam.findUnique({ where: { id: exam.id } })).status === 'PUBLISHED',
  );
  ok(
    'published',
    (await db.paperExam.findUnique({ where: { id: exam.id } })).status === 'PUBLISHED',
  );
  await waitFor(async () => (await bodyText(t)).includes(AR.exams.examStatus.PUBLISHED));
  const tb = await bodyText(t);
  const mainButtons = await t.evaluate(() =>
    [...document.querySelectorAll('main button')].map((x) => x.textContent.trim()),
  );
  const listed = (await sheetNames(t)).length;
  ok(
    'the published sheet lists everyone, read-only for the teacher; no Correct, no Void (grades.correct is not a teacher default)',
    listed === names.length &&
      !(await t.$('main ul li input')) &&
      !mainButtons.includes(AR.exams.correct.open) &&
      !mainButtons.includes(AR.exams.void.open),
    `${listed} rows; ${mainButtons.join(' | ')}`,
  );
  ok(
    'statistics are shown (server-side, scored only)',
    tb.includes(AR.exams.stats.average) && tb.includes(AR.exams.stats.scoredOnly),
  );
  await shot(t, 'published');

  // ── A makeup for several learners; the original absence stays ────────
  await clickText(t, 'button', AR.exams.makeup.open);
  await waitFor(async () => (await dialogText(t)).includes(AR.exams.makeup.create));
  await t.evaluate((d) => {
    const i = document.querySelector('[role=dialog] input[type=date]');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(i, d);
    i.dispatchEvent(new Event('input', { bubbles: true }));
  }, today);
  await clickText(t, '[role=dialog] button[type=submit]', AR.exams.makeup.create);
  await waitFor(
    async () => (await db.paperExam.count({ where: { academyId: A, kind: 'MAKEUP' } })) === 1,
  );
  const makeup = await db.paperExam.findFirst({ where: { academyId: A, kind: 'MAKEUP' } });
  await waitFor(async () => t.url().includes(makeup.id) && (await sheetNames(t)).length > 0);
  const candidates = await db.paperExamResult.count({
    where: { examId: exam.id, status: { in: ['ABSENT', 'EXCUSED'] } },
  });
  const mk = await sheetNames(t);
  ok(
    'the makeup lists exactly the absent and excused',
    mk.length === candidates && mk.includes(names[2]) && mk.includes(names[3]),
    `${mk.length} of ${candidates}`,
  );
  await focusInput(t, names[2]);
  await t.keyboard.type('8');
  await focusInput(t, names[3]);
  await t.keyboard.type('25');
  await clickText(t, 'button', AR.exams.sheet.save);
  await waitFor(
    async () => (await db.paperExamResult.count({ where: { examId: makeup.id } })) === 2,
  );
  await sleep(400);
  await clickText(t, 'button', AR.exams.publish.do);
  await waitFor(async () => (await dialogText(t)).includes(AR.exams.publish.title));
  await clickText(t, '[role=dialog] button', AR.exams.publish.do);
  await waitFor(
    async () =>
      (await db.paperExam.findUnique({ where: { id: makeup.id } })).status === 'PUBLISHED',
  );
  ok(
    'makeup published with two results (not every candidate needs one)',
    (await db.paperExam.findUnique({ where: { id: makeup.id } })).status === 'PUBLISHED',
  );
  ok('the original absence is kept', (await resultOf(exam.id, names[2]))?.status === 'ABSENT');

  // ── The owner corrects a published grade, with a reason ──────────────
  await o.goto(`${WEB}/center/exams/${exam.id}?academy=${A}`, { waitUntil: 'networkidle2' });
  await waitFor(async () => (await bodyText(o)).includes(AR.exams.correct.open));
  await rowButton(o, names[0], AR.exams.correct.open);
  await waitFor(async () => (await dialogText(o)).includes(AR.exams.correct.reason));
  await o.evaluate(() => {
    const i = document.querySelector('[role=dialog] input');
    i.focus();
    i.select();
  });
  await o.keyboard.type('9');
  await o.evaluate(() => document.querySelector('[role=dialog] textarea').focus());
  await o.keyboard.type('اتجمعت غلط');
  await clickText(o, '[role=dialog] button[type=submit]', AR.exams.correct.save);
  await waitFor(async () => (await resultOf(exam.id, names[0]))?.score === 900);
  const rev = await db.paperExamRevision.findFirst({
    where: { examId: exam.id, kind: 'CORRECTION' },
  });
  ok(
    'corrected 26.50 → 9.00 with the reason and the old value kept',
    (await resultOf(exam.id, names[0]))?.score === 900 &&
      rev?.fromScore === 2650 &&
      rev?.reason === 'اتجمعت غلط',
  );
  await waitFor(async () => (await rowText(o, names[0])).includes(AR.exams.sheet.corrected));
  ok('the row says "corrected"', (await rowText(o, names[0])).includes(AR.exams.sheet.corrected));

  // ── C5: the low grade, only for those who may see grades ─────────────
  await o.goto(`${WEB}/center/follow-up?academy=${A}`, { waitUntil: 'networkidle2' });
  await waitFor(async () => (await bodyText(o)).includes(names[0]));
  const ob = await bodyText(o);
  ok(
    'owner: the LOW_GRADE card and the learner (9 of 30 = 30%)',
    ob.includes(AR.followUp.reason.LOW_GRADE) && ob.includes(names[0]) && ob.includes('30%'),
  );
  ok(
    'the makeup result is the effective one: 8 of 30 is low, 25 of 30 is not',
    ob.includes(names[2]) && !ob.includes(names[3]),
  );
  const r = await login(b, 'reception');
  await r.goto(`${WEB}/center/follow-up?academy=${A}`, { waitUntil: 'networkidle2' });
  await sleep(2000);
  const rb = await bodyText(r);
  ok(
    'Reception: no low-grade card, no grade in follow-up',
    !rb.includes(AR.followUp.reason.LOW_GRADE) && !rb.includes('30%'),
  );
  ok('Reception: no Exams & grades in the navigation', !rb.includes(AR.nav.exams));
  await r.goto(`${WEB}/center/exams?academy=${A}`, { waitUntil: 'networkidle2' });
  await sleep(1500);
  const rx = await bodyText(r);
  ok(
    'Reception opening /center/exams: told they have no access; no learner, no mark',
    rx.includes(AR.exams.noAccess) && !rx.includes(names[0]),
  );

  // ── CRITICAL: a low grade is never an attendance gate ────────────────
  const low = await db.academyStudent.findFirst({ where: { academyId: A, fullName: names[0] } });
  await r.goto(`${WEB}/desk?academy=${A}`, { waitUntil: 'networkidle2' });
  await sleep(700);
  await r.click('[data-desk-input]');
  await r.keyboard.type(low.code, { delay: 2 });
  await r.keyboard.press('Enter');
  await sleep(1500);
  await r.click('[data-desk-input]');
  await r.keyboard.press('Enter');
  await waitFor(
    async () =>
      !!(await db.attendanceRecord.findFirst({
        where: { studentId: low.studentId, session: { groupSessionId: F.classes.A } },
      })),
  );
  const rec = await db.attendanceRecord.findFirst({
    where: { studentId: low.studentId, session: { groupSessionId: F.classes.A } },
  });
  ok(
    'CRITICAL: the low-graded learner checks in at the desk',
    !!rec && ['PRESENT', 'LATE'].includes(rec.status),
    rec?.status,
  );
  const deskText = await bodyText(r);
  ok(
    'the desk shows no grade',
    !deskText.includes('9 / 30') && !deskText.includes(AR.followUp.reason.LOW_GRADE),
  );
  await r.close();

  // ── Student 360 (owner — a teacher's 360 stays course-scoped, as before C6) ──
  await o.goto(`${WEB}/staff/students/${low.studentId}?academy=${A}`, {
    waitUntil: 'networkidle2',
  });
  await waitFor(async () => (await bodyText(o)).includes(AR.care.tab.grades));
  await o.evaluate(
    (x) =>
      [...document.querySelectorAll('main [role=tab]')]
        .find((e) => e.textContent.trim() === x)
        ?.click(),
    AR.care.tab.grades,
  );
  await waitFor(async () => (await bodyText(o)).includes('فيزياء — الفصل التالت'));
  const s360 = await o.evaluate(() => document.querySelector('main')?.innerText ?? '');
  await shot(o, 'student-360');
  ok(
    'Student 360: the grades tab shows 9 / 30, corrected, no chart',
    /9\s*\/\s*30/.test(s360) &&
      s360.includes(AR.exams.sheet.corrected) &&
      !(await o.$('main canvas')),
    s360.slice(0, 300).replace(/\n/g, ' ¦ '),
  );

  // ── A teacher whose assignment ended loses the group's exams ─────────
  const teacherUser = await db.user.findFirstOrThrow({ where: { email: F.emails.teacher } });
  const asg = await db.groupAssignment.findFirstOrThrow({
    where: { groupId: GA, userId: teacherUser.id },
  });
  await db.groupAssignment.update({ where: { id: asg.id }, data: { deletedAt: new Date() } });
  await t.goto(`${WEB}/center/exams/${exam.id}?academy=${A}`, { waitUntil: 'networkidle2' });
  await sleep(1500);
  const ended = await bodyText(t);
  ok(
    'assignment ended: the sheet is refused, no mark shown',
    !ended.includes(names[1]) &&
      (ended.includes(AR.err.eGroupNotAssigned) || ended.includes(AR.exams.noAccess)),
  );
  await db.groupAssignment.update({ where: { id: asg.id }, data: { deletedAt: null } });

  // ── Mobile: the sheet fits a phone ───────────────────────────────────
  await t.setViewport({ width: 390, height: 844 });
  await t.goto(`${WEB}/center/exams/${makeup.id}?academy=${A}`, { waitUntil: 'networkidle2' });
  await sleep(1200);
  const overflow = await t.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok('phone (390 px): no sideways scroll on the sheet', overflow <= 1, overflow);
  await shot(t, 'mobile-sheet');
  await t.close();

  // ── Flag off: nothing of C6 anywhere ─────────────────────────────────
  await setFlag(false);
  await o.goto(`${WEB}/center/exams?academy=${A}`, { waitUntil: 'networkidle2' });
  await sleep(1500);
  const off = await bodyText(o);
  ok(
    'flag off: the page says it is off; no menu entry; no exam listed',
    off.includes(AR.exams.off) &&
      !(await o.$('a[href="/center/exams"]')) &&
      !off.includes('فيزياء — الفصل التالت'),
    off.slice(0, 400).replace(/\n/g, ' ¦ '),
  );
  await shot(o, 'flag-off');
  await o.goto(`${WEB}/center/follow-up?academy=${A}`, { waitUntil: 'networkidle2' });
  await sleep(1500);
  ok(
    'flag off: follow-up shows no low grade',
    !(await bodyText(o)).includes(AR.followUp.reason.LOW_GRADE),
  );
  await setFlag(true);
  await o.close();

  ok(
    'platform money untouched by every C6 flow',
    JSON.stringify(await hashOf(PLATFORM)) === JSON.stringify(before.platform),
  );
  ok(
    'the C4 books untouched by every C6 flow',
    JSON.stringify(await hashOf(C4)) === JSON.stringify(before.c4),
  );
  ok(
    'online quizzes, assignments, challenges and OCR imports untouched',
    JSON.stringify(await hashOf(ONLINE)) === JSON.stringify(before.online),
  );
} catch (e) {
  ok('E2E ran to the end', false, String(e?.stack ?? e).slice(0, 500));
} finally {
  await db.academyFeatureFlag
    .updateMany({ where: { academyId: A, key: 'paperExams' }, data: { enabled: true } })
    .catch(() => null);
  writeFileSync(
    join(OUT, 'results.txt'),
    results.join('\n') + `\n${results.length - failed}/${results.length}\n`,
  );
  console.log(`\n${results.length - failed}/${results.length} — screenshots in ${OUT}`);
  await b.close();
  await db.$disconnect();
  process.exitCode = failed ? 1 : 0;
}
