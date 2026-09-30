#!/usr/bin/env node
/**
 * C3 reception desk — real browser E2E: real Chrome, the real API, real
 * PostgreSQL. Reads the fixture written by desk-seed.cjs (OS temp dir) and
 * checks every outcome in the database, not only on screen.
 *
 * Needs: the API on :4000 against darsly_c3e2e (seeded just before), the web
 * dev server on :5173, and Chrome.
 *
 * Usage:
 *   DATABASE_URL=…/darsly_c3e2e node scripts/e2e/desk-e2e.mjs
 * Screenshots and results go to $E2E_OUT (default: <tmp>/darsly-desk-e2e).
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const qrcode = require('qrcode-generator');
const { PrismaClient } = require('@prisma/client');

const url = new URL(process.env.DATABASE_URL ?? 'postgresql://x/none');
if (url.pathname !== '/darsly_c3e2e') throw new Error('refusing: not the desk e2e database');
const F = JSON.parse(readFileSync(join(tmpdir(), 'darsly-desk-e2e.json'), 'utf8'));
const OUT = process.env.E2E_OUT ?? join(tmpdir(), 'darsly-desk-e2e');
mkdirSync(OUT, { recursive: true });
const WEB = process.env.WEB ?? 'http://localhost:5173';
const API = process.env.API ?? 'http://localhost:4000/api/v1';
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const db = new PrismaClient();
const S = F.students;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
let failed = 0;
const ok = (name, cond, detail = '') => {
  const line = `${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? ` — ${detail}` : ''}`;
  results.push(line);
  if (!cond) failed++;
  console.log(line);
};
const seenTokens = new Set(); // every raw token this run touched, for the leak check
for (const s of Object.values(S).flat()) {
  if (s?.token) seenTokens.add(s.token);
  if (s?.oldToken) seenTokens.add(s.oldToken);
}

/** A 640×480 Y4M "camera" showing one QR, for Chrome's fake capture device. */
function qrVideo(text, file) {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Numeric');
  qr.make();
  const n = qr.getModuleCount();
  const W = 640;
  const H = 480;
  const cell = Math.floor(380 / (n + 8));
  const size = cell * (n + 8);
  const ox = Math.floor((W - size) / 2);
  const oy = Math.floor((H - size) / 2);
  const Y = Buffer.alloc(W * H, 60);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const r = Math.floor(y / cell) - 4;
      const c = Math.floor(x / cell) - 4;
      const dark = r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c);
      Y[(oy + y) * W + ox + x] = dark ? 16 : 235;
    }
  const UV = Buffer.alloc((W / 2) * (H / 2), 128);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), Y, UV, UV]);
  const frames = Array.from({ length: 20 }, () => frame);
  writeFileSync(
    file,
    Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), ...frames]),
  );
}

async function launch(extraArgs = []) {
  return puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--lang=ar', ...extraArgs],
  });
}

async function login(
  browser,
  who,
  { width = 1280, height = 900, mobile = false, lang = 'ar' } = {},
) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width, height, isMobile: mobile, hasTouch: mobile });
  await p.evaluateOnNewDocument((l) => {
    try {
      localStorage.setItem('darsly_lang', l);
      localStorage.setItem('darsly-lang', l);
    } catch {
      /* first paint */
    }
    // Count prints from any frame instead of opening the dialog.
    window.print = () => {
      try {
        window.top.__printed = (window.top.__printed ?? 0) + 1;
      } catch {
        /* cross-origin never happens here */
      }
    };
  }, lang);
  p.consoleLines = [];
  p.on('console', (m) => p.consoleLines.push(m.text()));
  p.visited = [];
  p.on('framenavigated', (f) => p.visited.push(f.url()));
  await p.goto(`${WEB}/login`, { waitUntil: 'networkidle2' });
  await p.type('input[autocomplete=username]', F.emails[who]);
  await p.type('input[autocomplete=current-password]', F.password);
  await Promise.all([
    p.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => null),
    p.keyboard.press('Enter'),
  ]);
  await sleep(800);
  return p;
}

