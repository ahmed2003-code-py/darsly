#!/usr/bin/env node
/**
 * C4 center fees — responsive visual audit: every fee screen, set up once and
 * walked through every width, in Arabic (RTL) and English (LTR). See
 * ux-kit.mjs for what is checked.
 *
 * Needs a fixture (desk-seed.cjs's, or FIXTURE=… for another environment) with
 * `students.feeAr` / `students.feeEn`: learners who owe something, with a card
 * token. Creates one small collection per language (the receipt screens).
 *
 * Usage: WEB=http://localhost:5173 node scripts/e2e/fees-ux.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeKit, puppeteer, sleep } from './ux-kit.mjs';

const F = JSON.parse(
  readFileSync(process.env.FIXTURE ?? join(tmpdir(), 'darsly-desk-e2e.json'), 'utf8'),
);
const WEB = process.env.WEB ?? 'http://localhost:5173';
const OUT = process.env.E2E_OUT ?? join(tmpdir(), 'darsly-fees-ux');
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const WIDTHS = (process.env.WIDTHS ?? '360,375,390,412,430,768,1024,1280,1440')
  .split(',')
  .map(Number);
const LANGS = (process.env.LANGS ?? 'ar,en').split(',');
const PARTS = (process.env.PARTS ?? 'desk,student,page').split(',');
const kit = makeKit({
  F,
  WEB,
  OUT,
  WIDTHS,
  namespaces: [
    'fees',
    'desk',
    'card',
    'registry',
    'classes',
    'err',
    'common',
    'nav',
    'team',
    'care',
  ],
});
const { login, sweep, clickText, report } = kit;
const A = F.academyId;
const S = F.students;

const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
try {
  for (const lang of LANGS) {
    const L = (ar, en) => (lang === 'en' ? en : ar);
    const who = lang === 'en' ? (S.feeEn ?? S.a[6]) : (S.feeAr ?? S.a[5]);

    if (PARTS.includes('desk')) {
      const r = await login(b, 'reception', lang);
      await r.goto(`${WEB}/desk?academy=${A}`, { waitUntil: 'networkidle2' });
      await sleep(600);
      await r.click('[data-desk-input]');
      await r.keyboard.type(who.token ?? who.code, { delay: 1 });
      await r.keyboard.press('Enter');
      await sleep(1600);
      await sweep(r, 'desk-fee-strip', lang);
      await clickText(r, 'section[aria-live] button', L('استلام فلوس', 'Collect'));
      await sleep(900);
      await r.click('[role=dialog] input[inputmode=decimal]', { clickCount: 3 });
      await r.keyboard.type('10');
      await sleep(300);
      await sweep(r, 'collect-amount', lang, { dialog: true });
      await clickText(r, '[role=dialog] button', L('مراجعة', 'Review'));
      await sleep(1200);
      await sweep(r, 'collect-confirm', lang, { dialog: true });
      await clickText(r, '[role=dialog] button', L('تأكيد واستلام', 'Confirm & record'));
      await sleep(1600);
      await sweep(r, 'collect-receipt', lang, { dialog: true });
      await r.close();
    }

    if (PARTS.includes('student')) {
      const o = await login(b, 'owner', lang);
      await o.goto(`${WEB}/staff/students/${who.studentId}?academy=${A}`, {
        waitUntil: 'networkidle2',
      });
      await sleep(1000);
      await clickText(o, '[role=tab]', L('رسوم السنتر', 'Center fees'));
      await sleep(1000);
      await sweep(o, 'student360-fees', lang);
      await clickText(o, 'main button', L('خصم / تصحيح', 'Discount / correct'));
      await sleep(600);
      await sweep(o, 'adjust-dialog', lang, { dialog: true });
      await o.keyboard.press('Escape');
      await sleep(300);
      await clickText(o, 'main button', L('رسوم مرة واحدة', 'One-time charge'));
      await sleep(600);
      await sweep(o, 'one-time-dialog', lang, { dialog: true });
      await o.keyboard.press('Escape');
      await sleep(300);
      await o.evaluate(() =>
        [...document.querySelectorAll('main section button')]
          .find((x) => /\d{4}-\d{6}/.test(x.textContent))
          ?.click(),
      );
      await sleep(1000);
      await sweep(o, 'receipt-view', lang, { dialog: true });
      await clickText(o, '[role=dialog] button', L('إلغاء التحصيل', 'Reverse'));
      await sleep(400);
      await sweep(o, 'reverse-form', lang, { dialog: true });
      await o.keyboard.press('Escape');
      await o.close();
    }

    if (PARTS.includes('page')) {
      const o = await login(b, 'owner', lang);
      await o.goto(`${WEB}/center/fees?academy=${A}`, { waitUntil: 'networkidle2' });
      await sleep(1000);
      await sweep(o, 'fees-owing', lang);
      await o.evaluate(() => document.querySelector('main ul li button')?.click());
      await sleep(1200);
      await sweep(o, 'owing-sheet', lang, { dialog: true });
      await o.keyboard.press('Escape');
      await sleep(300);
      await clickText(o, '[role=tab]', L('التحصيل', 'Collections'));
      await sleep(1000);
      await sweep(o, 'fees-today', lang);
      await clickText(o, '[role=tab]', L('خطط الرسوم', 'Fee plans'));
      await sleep(900);
      await sweep(o, 'fees-plans', lang);
      await clickText(o, 'main button', L('خطة جديدة', 'New plan'));
      await sleep(700);
      await sweep(o, 'plan-dialog', lang, { dialog: true });
      await o.keyboard.press('Escape');
      await o.close();
    }
  }
} finally {
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  const n = report.reduce((s, r) => s + r.issues.length, 0);
  console.log(`\n${report.length} screens, ${n} issues — ${OUT}`);
  await b.close();
}
