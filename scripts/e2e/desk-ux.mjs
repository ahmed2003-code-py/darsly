#!/usr/bin/env node
/**
 * C3 desk — responsive visual audit. Drives the desk into each state once,
 * then walks the same page through every width (a resize, not a reload, so
 * the state holds) in Arabic (RTL) and English (LTR), checking:
 *   sideways scroll · raw translation keys · controls under 40 px on phones ·
 *   controls pushed off-screen · content hidden under the bottom nav at the
 *   true end of the scroll · a dialog running below the viewport.
 * Every screen is also saved as a PNG for a person to look at.
 *
 * Reads the fixture from desk-seed.cjs (or FIXTURE=… for another environment).
 * Usage: WEB=http://localhost:5173 node scripts/e2e/desk-ux.mjs
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const F = JSON.parse(
  readFileSync(process.env.FIXTURE ?? join(tmpdir(), 'darsly-desk-e2e.json'), 'utf8'),
);
const WEB = process.env.WEB ?? 'http://localhost:5173';
const OUT = process.env.E2E_OUT ?? join(tmpdir(), 'darsly-desk-ux');
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const WIDTHS = (process.env.WIDTHS ?? '360,375,390,412,430,768,1024,1280,1440')
  .split(',')
  .map(Number);
const LANGS = (process.env.LANGS ?? 'ar,en').split(',');
/** Which parts to run: desk (reception states), camera, owner (Student 360). */
const PARTS = (process.env.PARTS ?? 'desk,camera,owner').split(',');
mkdirSync(OUT, { recursive: true });
const S = F.students;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const heightFor = (w) => (w < 600 ? 844 : w < 1100 ? 1024 : 900);

const report = [];
let issuesTotal = 0;

async function login(browser, who, lang, { denyCamera = false } = {}) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: 1280, height: 900 });
  await p.evaluateOnNewDocument(
    (l, deny) => {
      try {
        localStorage.setItem('darsly_lang', l);
        localStorage.setItem('darsly-lang', l);
      } catch {
        /* first paint */
      }
      window.print = () => undefined;
      if (deny && navigator.mediaDevices)
        navigator.mediaDevices.getUserMedia = () =>
          Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' }));
    },
    lang,
    denyCamera,
  );
  await p.goto(`${WEB}/login`, { waitUntil: 'networkidle2' });
  // One shared password (local seed) or per-actor credentials (FIXTURE for another environment).
  const login1 = F.credentials?.[who] ?? { email: F.emails[who], password: F.password };
  await p.type('input[autocomplete=username]', login1.email);
  await p.type('input[autocomplete=current-password]', login1.password);
  await Promise.all([
    p.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => null),
    p.keyboard.press('Enter'),
  ]);
  await sleep(600);
  await p.addStyleTag({ content: 'html{scroll-behavior:auto!important}' }).catch(() => undefined);
  return p;
}

const inspect = (p) =>
  p.evaluate(() => {
    const out = [];
    const W = innerWidth;
    if (document.documentElement.scrollWidth > W + 1) out.push('SIDEWAYS');
    const raw = document.body.innerText.match(
      /\b(desk|card|registry|classes|err|common|nav|team)\.[a-zA-Z_.]+[a-zA-Z]\b/g,
    );
    if (raw) out.push(`RAW ${raw.slice(0, 2)}`);
    const roots = document.querySelectorAll('main, [role=dialog], [role=alertdialog]');
    for (const root of roots)
      for (const el of root.querySelectorAll(
        'button, a[href], select, input:not([type=hidden]), summary, [role=switch]',
      )) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || el.closest('nav') || el.closest('.sr-only')) continue;
        if (W < 768 && (r.height < 40 || (r.width < 40 && el.tagName !== 'INPUT')))
          out.push(
            `SMALL "${(el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 14)}" ${Math.round(r.width)}x${Math.round(r.height)}`,
          );
        if ((r.right > W + 1 || r.left < -1) && !el.closest('[class*="overflow-x-auto"]'))
          out.push(`OFFSCREEN "${(el.textContent || '').trim().slice(0, 14)}"`);
      }
    for (const d of document.querySelectorAll('[role=dialog], [role=alertdialog]')) {
      const r = d.getBoundingClientRect();
      if (r.height && r.bottom > innerHeight + 1 && getComputedStyle(d).overflowY === 'visible')
        out.push('DIALOG BELOW VIEWPORT');
    }
    return [...new Set(out)];
  });