const panelText = (p) =>
  p.evaluate(() => document.querySelector('section[aria-live]')?.innerText ?? '');
async function waitPanel(p, re, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const txt = await panelText(p);
    if (re.test(txt)) return txt;
    await sleep(80);
  }
  return panelText(p);
}
/** Type into the page the way a USB scanner does: fast keys, then Enter — focus not assumed. */
async function wedge(p, text) {
  await p.keyboard.type(text, { delay: 2 });
  await p.keyboard.press('Enter');
}
async function blurBox(p) {
  await p.evaluate(() => document.activeElement?.blur?.());
}
async function clickText(p, selector, text) {
  return p.evaluate(
    (sel, t) => {
      const el = [...document.querySelectorAll(sel)].find(
        (x) => x.textContent.includes(t) && !x.disabled,
      );
      el?.click();
      return !!el;
    },
    selector,
    text,
  );
}
const recordsOf = (studentId, sessionId) =>
  db.attendanceRecord.findMany({
    where: { studentId, ...(sessionId ? { session: { groupSessionId: sessionId } } : {}) },
  });
const shot = (p, name) => p.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });

try {
  const b = await launch();
  const r = await login(b, 'reception');
  const tokensInResponses = [];
  /** Keep the token an issue/reissue returned (the POST, not its CORS preflight). */
  const catchTokens = (page) =>
    page.on('response', async (res) => {
      if (
        res.request().method() === 'POST' &&
        /\/desk\/cards\/.+\/(issue|reissue)$/.test(res.url()) &&
        res.status() < 300
      )
        tokensInResponses.push(
          await res.json().then(
            (j) => j.token,
            () => undefined,
          ),
        );
    });
  catchTokens(r);

  // ── Nav and the idle desk.
  const navHasDesk = await r.evaluate(() => !!document.querySelector('a[href="/desk"]'));
  ok('reception: the Desk is in the menu', navHasDesk);
  await r.goto(`${WEB}/desk?academy=${F.academyId}`, { waitUntil: 'networkidle2' });
  ok('desk idle: ready for the next student', /جاهز/.test(await waitPanel(r, /جاهز/)));
  ok(
    'desk box has focus on a desk computer',
    await r.evaluate(() => document.activeElement?.hasAttribute?.('data-desk-input')),
  );
  await shot(r, 'desk-idle-1280');

  // ── USB scanner (keyboard wedge), focus wandered off: token → student → Enter checks in.
  await blurBox(r);
  const s0 = S.a[0];
  await wedge(r, s0.token);
  let txt = await waitPanel(r, new RegExp(s0.name.split(' ')[0]));
  ok(
    'USB scan with focus elsewhere: the card resolves to the student',
    txt.includes(s0.name),
    txt.slice(0, 80),
  );
  ok('one open class → the check-in button is ready', /سجّل حضور/.test(txt));
  await shot(r, 'desk-student-one-class');
  await r.keyboard.press('Enter'); // empty box + Enter = check in the class on screen
  txt = await waitPanel(r, /حاضر ✓/);
  ok('Enter on the empty box checks in: PRESENT', /حاضر ✓/.test(txt));
  let recs = await recordsOf(s0.studentId, F.classes.A);
  ok(
    'DB: one record, PRESENT, method QR, server time',
    recs.length === 1 &&
      recs[0].status === 'PRESENT' &&
      recs[0].method === 'QR' &&
      !!recs[0].checkedInAt,
    JSON.stringify(recs.map((x) => [x.status, x.method])),
  );
  await shot(r, 'desk-present');

  // Same card again.
  await wedge(r, s0.token);
  txt = await waitPanel(r, new RegExp(s0.name.split(' ')[0]));
  ok(
    'same card again: shown as already present, no button',
    /حاضر/.test(txt) && !/سجّل حضور/.test(txt),
  );
  ok('DB: still one record', (await recordsOf(s0.studentId, F.classes.A)).length === 1);

  // ── Code (Arabic digits typed), past the grace → LATE.
  const arabic = [...S.late.code].map((d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]).join('');
  await wedge(r, arabic);
  txt = await waitPanel(r, /بسمة/);
  ok('code in Arabic digits resolves', txt.includes('بسمة'));
  ok('past the grace the button says late (server clock)', /سجّل \(متأخر\)/.test(txt));
  await clickText(r, 'section[aria-live] button', 'سجّل');
  txt = await waitPanel(r, /متأخر/);
  recs = await recordsOf(S.late.studentId, F.classes.C);
  ok(
    'checked in LATE, method CODE',
    recs.length === 1 && recs[0].status === 'LATE' && recs[0].method === 'CODE',
    JSON.stringify(recs.map((x) => [x.status, x.method])),
  );
  await shot(r, 'desk-late');

  // ── Register search by name → pick → two classes open → choose.
  await r.type('[data-desk-input]', 'مريم حصتين');
  await r.keyboard.press('Enter');
  await waitPanel(r, /مريم حصتين/);
  await clickText(r, 'section[aria-live] button', 'مريم حصتين');
  txt = await waitPanel(r, /أكتر من حصة/);
  ok('two classes open now: the desk asks which (never guesses)', /أكتر من حصة/.test(txt));
  const buttons = await r.evaluate(
    () =>
      [...document.querySelectorAll('section[aria-live] li button')].filter(
        (x) => !x.closest('details'),
      ).length,
  );
  ok('both classes offer a check-in', buttons === 2, buttons);
  await shot(r, 'desk-choose');
  await r.evaluate(() =>
    [...document.querySelectorAll('section[aria-live] li')]
      .find((li) => li.textContent.includes('كيمياء'))
      ?.querySelector('button')
      ?.click(),
  );
  await waitPanel(r, /متأخر|حاضر ✓/);
  recs = await recordsOf(S.multi.studentId);
  ok(
    'picked from search → method MANUAL, into the chosen class only',
    recs.length === 1 && recs[0].method === 'MANUAL',
    JSON.stringify(recs.map((x) => x.method)),
  );

  // ── No class now, withdrawn, closed.
  await wedge(r, S.noClass.code);
  txt = await waitPanel(r, /حصته الجاية/);
  ok('no class now: says when the next one is', /حصته الجاية/.test(txt));
  await shot(r, 'desk-no-class');
  await wedge(r, S.withdrawn.token);
  txt = await waitPanel(r, /منسحب/);
  ok(
    'withdrawn: identified, marked withdrawn, no check-in button',
    /منسحب/.test(txt) && !/سجّل حضور/.test(txt),
  );
  await shot(r, 'desk-withdrawn');
  await wedge(r, S.closed.code);
  txt = await waitPanel(r, /الغياب اتقفل/);
  ok(
    'closed attendance: shown closed, no button',
    /الغياب اتقفل/.test(txt) && !/سجّل حضور/.test(txt),
  );
  ok(
    'DB: closed sheet untouched for that student',
    (await recordsOf(S.closed.studentId, F.classes.E)).length === 0,
  );

  // ── Cards that must not work.
  await wedge(r, S.revoked.oldToken);
  txt = await waitPanel(r, /اتلغى/);
  ok('old card after a reissue: cancelled', /اتلغى/.test(txt));
  await shot(r, 'desk-revoked');
  await wedge(r, S.revoked.token);
  txt = await waitPanel(r, /هدى/);
  ok('the new card of the same student works', txt.includes('هدى'));
  await wedge(r, S.foreign.token);
  txt = await waitPanel(r, /مش معروف/);
  ok(
    "another center's card: just 'not recognised' — no hint of where it is from",
    /مش معروف/.test(txt) && !/سنتر آخر/.test(txt),
  );
  await wedge(r, Array.from({ length: 48 }, () => Math.floor(Math.random() * 10)).join(''));
  ok('a made-up card: not recognised', /مش معروف/.test(await waitPanel(r, /مش معروف/)));
  await wedge(r, S.a[2].token.slice(0, 40));
  ok(
    'a damaged (short) scan: not recognised, never searched',
    /مش معروف/.test(await waitPanel(r, /مش معروف/)),
  );
  await shot(r, 'desk-invalid');

  // ── Makeup: the full class is refused, an open one needs confirming.
  await wedge(r, S.guest.code);
  await waitPanel(r, /نور تعويض/);
  await r.evaluate(() => {
    const d = document.querySelector('section[aria-live] details');
    if (d) d.open = true;
  });
  await sleep(200);
  txt = await panelText(r);
  ok(
    'makeup options list open classes with seats; the full one says so',
    /كاملة/.test(txt) && /مقعد/.test(txt),
  );
  const fullHasButton = await r.evaluate(
    () =>
      [...document.querySelectorAll('section[aria-live] details li')]
        .find((li) => li.textContent.includes('Physics B'))
        ?.querySelector('button') != null,
  );
  ok('the full class offers no makeup button', !fullHasButton);
  await shot(r, 'desk-makeup-options');
  await r.evaluate(() =>
    [...document.querySelectorAll('section[aria-live] details li')]
      .find((li) => li.textContent.includes('أحياء'))
      ?.querySelector('button')
      ?.click(),
  );
  await sleep(300);
  ok(
    'makeup asks for confirmation first',
    await r.evaluate(() => !!document.querySelector('[role="dialog"], [role="alertdialog"]')),
  );
  await shot(r, 'desk-makeup-confirm');
  await clickText(r, '[role="dialog"] button, [role="alertdialog"] button', 'تعويض');
  txt = await waitPanel(r, /تعويض/);
  recs = await recordsOf(S.guest.studentId, F.classes.D);
  ok(
    'makeup recorded with its home group, method CODE',
    recs.length === 1 && recs[0].homeGroupId === F.groups.F.id && recs[0].method === 'CODE',
  );
  ok(
    'no membership created in the makeup group',
    (await db.groupMembership.count({
      where: { studentId: S.guest.studentId, groupId: F.groups.D.id },
    })) === 0,
  );

  // ── A student without a card: issue one at the desk, print it, use it.
  await wedge(r, S.noCard.code);
  await waitPanel(r, /من غير كارت/);
  await clickText(r, 'section[aria-live] button', 'اصدر كارت');
  await sleep(300);
  await clickText(r, '[role="dialog"] button', 'اصدر كارت');
  await sleep(1200);
  const preview = await r.evaluate(() => !!document.querySelector('[role="dialog"] .qr-card svg'));
  ok('issue → the print preview shows the card with its QR', preview);
  await shot(r, 'card-print-preview');
  await clickText(r, '[role="dialog"] button', 'اطبع');
  await sleep(600);
  ok(
    'Print sends the card to the printer (one print)',
    (await r.evaluate(() => window.__printed ?? 0)) === 1,
  );
  const issued = tokensInResponses.at(-1);
  if (issued) seenTokens.add(issued);
  ok('the new card is 48 digits', /^\d{48}$/.test(issued ?? ''));
  await r.keyboard.press('Escape');
  await sleep(200);
  await r.keyboard.press('Escape');
  await sleep(200);
  await r.goto(`${WEB}/desk?academy=${F.academyId}`, { waitUntil: 'networkidle2' });
  await wedge(r, issued);
  txt = await waitPanel(r, /كريم/);
  ok('the card just printed works at the desk', txt.includes('كريم') && /معاه كارت/.test(txt));

  // ── Rush mode: a queue of 12 cards, no clicks.
  await clickText(r, 'button[role="switch"]', 'الزحمة');
  await sleep(200);
  const queue = S.a.slice(1, 13);
  const t0 = Date.now();
  let stale = 0;
  let focusLost = 0;
  for (const s of queue) {
    await wedge(r, s.token);
    const got = await waitPanel(r, new RegExp(`حاضر ✓[\\s\\S]*${s.name.split(' ')[0]}`));
    if (!got.includes(s.name)) stale++;
    if (!(await r.evaluate(() => document.activeElement?.hasAttribute?.('data-desk-input'))))
      focusLost++;
  }
  const secs = (Date.now() - t0) / 1000;
  ok(
    `Rush: ${queue.length} students in ${secs.toFixed(1)} s (${((queue.length / secs) * 60).toFixed(0)}/min), each shown by name`,
    stale === 0,
    `stale=${stale}`,
  );
  ok('Rush: the box keeps focus after every student', focusLost === 0, focusLost);
  let rushRecs = 0;
  for (const s of queue)
    rushRecs += (await recordsOf(s.studentId, F.classes.A)).filter((x) => x.method === 'QR').length;
  ok('Rush: DB has exactly one QR record per student', rushRecs === queue.length, rushRecs);
  const recent = await r.evaluate(() => document.querySelectorAll('aside li').length);
  ok('Rush: recent check-ins listed', recent >= 10, recent);
  await shot(r, 'desk-rush');
  // A scanner that double-fires.
  await wedge(r, queue[0].token);
  await wedge(r, queue[0].token);
  await sleep(1500);
  ok(
    'double scan in Rush: still one record',
    (await recordsOf(queue[0].studentId, F.classes.A)).length === 1,
  );
  // Rush never guesses.
  await wedge(r, S.multi.token);
  txt = await waitPanel(r, /أكتر من حصة|مريم/);
  ok('Rush with two classes open: stops and asks', /أكتر من حصة/.test(txt));
  await clickText(r, 'button[role="switch"]', 'الزحمة');

  // ── Offline, then retry: one record.
  await r.setOfflineMode(true);
  await wedge(r, S.a[13].code);
  txt = await waitPanel(r, /مفيش اتصال/);
  ok('offline: says so, nothing claimed', /مفيش اتصال/.test(txt));
  await shot(r, 'desk-offline');
  await r.setOfflineMode(false);
  await clickText(r, 'section[aria-live] button', 'حاول تاني');
  txt = await waitPanel(
    r,
    /أحمد|محمد|مريم|سارة|يوسف|نور|عمر|ليلى|كريم|هدى|علي|فاطمة|حسن|منى|خالد|رنا|زياد|ندى|طارق|سلمى/,
  );
  await clickText(r, 'section[aria-live] button', 'سجّل حضور');
  await waitPanel(r, /حاضر ✓/);
  await clickText(r, 'section[aria-live] button', 'اللي بعده');
  ok(
    'retry after reconnecting: one record',
    (await recordsOf(S.a[13].studentId, F.classes.A)).length === 1,
  );

  // ── A browser whose clock is hours off: the server decides PRESENT.
  const skew = await login(b, 'reception');
  await skew.evaluateOnNewDocument(() => {
    const shift = 5 * 3600_000;
    const RealDate = Date;
    // eslint-disable-next-line no-global-assign
    Date = class extends RealDate {
      constructor(...a) {
        super(...(a.length ? a : [RealDate.now() + shift]));
      }
      static now() {
        return RealDate.now() + shift;
      }
    };
  });
  await skew.goto(`${WEB}/desk?academy=${F.academyId}`, { waitUntil: 'networkidle2' });
  await wedge(skew, S.longName.token);
  await waitPanel(skew, /سجّل حضور/);
  await skew.keyboard.press('Enter');
  txt = await waitPanel(skew, /حاضر ✓|متأخر/);
  recs = await recordsOf(S.longName.studentId, F.classes.A);
  ok(
    'browser clock 5 h ahead: still PRESENT (server time)',
    recs[0]?.status === 'PRESENT' && /حاضر ✓/.test(txt),
    recs[0]?.status,
  );
  // Same page, narrower (switching mobile emulation would reload it).
  await skew.setViewport({ width: 360, height: 800 });
  await sleep(300);
  const clipped = await skew.evaluate(() => {
    const el = [...document.querySelectorAll('section[aria-live] bdi')].find(
      (x) => x.textContent.length > 40,
    );
    return el ? el.getBoundingClientRect().right > innerWidth + 1 : 'none';
  });
  ok('a very long name wraps on a 360px phone (not clipped)', clipped === false, clipped);
  await shot(skew, 'desk-long-name-360');
  await skew.close();

  // ── Owner: Student 360 card — reissue makes the old card fail at once.
  const o = await login(b, 'owner');
  catchTokens(o);
  await o.goto(`${WEB}/staff/students/${S.a[5].studentId}?academy=${F.academyId}`, {
    waitUntil: 'networkidle2',
  });
  await sleep(800);
  ok(
    'Student 360: card state shown',
    /كارت QR/.test(await o.evaluate(() => document.body.innerText)) &&
      /شغال/.test(await o.evaluate(() => document.body.innerText)),
  );
  await shot(o, 'student360-card');
  await clickText(o, 'button', 'كارت جديد بدله');
  await sleep(300);
  await shot(o, 'card-reissue-dialog');
  await clickText(o, '[role="dialog"] button', 'اعمل كارت جديد');
  await sleep(1500);
  const reissued = tokensInResponses.at(-1);
  if (reissued) seenTokens.add(reissued);
  ok(
    'reissue opens the print preview',
    await o.evaluate(() => !!document.querySelector('[role="dialog"] .qr-card svg')),
  );
  await o.keyboard.press('Escape');
  await wedge(r, S.a[5].token);
  ok('old card fails right after the reissue', /اتلغى/.test(await waitPanel(r, /اتلغى/)));
  await wedge(r, reissued);
  ok(
    'new card works',
    (await waitPanel(r, new RegExp(S.a[5].name.split(' ')[0]))).includes(S.a[5].name),
  );
  await o.reload({ waitUntil: 'networkidle2' });
  await sleep(600);
  await clickText(o, 'button', 'إلغاء الكارت');
  await sleep(300);
  await clickText(o, '[role="dialog"] button', 'ألغي الكارت');
  await sleep(1000);
  await wedge(r, reissued);
  ok('after revoking, the card fails', /اتلغى/.test(await waitPanel(r, /اتلغى/)));
  ok(
    'DB: no active card left for that student',
    (await db.academyStudentCard.count({
      where: { academyStudentId: S.a[5].id, revokedAt: null },
    })) === 0,
  );

  // ── Who may not.
  for (const who of ['teacher', 'c1only']) {
    const x = await login(b, who);
    const nav = await x.evaluate(() => !!document.querySelector('a[href="/desk"]'));
    await x.goto(`${WEB}/desk?academy=${F.academyId}`, { waitUntil: 'networkidle2' });
    await sleep(600);
    const body = await x.evaluate(() => document.body.innerText);
    ok(`${who}: no Desk in the menu, the page refuses`, !nav && /مش مسموحلك/.test(body));
    await x.close();
  }
  const st = await login(b, 'student');
  await st.goto(`${WEB}/desk?academy=${F.academyId}`, { waitUntil: 'networkidle2' });
  await sleep(500);
  ok(
    'student: the desk page is not theirs',
    !/الاستقبال/.test(await st.evaluate(() => document.querySelector('main')?.innerText ?? '')) ||
      !st.url().includes('/desk'),
  );
  const stToken = await st.evaluate(
    () => localStorage.getItem('accessToken') ?? sessionStorage.getItem('accessToken'),
  );
  await st.close();
  const fo = await login(b, 'foreignOwner');
  await fo.goto(`${WEB}/desk?academy=${F.academyId}`, { waitUntil: 'networkidle2' });
  await sleep(600);
  ok(
    'another center’s owner: nothing of this center shows',
    !/منى|طالب/.test(await fo.evaluate(() => document.querySelector('main')?.innerText ?? '')),
  );
  await fo.close();
  // Raw API: no token, a student's token.
  const noAuth = await fetch(`${API}/desk/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-academy-id': F.academyId },
    body: JSON.stringify({ token: S.a[6].token }),
  });
  ok('API without a session: 401', noAuth.status === 401, noAuth.status);
  if (stToken) {
    const asStudent = await fetch(`${API}/desk/resolve`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${stToken}`,
        'content-type': 'application/json',
        'x-academy-id': F.academyId,
      },
      body: JSON.stringify({ token: S.a[6].token }),
    });
    ok(
      'API as a student: refused',
      asStudent.status === 403 || asStudent.status === 404,
      asStudent.status,
    );
  }

  // ── Phone: the camera button leads, nothing spills sideways.
  const ph = await login(b, 'reception', { width: 390, height: 844, mobile: true });
  await ph.goto(`${WEB}/desk?academy=${F.academyId}`, { waitUntil: 'networkidle2' });
  await sleep(500);
  const phone = await ph.evaluate(() => ({
    sideways: document.documentElement.scrollWidth > innerWidth + 1,
    scan: [...document.querySelectorAll('button')].some(
      (b) => b.textContent.includes('امسح كارت QR') && b.getBoundingClientRect().height >= 44,
    ),
    focused: document.activeElement?.hasAttribute?.('data-desk-input'),
  }));
  ok(
    'phone 390: big Scan button, no sideways scroll, no keyboard popped',
    phone.scan && !phone.sideways && !phone.focused,
    JSON.stringify(phone),
  );
  await shot(ph, 'desk-phone-390');

  // ── Camera refused: a clear state, the desk keeps working.
  await ph.evaluateOnNewDocument(() => {
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' }));
  });
  await ph.reload({ waitUntil: 'networkidle2' });
  await clickText(ph, 'button', 'امسح كارت QR');
  await sleep(800);
  ok(
    'camera denied: says how to fix it, offers the keyboard',
    /الكاميرا مقفولة/.test(await ph.evaluate(() => document.body.innerText)),
  );
  await shot(ph, 'scanner-denied-390');
  await ph.close();
  await b.close();

  // ── The camera itself: Chrome's fake camera shows a real QR; jsQR/BarcodeDetector reads it.
  const video = join(OUT, 'qr.y4m');
  qrVideo(S.account.token, video);
  const cam = await launch([
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${video}`,
  ]);
  const c = await login(cam, 'reception', { width: 390, height: 844, mobile: true });
  await c.goto(`${WEB}/desk?academy=${F.academyId}`, { waitUntil: 'networkidle2' });
  await clickText(c, 'button', 'امسح كارت QR');
  txt = await waitPanel(c, /حساب طالب/, 12000);
  ok(
    'camera: a QR held up is read in the browser and resolves the student',
    txt.includes('حساب طالب'),
  );
  await shot(c, 'camera-read-390');
  const uploads = c.visited.filter((u) => /upload|frame|image/i.test(u));
  ok(
    'camera frames never leave the browser (no upload request)',
    uploads.length === 0,
    uploads.length,
  );
  await cam.close();

  // ── Leak check: the raw tokens this run used appear nowhere they should not.
  const log = readFileSync(process.env.API_LOG ?? join(tmpdir(), 'none.log'), {
    encoding: 'utf8',
    flag: 'a+',
  });
  const audit = JSON.stringify(await db.auditLog.findMany({ where: { academyId: F.academyId } }));
  const cards = JSON.stringify(await db.academyStudentCard.findMany());
  let leaks = 0;
  for (const tk of seenTokens) {
    if (log.includes(tk) || audit.includes(tk) || cards.includes(tk)) leaks++;
    if (r.visited.some((u) => u.includes(tk)) || r.consoleLines.some((l) => l.includes(tk)))
      leaks++;
  }
  ok(
    `raw tokens (${seenTokens.size}) absent from API log, audit log, card table, URLs and console`,
    leaks === 0,
    leaks,
  );
} catch (e) {
  ok('e2e completed', false, String(e?.stack ?? e).slice(0, 600));
} finally {
  writeFileSync(
    join(OUT, 'results.txt'),
    results.join('\n') + `\n${results.length - failed}/${results.length}\n`,
  );
  console.log(`\n${results.length - failed}/${results.length} passed — screenshots in ${OUT}`);
  await db.$disconnect();
  process.exit(failed ? 1 : 0);
}
