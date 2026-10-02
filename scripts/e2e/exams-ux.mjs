#!/usr/bin/env node
/**
 * C6 paper exams — responsive visual audit: the exams list, a draft mark
 * sheet, a published sheet, a makeup, every dialog, the settings and the
 * Student 360 grades tab, walked through every width, in Arabic (RTL) and
 * English (LTR). See ux-kit.mjs for what is checked. Dialogs are opened and
 * closed, never submitted.
 *
 * Run after exams-e2e.mjs (it leaves a published exam and its makeup); adds
 * one empty DRAFT exam to the LOCAL e2e database for the draft sheet.
 *
 * Usage: DATABASE_URL=…/darsly_c3e2e WEB=http://localhost:4000 node scripts/e2e/exams-ux.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeKit, puppeteer, sleep } from './ux-kit.mjs';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const url = new URL(process.env.DATABASE_URL ?? 'postgresql://x/none');
if (url.pathname !== '/darsly_c3e2e' || !['localhost', '127.0.0.1'].includes(url.hostname))
  throw new Error('refusing: not the local e2e database');
const F = JSON.parse(readFileSync(join(tmpdir(), 'darsly-desk-e2e.json'), 'utf8'));
const WEB = process.env.WEB ?? 'http://localhost:4000';
const OUT = process.env.E2E_OUT ?? join(tmpdir(), 'darsly-exams-ux');
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
  namespaces: ['exams', 'followUp', 'care', 'err', 'common', 'nav', 'team', 'guardian'],
});
const { login, sweep, clickText, report } = kit;
const A = F.academyId;
const db = new PrismaClient();

const published = await db.paperExam.findFirstOrThrow({
  where: { academyId: A, kind: 'REGULAR', status: 'PUBLISHED' },
});
const makeup = await db.paperExam.findFirstOrThrow({ where: { academyId: A, kind: 'MAKEUP' } });
const owner = await db.user.findFirstOrThrow({ where: { email: F.emails.owner } });
const draft =
  (await db.paperExam.findFirst({ where: { academyId: A, status: 'DRAFT' } })) ??
  (await db.paperExam.create({
    data: {
      academyId: A,
      groupId: F.groups.A.id,
      title: 'كيمياء عضوية — اختبار الشهر الطويل جدًا للتأكد من الالتفاف',
      examDate: published.examDate,
      maxScore: 5000,
      passScore: 2500,
      createdBy: owner.id,
      requestKey: randomUUID().replace(/-/g, ''),
    },
  }));
const low = await db.paperExamResult.findFirstOrThrow({
  where: { examId: published.id, status: 'SCORED' },
  include: { academyStudent: true },
});

const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
try {
  for (const lang of LANGS) {
    const L = (ar, en) => (lang === 'en' ? en : ar);
    const o = await login(b, 'owner', lang);
    await o.goto(`${WEB}/center/exams?academy=${A}`, { waitUntil: 'networkidle2' });
    await sleep(1200);
    await sweep(o, 'exams-list', lang);
    await clickText(o, 'main button', L('امتحان جديد', 'New exam'));
    await sleep(700);
    await sweep(o, 'create-dialog', lang, { dialog: true });
    await o.keyboard.press('Escape');
    await sleep(300);
    await clickText(o, '[role=tab]', L('الإعدادات', 'Settings'));
    await sleep(900);
    await sweep(o, 'exams-settings', lang);

    await o.goto(`${WEB}/center/exams/${draft.id}?academy=${A}`, { waitUntil: 'networkidle2' });
    await sleep(1200);
    await sweep(o, 'sheet-draft', lang);
    await o.evaluate(() => {
      const i = document.querySelector('main ul li input');
      i?.focus();
    });
    await o.keyboard.type('77');
    await sleep(300);
    await sweep(o, 'sheet-draft-invalid', lang);
    await clickText(o, 'main button', L('تعديل', 'Edit'));
    await sleep(700);
    await sweep(o, 'edit-dialog', lang, { dialog: true });
    await o.keyboard.press('Escape');
    await sleep(300);

    const p2 = await login(b, 'owner', lang);
    await p2.goto(`${WEB}/center/exams/${published.id}?academy=${A}`, {
      waitUntil: 'networkidle2',
    });
    await sleep(1200);
    await sweep(p2, 'sheet-published', lang);
    await p2.evaluate(
      (x) =>
        [...document.querySelectorAll('main ul li button')]
          .find((e) => e.textContent.trim() === x)
          ?.click(),
      L('تصحيح', 'Correct'),
    );
    await sleep(700);
    await sweep(p2, 'correct-dialog', lang, { dialog: true });
    await p2.keyboard.press('Escape');
    await sleep(300);
    await clickText(p2, 'main button', L('امتحان تعويضي', 'Makeup exam'));
    await sleep(700);
    await sweep(p2, 'makeup-dialog', lang, { dialog: true });
    await p2.keyboard.press('Escape');
    await sleep(300);
    await p2.goto(`${WEB}/center/exams/${makeup.id}?academy=${A}`, { waitUntil: 'networkidle2' });
    await sleep(1200);
    await sweep(p2, 'sheet-makeup', lang);
    await clickText(p2, 'main button', L('إلغاء الامتحان', 'Void exam'));
    await sleep(700);
    await sweep(p2, 'void-dialog', lang, { dialog: true });
    await p2.keyboard.press('Escape');
    await sleep(300);
    await p2.goto(`${WEB}/staff/students/${low.academyStudent.studentId}?academy=${A}`, {
      waitUntil: 'networkidle2',
    });
    await sleep(1200);
    await clickText(p2, '[role=tab]', L('الدرجات', 'Grades'));
    await sleep(1200);
    await sweep(p2, 'student360-grades', lang);
    await p2.goto(`${WEB}/center/follow-up?academy=${A}`, { waitUntil: 'networkidle2' });
    await sleep(1500);
    await sweep(p2, 'followup-low-grade', lang);
    await p2.close();
    await o.close();
  }
} finally {
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  const n = report.reduce((s, r) => s + r.issues.length, 0);
  console.log(`\n${report.length} screens, ${n} issues — ${OUT}`);
  for (const r of report.filter((x) => x.issues.length))
    console.log(`  ${r.name} ${r.lang} ${r.width}: ${r.issues.join('; ')}`);
  await b.close();
  await db.$disconnect();
}