/** Scroll every scroller to its end; count controls left under the bottom nav. */
const hiddenAtEnd = (p) =>
  p.evaluate(async () => {
    for (const e of [document.scrollingElement, ...document.querySelectorAll('*')])
      if (
        e &&
        e.scrollHeight > e.clientHeight + 2 &&
        (e === document.scrollingElement || /auto|scroll/.test(getComputedStyle(e).overflowY))
      )
        e.scrollTop = e.scrollHeight;
    await new Promise((r) => setTimeout(r, 300));
    const bar = [...document.querySelectorAll('.shell-bottom')].find(
      (e) => getComputedStyle(e).display !== 'none',
    );
    const top = bar ? bar.getBoundingClientRect().top : innerHeight;
    const n = [...document.querySelectorAll('main a[href], main button, main input')].filter(
      (e) => {
        const r = e.getBoundingClientRect();
        // Content of a closed <details> is laid out but not shown.
        if (e.closest('details:not([open])') && !e.closest('summary')) return false;
        return r.height && r.bottom > top + 1 && r.top < innerHeight && !e.closest('.sticky');
      },
    ).length;
    window.scrollTo(0, 0);
    return n;
  });

async function sweep(p, name, lang, { dialog = false } = {}) {
  for (const w of WIDTHS) {
    await p.setViewport({ width: w, height: heightFor(w) });
    await sleep(350);
    const issues = await inspect(p);
    if (!dialog) {
      const hidden = await hiddenAtEnd(p);
      if (hidden) issues.push(`${hidden} under the bottom nav at scroll end`);
    }
    // Viewport shots (a full-page capture misplaces the sticky shell), and
    // on a phone a second one at the true end of the scroll.
    await p.screenshot({ path: join(OUT, `${name}-${lang}-${w}.png`) });
    if (
      !dialog &&
      w < 600 &&
      (await p.evaluate(() => document.documentElement.scrollHeight > innerHeight + 4))
    ) {
      await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await sleep(150);
      await p.screenshot({ path: join(OUT, `${name}-${lang}-${w}-end.png`) });
      await p.evaluate(() => window.scrollTo(0, 0));
    }
    report.push({ name, lang, w, issues });
    issuesTotal += issues.length;
    console.log(
      `${lang} ${String(w).padStart(4)} ${name.padEnd(22)} ${issues.length ? '⚠ ' + issues.slice(0, 4).join(' ‖ ') : 'ok'}`,
    );
  }
  await p.setViewport({ width: 1280, height: 900 });
  await sleep(200);
}

const box = '[data-desk-input]';
async function enter(p, text) {
  await p.click(box, { clickCount: 3 }).catch(() => undefined);
  await p.keyboard.type(text, { delay: 1 });
  await p.keyboard.press('Enter');
  await sleep(1200);
}
const clickText = (p, sel, t) =>
  p.evaluate(
    (s, x) => {
      const el = [...document.querySelectorAll(s)].find(
        (e) => e.textContent.includes(x) && !e.disabled,
      );
      el?.click();
      return !!el;
    },
    sel,
    t,
  );

