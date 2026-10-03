#!/usr/bin/env node
/**
 * C7 the day's operations — responsive visual audit: the day page (live and
 * as closed), and the close dialog, walked through every width in Arabic (RTL)
 * and English (LTR). See ux-kit.mjs for what is checked. The dialog is opened
 * and closed, never submitted.
 *
 * Run after ops-journey-e2e.mjs (it leaves a day with closes and open items).
 * Usage: WEB=http://localhost:4000 node scripts/e2e/day-ux.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeKit, puppeteer, sleep } from './ux-kit.mjs';

const F = JSON.parse(readFileSync(join(tmpdir(), 'darsly-desk-e2e.json'), 'utf8'));
const WEB = process.env.WEB ?? 'http://localhost:4000';
const OUT = process.env.E2E_OUT ?? join(tmpdir(), 'darsly-day-ux');
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
  namespaces: ['day', 'fees', 'err', 'common', 'nav', 'team'],
});
const { login, sweep, clickText, report } = kit;
const A = F.academyId;

const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
try {
  for (const lang of LANGS) {
    const L = (ar, en) => (lang === 'en' ? en : ar);
    const o = await login(b, 'owner', lang);
    await o.goto(`${WEB}/center/day?academy=${A}`, { waitUntil: 'networkidle2' });
    await sleep(1500);
    await sweep(o, 'day-live', lang);
    await clickText(o, '[role=radio]', L('وقت القفل', 'As closed'));
    await sleep(600);
    await sweep(o, 'day-as-closed', lang);
    await clickText(o, 'main button', L('اقفل تاني', 'Close again'));
    await sleep(800);
    await sweep(o, 'close-dialog', lang, { dialog: true });
    await o.keyboard.press('Escape');
    await sleep(300);
    await o.goto(`${WEB}/center/day?academy=${A}&date=2026-01-15`, { waitUntil: 'networkidle2' });
    await sleep(1200);
    await sweep(o, 'day-empty-past', lang);
    await o.close();
  }
} finally {
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  const n = report.reduce((s, r) => s + r.issues.length, 0);
  console.log(`\n${report.length} screens, ${n} issues — ${OUT}`);
  for (const r of report.filter((x) => x.issues.length))
    console.log(`  ${r.name} ${r.lang} ${r.w}: ${r.issues.join('; ')}`);
  await b.close();
}
