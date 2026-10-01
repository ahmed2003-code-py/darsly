#!/usr/bin/env node
/**
 * C5 student follow-up — responsive visual audit: every follow-up screen and
 * dialog, walked through every width, in Arabic (RTL) and English (LTR). See
 * ux-kit.mjs for what is checked. Writes nothing (dialogs are opened and
 * closed, never submitted).
 *
 * Needs the follow-up fixture (followup-seed.cjs, or FIXTURE=… for another
 * environment) with `followUp.absent` / `followUp.fees` learners.
 *
 * Usage: WEB=http://localhost:4000 node scripts/e2e/followup-ux.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeKit, puppeteer, sleep } from './ux-kit.mjs';

const F = JSON.parse(
  readFileSync(process.env.FIXTURE ?? join(tmpdir(), 'darsly-followup-e2e.json'), 'utf8'),
);
const WEB = process.env.WEB ?? 'http://localhost:4000';
const OUT = process.env.E2E_OUT ?? join(tmpdir(), 'darsly-followup-ux');
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const WIDTHS = (process.env.WIDTHS ?? '360,375,390,412,430,768,1024,1280,1440')
  .split(',')
  .map(Number);
const LANGS = (process.env.LANGS ?? 'ar,en').split(',');
const PARTS = (process.env.PARTS ?? 'page,student').split(',');
const kit = makeKit({
  F,
  WEB,
  OUT,
  WIDTHS,
  namespaces: [
    'followUp',
    'care',
    'fees',
    'desk',
    'registry',
    'err',
    'common',
    'nav',
    'team',
    'guardian',
  ],
});
const { login, sweep, clickText, report } = kit;
const A = F.academyId;
const U = F.followUp;

const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
try {
  for (const lang of LANGS) {
    const L = (ar, en) => (lang === 'en' ? en : ar);
    if (PARTS.includes('page')) {
      const r = await login(b, 'reception', lang);
      await r.goto(`${WEB}/center/follow-up?academy=${A}`, { waitUntil: 'networkidle2' });
      await sleep(1200);
      await sweep(r, 'followup-today', lang);
      await r.evaluate(
        (n, x) => {
          const li = [...document.querySelectorAll('main li')].find((l) =>
            l.textContent.includes(n),
          );
          [...(li?.querySelectorAll('button') ?? [])]
            .find((e) => e.textContent.includes(x))
            ?.click();
        },
        U.absent.name,
        L('سجّل تواصل', 'Log contact'),
      );
      await sleep(1500);
      await sweep(r, 'contact-dialog', lang, { dialog: true });
      await r.keyboard.press('Escape');
      await sleep(400);
      await r.evaluate(
        (n, x) => {
          const li = [...document.querySelectorAll('main li')].find((l) =>
            l.textContent.includes(n),
          );
          [...(li?.querySelectorAll('button') ?? [])]
            .find((e) => e.textContent.includes(x))
            ?.click();
        },
        U.late.name,
        L('افتح متابعة', 'Open case'),
      );
      await sleep(900);
      await sweep(r, 'open-case-dialog', lang, { dialog: true });
      await r.keyboard.press('Escape');
      await sleep(400);
      await clickText(r, '[role=tab]', L('المتابعات', 'Cases'));
      await sleep(1000);
      await sweep(r, 'followup-cases', lang);
      await clickText(r, '[role=tab]', L('اتكلمنا معاهم', 'Contacted'));
      await sleep(1000);
      await sweep(r, 'followup-contacts', lang);
      await r.close();
      const o = await login(b, 'owner', lang);
      await o.goto(`${WEB}/center/follow-up?academy=${A}`, { waitUntil: 'networkidle2' });
      await sleep(1000);
      await clickText(o, '[role=tab]', L('الإعدادات', 'Settings'));
      await sleep(900);
      await sweep(o, 'followup-settings', lang);
      await o.close();
    }
    if (PARTS.includes('student')) {
      const r = await login(b, 'reception', lang);
      await r.goto(`${WEB}/staff/students/${U.absent.studentId}?academy=${A}`, {
        waitUntil: 'networkidle2',
      });
      await sleep(1000);
      await clickText(r, '[role=tab]', L('المتابعة', 'Follow-up'));
      await sleep(1500);
      await sweep(r, 'student360-followup', lang);
      await clickText(r, 'main button', L('متابعة جديدة', 'New case'));
      await sleep(800);
      await sweep(r, 'manual-case-dialog', lang, { dialog: true });
      await r.keyboard.press('Escape');
      await sleep(300);
      await r.goto(`${WEB}/staff/students/${U.contact.studentId}?academy=${A}`, {
        waitUntil: 'networkidle2',
      });
      await sleep(1000);
      await clickText(r, '[role=tab]', L('أولياء الأمور', 'Guardians'));
      await sleep(1000);
      await sweep(r, 'guardians-register-contact', lang);
      await r.close();
    }
  }
} finally {
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  const n = report.reduce((s, r) => s + r.issues.length, 0);
  console.log(`\n${report.length} screens, ${n} issues — ${OUT}`);
  for (const r of report.filter((x) => x.issues.length))
    console.log(`  ${r.name} ${r.lang} ${r.width}: ${r.issues.join('; ')}`);
  await b.close();
}