const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
try {
  for (const [li, lang] of LANGS.entries()) {
    const L = (ar, en) => (lang === 'en' ? en : ar);
    const desk = `${WEB}/desk?academy=${F.academyId}`;
    if (PARTS.includes('desk')) {
      const r = await login(b, 'reception', lang);
      await r.goto(desk, { waitUntil: 'networkidle2' });
      await sleep(600);
      await sweep(r, 'desk-idle', lang);
      await enter(r, S.a[li * 5 + 1].token);
      await sweep(r, 'student-one-class', lang);
      await enter(r, S.multi.code);
      await sweep(r, 'two-classes-choose', lang);
      await enter(r, S.noClass.code);
      await sweep(r, 'no-class', lang);
      await enter(r, S.withdrawn.token);
      await sweep(r, 'withdrawn', lang);
      await enter(r, S.closed.code);
      await sweep(r, 'closed-attendance', lang);
      await enter(r, '1'.repeat(48));
      await sweep(r, 'invalid-card', lang);
      await enter(r, S.revoked.oldToken);
      await sweep(r, 'revoked-card', lang);
      await enter(r, S.guest.code);
      await r.evaluate(() => {
        const d = document.querySelector('section[aria-live] details');
        if (d) d.open = true;
      });
      await sweep(r, 'makeup-and-full', lang);
      await r.evaluate(() =>
        [...document.querySelectorAll('section[aria-live] details li')]
          .find((li) => li.querySelector('button'))
          ?.querySelector('button')
          ?.click(),
      );
      await sleep(500);
      await sweep(r, 'makeup-confirm', lang, { dialog: true });
      await r.keyboard.press('Escape');
      await sleep(300);
      await enter(r, L('مريم', 'مريم'));
      await sweep(r, 'search-results', lang);
      // Success: present, then late.
      await enter(r, S.a[li * 5].token);
      await r.keyboard.press('Enter');
      await sleep(1200);
      await sweep(r, 'success-present', lang);
      await enter(r, li ? S.a[li * 5 + 2].code : S.late.code);
      await clickText(r, 'section[aria-live] li button', L('سجّل', 'Check in'));
      await sleep(1200);
      await sweep(r, li ? 'success-second' : 'success-late', lang);
      // Rush: two in a row, then the same card again → "already".
      await clickText(r, 'button[role=switch]', L('الزحمة', 'Rush'));
      await enter(r, S.a[li * 5 + 3].token);
      await enter(r, S.a[li * 5 + 3].token);
      await sweep(r, 'rush-already-recent', lang);
      await clickText(r, 'button[role=switch]', L('الزحمة', 'Rush'));
      // New student (C1 registration from the desk).
      await clickText(r, 'section[aria-live] button', L('طالب جديد', 'New student'));
      await sleep(600);
      await sweep(r, 'new-student-dialog', lang, { dialog: true });
      await r.keyboard.press('Escape');
      await sleep(300);
      // Issue a card at the desk → print preview.
      await enter(r, li ? S.noCard2.code : S.noCard.code);
      if (await clickText(r, 'section[aria-live] button', L('اصدر كارت', 'Issue a card'))) {
        await sleep(500);
        await sweep(r, 'card-dialog', lang, { dialog: true });
        await clickText(r, '[role=dialog] button', L('اصدر كارت', 'Issue card'));
        await sleep(1500);
        await sweep(r, 'print-preview', lang, { dialog: true });
        await r.keyboard.press('Escape');
        await sleep(200);
        await r.keyboard.press('Escape');
      }
      // Offline last: Chrome's offline emulation can drop the icon font on a
      // relayout, which would spoil every later screenshot.
      await sleep(300);
      await r.setOfflineMode(true);
      await enter(r, S.a[li * 5 + 4].code);
      await sweep(r, 'offline', lang);
      await r.setOfflineMode(false);
      await r.close();
    }

    // The camera, refused (headless has none): the scanner overlay and its state.
    if (PARTS.includes('camera')) {
      const c = await login(b, 'reception', lang, { denyCamera: true });
      await c.goto(desk, { waitUntil: 'networkidle2' });
      await sleep(500);
      await c.setViewport({ width: 390, height: 844 });
      await clickText(c, 'button', L('امسح كارت QR', 'Scan QR card'));
      await sleep(1500);
      await sweep(c, 'scanner-denied', lang, { dialog: true });
      await c.keyboard.press('Escape');
      // The phone drawer, from the desk.
      await c.setViewport({ width: 390, height: 844 });
      await c.evaluate(() => document.querySelector('header button[aria-label]')?.click());
      await sleep(500);
      await c.screenshot({ path: join(OUT, `drawer-${lang}-390.png`) });
      await c.close();
    }

    // Owner: Student 360's card strip and the reissue dialog.
    if (PARTS.includes('owner')) {
      const o = await login(b, 'owner', lang);
      await o.goto(`${WEB}/staff/students/${S.a[li * 5 + 6].studentId}?academy=${F.academyId}`, {
        waitUntil: 'networkidle2',
      });
      await sleep(900);
      await sweep(o, 'student360-card', lang);
      await clickText(o, 'button', L('كارت جديد بدله', 'Replace card'));
      await sleep(500);
      await sweep(o, 'reissue-dialog', lang, { dialog: true });
      await o.close();
    }
  }
} finally {
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n${report.length} screens, ${issuesTotal} issues — ${OUT}`);
  await b.close();
}
