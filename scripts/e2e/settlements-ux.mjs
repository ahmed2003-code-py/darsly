#!/usr/bin/env node
/**
 * C8 teacher settlements — responsive visual audit: the settlements list, a
 * preview, teachers & rates, the rate dialog, one settlement and its pay /
 * adjust / void dialogs, walked through every width in Arabic (RTL) and
 * English (LTR). See ux-kit.mjs for what is checked. Dialogs are opened and
 * closed, never submitted.
 *
 * Run after settlements-e2e.mjs (it leaves a rate and a settlement).
 * Usage: DATABASE_URL=…/darsly_c3e2e WEB=http://localhost:4000 node scripts/e2e/settlements-ux.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeKit, puppeteer, sleep } from './ux-kit.mjs';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const url = new URL(process.env.DATABASE_URL ?? 'postgresql://x/none');
if (url.pathname !== '/darsly_c3e2e') throw new Error('refusing: not the e2e database');
const F = JSON.parse(readFileSync(join(tmpdir(), 'darsly-desk-e2e.json'), 'utf8'));
const WEB = process.env.WEB ?? 'http://localhost:4000';
const OUT = process.env.E2E_OUT ?? join(tmpdir(), 'darsly-settlements-ux');
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const WIDTHS = (process.env.WIDTHS ?? '360,375,390,412,430,768,1024,1280,1440')
  .split(',')
  .map(Number);
const LANGS = (process.env.LANGS ?? 'ar,en').split(',');
const kit = makeKit({
  F,
  WEB,
  OUT,
  WIDTHS,
  namespaces: ['settle', 'fees', 'err', 'common', 'nav', 'team'],
});
const { login, sweep, clickText, report } = kit;
const A = F.academyId;
const db = new PrismaClient();
const s = await db.teacherSettlement.findFirstOrThrow({
  where: { academyId: A },
  orderBy: { finalizedAt: 'desc' },
});
const teacher = await db.user.findFirstOrThrow({ where: { email: F.emails.teacher } });
const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: (await db.academy.findUniqueOrThrow({ where: { id: A } })).timezone,
}).format(new Date());
const back = (n) => {
  const [y, m, d] = today.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
};

const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
try {
  for (const lang of LANGS) {
    const L = (ar, en) => (lang === 'en' ? en : ar);
    const o = await login(b, 'owner', lang);
    await o.goto(`${WEB}/center/settlements?academy=${A}`, { waitUntil: 'networkidle2' });
    await sleep(1200);
    await sweep(o, 'settlements-list', lang);
    await clickText(o, '[role=tab]', L('المدرسين والأسعار', 'Teachers & rates'));
    await sleep(900);
    await sweep(o, 'teachers-rates', lang);
    await clickText(o, 'main button', L('أضف سعر', 'Add a rate'));
    await sleep(700);
    await sweep(o, 'rate-dialog', lang, { dialog: true });
    await o.keyboard.press('Escape');
    await sleep(300);
    await clickText(o, '[role=tab]', L('تسوية جديدة', 'New settlement'));
    await sleep(700);
    await o.select('main select', teacher.id);
    const dates = await o.$$('main input[type=date]');
    for (const [i, v] of [
      [0, back(10)],
      [1, back(1)],
    ])
      await dates[i].evaluate((el, val) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, v);
    await sleep(1500);
    await sweep(o, 'settle-preview', lang);
    await o.goto(`${WEB}/center/settlements/${s.id}?academy=${A}`, { waitUntil: 'networkidle2' });
    await sleep(1200);
    await sweep(o, 'settlement-detail', lang);
    await clickText(o, 'main button', L('مكافأة / خصم / تصحيح', 'Bonus / deduction / correction'));
    await sleep(700);
    await sweep(o, 'adjust-dialog', lang, { dialog: true });
    await o.keyboard.press('Escape');
    await o.close();
  }
} finally {
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  const n = report.reduce((x, r) => x + r.issues.length, 0);
  console.log(`\n${report.length} screens, ${n} issues — ${OUT}`);
  for (const r of report.filter((x) => x.issues.length))
    console.log(`  ${r.name} ${r.lang} ${r.w}: ${r.issues.join('; ')}`);
  await b.close();
  await db.$disconnect();
}
