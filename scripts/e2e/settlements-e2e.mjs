#!/usr/bin/env node
/**
 * C8 teacher settlements + C9 feature-switch — real browser E2E: real Chrome,
 * the real API, real PostgreSQL, the fixture from desk-seed.cjs.
 *
 *  - Super Admin: the feature switch never claims more than the server saved —
 *    a confirmed save says so, a failed save (request aborted) says "not
 *    saved" and the switch keeps the server's value, the database agrees.
 *  - Owner: a pay rate, a preview from the classes taught (held only), a
 *    double-clicked finalize = one settlement, partial and final payments,
 *    a bonus, the statement, drift after a substitute is recorded.
 *  - Reception and the teacher: no menu entry, no access.
 *  - Phone width, Arabic RTL and English LTR, no sideways scroll.
 * Platform money and the students' fee books are hashed before and after.
 *
 * LOCAL E2E DATABASE ONLY. Writes fixture rows (past classes, a Super Admin
 * account with the fixture password) straight into that database.
 * Usage: DATABASE_URL=…/darsly_c3e2e WEB=http://localhost:4000 node scripts/e2e/settlements-e2e.mjs
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
const OUT = process.env.E2E_OUT ?? join(tmpdir(), 'darsly-settlements-e2e');
mkdirSync(OUT, { recursive: true });
const WEB = process.env.WEB ?? 'http://localhost:4000';
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
  'CenterCharge',
  'CenterCollection',
  'CenterAllocation',
  'CenterAdjustment',
  'CenterFeePlan',
];

async function login(b, email, { lang = 'ar', width = 1280 } = {}) {
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
  await p.waitForSelector('input[autocomplete=username]', { timeout: 20000 });
  await p.type('input[autocomplete=username]', email);
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
const setDate = (p, sel, value) =>
  p.evaluate(
    (s, v) => {
      const i = document.querySelector(s);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, v);
      i.dispatchEvent(new Event('input', { bubbles: true }));
    },
    sel,
    value,
  );
const shot = (p, n) => p.screenshot({ path: join(OUT, `${n}.png`), fullPage: true });

const academy = await db.academy.findUniqueOrThrow({
  where: { id: A },
  select: { timezone: true, ownerUserId: true },
});
const today = new Intl.DateTimeFormat('en-CA', { timeZone: academy.timezone }).format(new Date());
const day = (n) => {
  const [y, m, d] = today.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
};
const teacher = await db.user.findFirstOrThrow({ where: { email: F.emails.teacher } });
const owner = await db.user.findFirstOrThrow({ where: { email: F.emails.owner } });
// Fixture: three held classes of group A taught by the teacher on past days, one with attendance still open.
const held = [];
for (const n of [3, 2, 1]) {
  const startAt = new Date(`${day(n)}T09:00:00Z`);
  const gs = await db.groupSession.create({
    data: {
      academyId: A,
      groupId: GA,
      startAt,
      endAt: new Date(startAt.getTime() + 3_600_000),
      status: 'COMPLETED',
      locationType: 'CENTER',
      createdBy: owner.id,
      teacherUserId: teacher.id,
    },
  });
  await db.attendanceSession.create({
    data: {
      academyId: A,
      groupId: GA,
      date: new Date(`${day(n)}T00:00:00Z`),
      groupSessionId: gs.id,
      createdBy: owner.id,
      closedAt: new Date(),
      closedBy: owner.id,
    },
  });
  held.push(gs.id);
}
const openStart = new Date(`${day(4)}T09:00:00Z`);
const openClass = await db.groupSession.create({
  data: {
    academyId: A,
    groupId: GA,
    startAt: openStart,
    endAt: new Date(openStart.getTime() + 3_600_000),
    locationType: 'CENTER',
    createdBy: owner.id,
    teacherUserId: teacher.id,
  },
});
// A Super Admin account for the switch test (local only; the fixture's password hash).
const adminEmail = `admin-${randomUUID().slice(0, 6)}@desk-e2e.test`;
await db.user.create({
  data: {
    email: adminEmail,
    role: 'SUPER_ADMIN',
    fullName: 'Admin E2E',
    passwordHash: owner.passwordHash,
  },
});

const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
const before = { platform: await hashOf(PLATFORM), c4: await hashOf(C4) };
try {
  // ── C9: the Super Admin switch says only what the server saved ──────
  const ad = await login(b, adminEmail);
  await ad.goto(`${WEB}/admin/academies/${A}`, { waitUntil: 'networkidle2' });
  await waitFor(async () => (await main(ad)).includes(AR.admin.academyTab.flags));
  await clickText(ad, '[role=tab]', AR.admin.academyTab.flags);
  const label = AR.admin.featureFlag.teacherSettlement.label;
  await waitFor(async () => !!(await ad.$(`button[role=switch][aria-label="${label}"]`)));
  const sw = `button[role=switch][aria-label="${label}"]`;
  const checked = () => ad.$eval(sw, (e) => e.getAttribute('aria-checked'));
  const row = () => ad.$eval(sw, (e) => e.closest('div.flex')?.parentElement?.innerText ?? '');
  ok(
    'switch shows the saved state (ON) and when it was saved',
    (await checked()) === 'true' && /اتحفظ|Saved/.test(await row()),
  );
  await ad.click(sw);
  await waitFor(async () => (await row()).includes('اتحفظ: مقفول'));
  const off = await db.academyFeatureFlag.findFirst({
    where: { academyId: A, key: 'teacherSettlement' },
  });
  ok(
    'turned OFF: the server confirmed, the row says "Saved: OFF", the database agrees, audited',
    off?.enabled === false &&
      (await checked()) === 'false' &&
      (await db.auditLog.count({ where: { academyId: A, action: 'feature_flag.disable' } })) >= 1,
  );
  // A save that never reaches the server must never look saved.
  // (A tap within 800 ms of the last is ignored as a double tap — by design — so wait.)
  await sleep(1200);
  await ad.setRequestInterception(true);
  const block = (r) =>
    r.method() === 'PATCH' && r.url().includes('/feature-flags/') ? r.abort() : r.continue();
  ad.on('request', block);
  await ad.click(sw);
  await waitFor(async () => (await row()).includes(AR.admin.flagSave.notSaved), 20000);
  ok(
    'a failed save says "Not saved" and the switch keeps the server\'s value (OFF); nothing saved',
    (await row()).includes(AR.admin.flagSave.notSaved) &&
      (await checked()) === 'false' &&
      (await db.academyFeatureFlag.findFirst({ where: { academyId: A, key: 'teacherSettlement' } }))
        .enabled === false,
    `checked=${await checked()} row=${(await row()).replace(/s+/g, ' ').slice(0, 220)}`,
  );
  await shot(ad, 'admin-switch-failed');
  ad.off('request', block);
  await ad.setRequestInterception(false);
  await sleep(1200);
  await ad.click(sw);
  await waitFor(async () => (await row()).includes('اتحفظ: شغّال'));
  ok(
    'turned back ON: confirmed and persisted',
    (await checked()) === 'true' &&
      (await db.academyFeatureFlag.findFirst({ where: { academyId: A, key: 'teacherSettlement' } }))
        .enabled === true,
  );
  await shot(ad, 'admin-switch');
  await ad.close();
  await sleep(31_000); // the API caches a flag for 30 s

  // ── C8: the owner's flow ──────────────────────────────────────────────
  const o = await login(b, F.emails.owner);
  ok('owner: «مستحقات المدرسين» in the menu', !!(await o.$('a[href="/center/settlements"]')));
  await o.goto(`${WEB}/center/settlements?academy=${A}`, { waitUntil: 'networkidle2' });
  await waitFor(async () => (await main(o)).includes(AR.settle.title));
  await clickText(o, '[role=tab]', AR.settle.tab.teachers);
  await waitFor(async () => (await main(o)).includes(AR.settle.agreement.add));
  await clickText(o, 'main button', AR.settle.agreement.add);
  await waitFor(async () => (await dialogText(o)).includes(AR.settle.agreement.perClass));
  await o.evaluate(() =>
    document
      .querySelector(
        '[role=dialog] input[inputmode=decimal], [role=dialog] input:not([type=date]):not([type=checkbox])',
      )
      ?.focus(),
  );
  await o.keyboard.type('200');
  await setDate(o, '[role=dialog] input[type=date]', day(30));
  await clickText(o, '[role=dialog] button[type=submit]', AR.settle.agreement.save);
  await waitFor(async () => (await db.teacherAgreement.count({ where: { academyId: A } })) === 1);
  const ag = await db.teacherAgreement.findFirst({ where: { academyId: A } });
  ok(
    'a per-class rate of 200.00 from 30 days ago, saved',
    ag?.method === 'PER_SESSION' && ag.rateCents === 20_000,
  );
  await clickText(o, '[role=tab]', AR.settle.tab.settle);
  await waitFor(async () => !!(await o.$('main select')));
  await o.select('main select', teacher.id);
  const dates = await o.$$('main input[type=date]');
  await dates[0].evaluate((i, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, v);
    i.dispatchEvent(new Event('input', { bubbles: true }));
  }, day(10));
  await dates[1].evaluate((i, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, v);
    i.dispatchEvent(new Event('input', { bubbles: true }));
  }, day(1));
  await waitFor(async () => (await main(o)).includes(AR.settle.gross));
  const pv = await main(o);
  ok(
    'preview: the 3 held classes (600.00), the open one listed as not counted yet',
    /600[.,]00/.test(pv) &&
      pv.includes(AR.settle.pending) &&
      pv.includes(AR.settle.why.ATTENDANCE_OPEN),
  );
  await shot(o, 'preview');
  const fb = await (
    await o.evaluateHandle(
      (x) => [...document.querySelectorAll('main button')].find((e) => e.textContent.trim() === x),
      AR.settle.finalize,
    )
  )
    .asElement()
    .boundingBox();
  await o.mouse.click(fb.x + fb.width / 2, fb.y + fb.height / 2, { clickCount: 2, delay: 30 });
  await waitFor(async () => /\/center\/settlements\/[0-9a-f-]{36}/.test(o.url()));
  const sets = await db.teacherSettlement.findMany({ where: { academyId: A } });
  ok(
    'finalize (double click): exactly one settlement, 600.00, 3 lines',
    sets.length === 1 &&
      sets[0].grossCents === 60_000 &&
      (await db.teacherSettlementLine.count({ where: { settlementId: sets[0].id } })) === 3,
  );
  const sid = sets[0].id;
  // Partial payment.
  await waitFor(async () => (await main(o)).includes(AR.settle.pay.open));
  await clickText(o, 'main button', AR.settle.pay.open);
  await waitFor(async () => (await dialogText(o)).includes(AR.settle.pay.amount));
  await o.evaluate(() => document.querySelector('[role=dialog] input')?.focus());
  await o.keyboard.type('700');
  ok(
    'more than owed: the record button stays disabled',
    await o.evaluate(
      (x) =>
        [...document.querySelectorAll('[role=dialog] button[type=submit]')].find((e) =>
          e.textContent.includes(x),
        )?.disabled,
      AR.settle.pay.save,
    ),
  );
  await o.evaluate(() => {
    const i = document.querySelector('[role=dialog] input');
    i.select();
  });
  await o.keyboard.type('250');
  await clickText(o, '[role=dialog] button[type=submit]', AR.settle.pay.save);
  await waitFor(
    async () =>
      (await db.teacherSettlement.findUnique({ where: { id: sid } })).paidCents === 25_000,
  );
  ok(
    'partial payment 250.00: partly paid',
    (await db.teacherSettlement.findUnique({ where: { id: sid } })).status === 'PARTIALLY_PAID',
  );
  // Bonus.
  await waitFor(async () => !(await dialogText(o)));
  await clickText(o, 'main button', AR.settle.adjust.open);
  await waitFor(async () => (await dialogText(o)).includes(AR.settle.adjust.reason));
  await o.evaluate(() => document.querySelector('[role=dialog] input')?.focus());
  await o.keyboard.type('50');
  await o.evaluate(() => document.querySelector('[role=dialog] textarea')?.focus());
  await o.keyboard.type('مكافأة التزام');
  await clickText(o, '[role=dialog] button[type=submit]', AR.settle.adjust.save);
  await waitFor(
    async () =>
      (await db.teacherSettlement.findUnique({ where: { id: sid } })).adjustCents === 5_000,
  );
  ok(
    'bonus 50.00 with its reason: payable 650.00',
    (await db.teacherSettlement.findUnique({ where: { id: sid } })).adjustCents === 5_000,
  );
  // Final payment.
  await waitFor(async () => !(await dialogText(o)));
  await clickText(o, 'main button', AR.settle.pay.open);
  await waitFor(async () => (await dialogText(o)).includes(AR.settle.pay.amount));
  await o.evaluate(() => document.querySelector('[role=dialog] input')?.focus());
  await o.keyboard.type('400');
  await clickText(o, '[role=dialog] button[type=submit]', AR.settle.pay.save);
  await waitFor(
    async () => (await db.teacherSettlement.findUnique({ where: { id: sid } })).status === 'PAID',
  );
  ok(
    'final payment 400.00: paid in full',
    (await db.teacherSettlement.findUnique({ where: { id: sid } })).paidCents === 65_000,
  );
  await waitFor(async () => !(await main(o)).includes(AR.settle.pay.open));
  ok('paid: no more "record a payment"', !(await main(o)).includes(AR.settle.pay.open));
  // A substitute recorded after the fact: the frozen settlement shows drift.
  await db.groupSession.update({ where: { id: held[0] }, data: { teacherUserId: null } });
  await o.reload({ waitUntil: 'networkidle2' });
  await waitFor(async () => (await main(o)).includes(AR.settle.drift.title));
  ok(
    'a source change after finalizing shows as drift; the settlement stays 600.00',
    (await main(o)).includes(AR.settle.drift.title) &&
      (await db.teacherSettlement.findUnique({ where: { id: sid } })).grossCents === 60_000,
  );
  await shot(o, 'settlement');
  await o.close();

  // ── Others ────────────────────────────────────────────────────────────
  for (const who of ['reception', 'teacher']) {
    const p = await login(b, F.emails[who]);
    ok(`${who}: no «مستحقات المدرسين» entry`, !(await p.$('a[href="/center/settlements"]')));
    await p.goto(`${WEB}/center/settlements?academy=${A}`, { waitUntil: 'networkidle2' });
    await sleep(1500);
    const t = await p.evaluate(() => document.body.innerText);
    ok(
      `${who} at /center/settlements: no access, no figures`,
      t.includes(AR.settle.noAccess) && !/600[.,]00/.test(t),
    );
    await p.close();
  }
  for (const [lang, L, width] of [
    ['en', EN, 390],
    ['ar', AR, 360],
  ]) {
    const p = await login(b, F.emails.owner, { lang, width });
    await p.goto(`${WEB}/center/settlements/${sid}?academy=${A}`, { waitUntil: 'networkidle2' });
    await waitFor(async () => (await main(p)).includes(L.settle.sum.payable));
    ok(
      `${lang} ${width}px: the settlement reads ${lang === 'ar' ? 'RTL' : 'LTR'}, no raw keys, no sideways scroll`,
      (await p.evaluate(() => document.documentElement.dir)) === (lang === 'ar' ? 'rtl' : 'ltr') &&
        !/settle\.|err\./.test(await main(p)) &&
        (await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1,
    );
    await shot(p, `settlement-${lang}-${width}`);
    await p.close();
  }
  ok(
    'platform money untouched by every C8 flow',
    JSON.stringify(await hashOf(PLATFORM)) === JSON.stringify(before.platform),
  );
  ok(
    "the students' fee books untouched by every C8 flow",
    JSON.stringify(await hashOf(C4)) === JSON.stringify(before.c4),
  );
  void openClass;
} catch (e) {
  ok('E2E ran to the end', false, String(e?.stack ?? e).slice(0, 500));
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
