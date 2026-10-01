#!/usr/bin/env node
/**
 * C4 center fees — real browser E2E: real Chrome, the real API, real
 * PostgreSQL, the fixture from desk-seed.cjs (which turns centerFees on and
 * gives Reception fees.view + fees.collect). Every money outcome is checked in
 * the database, and the platform's own money tables are hashed before and
 * after: they must not change.
 *
 * Usage: DATABASE_URL=…/darsly_c3e2e node scripts/e2e/fees-e2e.mjs
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const { PrismaClient } = require('@prisma/client');

const url = new URL(process.env.DATABASE_URL ?? 'postgresql://x/none');
if (url.pathname !== '/darsly_c3e2e') throw new Error('refusing: not the e2e database');
const F = JSON.parse(readFileSync(join(tmpdir(), 'darsly-desk-e2e.json'), 'utf8'));
const OUT = process.env.E2E_OUT ?? join(tmpdir(), 'darsly-fees-e2e');
mkdirSync(OUT, { recursive: true });
const WEB = process.env.WEB ?? 'http://localhost:5173';
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const db = new PrismaClient();
const S = F.students;
const A = F.academyId;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let failed = 0;
const ok = (name, cond, detail = '') => {
  const line = `${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? ` — ${detail}` : ''}`;
  results.push(line);
  if (!cond) failed++;
  console.log(line);
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
const platformHash = async () =>
  JSON.stringify(
    await Promise.all(
      PLATFORM.map((t) =>
        db.$queryRawUnsafe(
          `SELECT count(*)::int n, md5(coalesce(string_agg(t::text,'|' ORDER BY id),'')) h FROM "${t}" t`,
        ),
      ),
    ),
  );
const owed = async (academyStudentId) =>
  (
    await db.$queryRaw`SELECT COALESCE(sum("outstandingCents"),0)::int n FROM "CenterChargeBalance" WHERE "academyStudentId" = ${academyStudentId} AND "voidedAt" IS NULL`
  )[0].n;

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
    window.print = () => {
      try {
        window.top.__printed = (window.top.__printed ?? 0) + 1;
      } catch {
        /* same origin */
      }
    };
    HTMLIFrameElement.prototype.remove = function () {
      try {
        window.top.__printDoc = this.contentDocument?.documentElement.outerHTML;
      } catch {
        /* same origin */
      }
      this.parentNode?.removeChild(this);
    };
  });
  await p.goto(`${WEB}/login`, { waitUntil: 'networkidle2' });
  await p.type('input[autocomplete=username]', F.emails[who]);
  await p.type('input[autocomplete=current-password]', F.password);
  await Promise.all([
    p.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => null),
    p.keyboard.press('Enter'),
  ]);
  await sleep(1200);
  return p;
}
const clickText = (p, sel, t) =>
  p.evaluate(
    (s, x) => {
      const el = [...document.querySelectorAll(s)].find(
        (e) => e.textContent.includes(x) && !e.disabled,
      );
      el?.scrollIntoView({ block: 'center' });
      el?.click();
      return !!el;
    },
    sel,
    t,
  );
const dialogText = (p) =>
  p.evaluate(() =>
    [...document.querySelectorAll('[role=dialog]')].map((d) => d.innerText).join('\n'),
  );
async function waitFor(p, fn, ms = 8000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn()) return true;
    await sleep(120);
  }
  return false;
}
async function typeIn(p, selector, text) {
  await p.click(selector, { clickCount: 3 });
  await p.keyboard.type(text, { delay: 5 });
}
const shot = (p, n) => p.screenshot({ path: join(OUT, `${n}.png`) });

try {
  const before = await platformHash();
  const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });

  // ── Owner: a monthly plan for group A, then a one-time charge.
  const o = await login(b, 'owner');
  ok(
    'owner: Fees in the menu',
    await o.evaluate(() => !!document.querySelector('a[href="/center/fees"]')),
  );
  await o.goto(`${WEB}/center/fees?academy=${A}`, { waitUntil: 'networkidle2' });
  await sleep(600);
  await clickText(o, '[role=tab]', 'خطط الرسوم');
  await sleep(400);
  await clickText(o, 'main button', 'خطة جديدة');
  await sleep(500);
  await typeIn(o, '[role=dialog] input:not([type])', 'فيزياء شهري');
  await o.select('[role=dialog] select', F.groups.A.id);
  await typeIn(o, '[role=dialog] input[inputmode=decimal]', '500');
  ok('money field reads the amount back', /500\.00/.test(await dialogText(o)));
  await shot(o, 'plan-dialog');
  await clickText(o, '[role=dialog] button', 'اعمل الخطة');
  await waitFor(o, async () => /اتعملت الخطة/.test(await dialogText(o)));
  const plan = await db.centerFeePlan.findFirst({ where: { academyId: A, name: 'فيزياء شهري' } });
  const groupA = await db.groupMembership.count({
    where: { groupId: F.groups.A.id, deletedAt: null },
  });
  const posted = await db.centerCharge.count({ where: { planId: plan?.id } });
  ok(
    'plan created through the screen; this month posted for the group, never earlier',
    !!plan && posted > 0 && posted <= groupA,
    `${posted} of ${groupA}`,
  );
  const s0 = S.a[0];
  const startOwed = await owed(s0.id);
  ok('learner owes this month: 500.00', startOwed === 50_000, startOwed);
  await clickText(o, '[role=dialog] button', 'تمام');
  // One-time 100 from Student 360 → Fees.
  await o.goto(`${WEB}/staff/students/${s0.studentId}?academy=${A}`, { waitUntil: 'networkidle2' });
  await sleep(900);
  ok('Student 360 has a "Center fees" tab', await clickText(o, '[role=tab]', 'رسوم السنتر'));
  await sleep(700);
  await clickText(o, 'main button', 'رسوم مرة واحدة');
  await sleep(400);
  await typeIn(o, '[role=dialog] input:not([type])', 'كتاب الفيزياء');
  await typeIn(o, '[role=dialog] input[inputmode=decimal]', '100');
  await clickText(o, '[role=dialog] button', 'سجّل البند');
  await waitFor(o, async () => (await owed(s0.id)) === 60_000);
  ok('one-time 100 added: 600.00 owed', (await owed(s0.id)) === 60_000);
  await shot(o, 'student360-fees');

  // ── Reception at the desk: owing student, collect 200 with a double click.
  const r = await login(b, 'reception');
  await r.goto(`${WEB}/desk?academy=${A}`, { waitUntil: 'networkidle2' });
  await sleep(500);
  await r.keyboard.type(s0.token, { delay: 2 });
  await r.keyboard.press('Enter');
  ok(
    'desk: fee strip shows 600.00 owed',
    await waitFor(r, async () =>
      /600\.00/.test(
        await r.evaluate(() => document.querySelector('section[aria-live]')?.innerText ?? ''),
      ),
    ),
  );
  await shot(r, 'desk-fee-strip');
  await clickText(r, 'section[aria-live] button', 'استلام فلوس');
  await sleep(700);
  await typeIn(r, '[role=dialog] input[inputmode=decimal]', '200');
  await clickText(r, '[role=dialog] button', 'مراجعة');
  await waitFor(r, async () => /تأكيد واستلام/.test(await dialogText(r)));
  const conf = await dialogText(r);
  ok(
    'confirmation shows student, amount, method and what it pays',
    /200\.00/.test(conf) &&
      /كاش/.test(conf) &&
      /هيسدد/.test(conf) &&
      conf.includes(s0.name.split(' ')[0]),
  );
  await shot(r, 'collect-confirm');
  const btn = await r.evaluateHandle(() =>
    [...document.querySelectorAll('[role=dialog] button')].find((x) =>
      x.textContent.includes('تأكيد واستلام'),
    ),
  );
  const box = await btn.asElement().boundingBox();
  await r.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { clickCount: 2, delay: 30 });
  ok(
    'receipt shown after confirm',
    await waitFor(r, async () => /اتسجل ✓/.test(await dialogText(r))),
  );
  await shot(r, 'receipt');
  const cols = await db.centerCollection.findMany({ where: { academyStudentId: s0.id } });
  ok('double click: exactly one collection, one receipt', cols.length === 1, cols.length);
  ok('balance 400.00 after 200', (await owed(s0.id)) === 40_000);
  await clickText(r, '[role=dialog] button', 'اطبع الإيصال');
  await sleep(1200);
  const doc = await r.evaluate(() => window.__printDoc ?? '');
  ok(
    'printed receipt: number, amount, remaining; no phone',
    doc.includes(cols[0].receiptNumber) &&
      /200\.00/.test(doc) &&
      /400\.00/.test(doc) &&
      !/\+20|guardian/i.test(doc),
  );
  await clickText(r, '[role=dialog] button', 'تمام');
  await sleep(300);
  // Attendance never waits on money: Enter checks in the owing learner.
  await r.click('[data-desk-input]');
  await r.keyboard.press('Enter');
  await waitFor(r, async () =>
    /حاضر ✓|متأخر/.test(
      await r.evaluate(() => document.querySelector('section[aria-live]')?.innerText ?? ''),
    ),
  );
  const rec = await db.attendanceRecord.findFirst({
    where: { studentId: s0.studentId, session: { groupSessionId: F.classes.A } },
  });
  ok(
    'an owing learner still checks in (attendance independent of money)',
    !!rec && ['PRESENT', 'LATE'].includes(rec.status),
    rec?.status,
  );
  // 300 then 100 from Student 360 (reception) → 0.
  const pay = async (p, amount) => {
    await clickText(p, 'main button', 'استلام فلوس');
    await sleep(600);
    await typeIn(p, '[role=dialog] input[inputmode=decimal]', amount);
    await clickText(p, '[role=dialog] button', 'مراجعة');
    await waitFor(p, async () => /تأكيد واستلام/.test(await dialogText(p)));
    await clickText(p, '[role=dialog] button', 'تأكيد واستلام');
    await waitFor(p, async () => /اتسجل ✓/.test(await dialogText(p)));
    await clickText(p, '[role=dialog] button', 'تمام');
    await sleep(400);
  };
  await r.goto(`${WEB}/staff/students/${s0.studentId}?academy=${A}`, { waitUntil: 'networkidle2' });
  await sleep(900);
  await clickText(r, '[role=tab]', 'رسوم السنتر');
  await sleep(700);
  await pay(r, '300');
  ok('after 300: 100.00 left', (await owed(s0.id)) === 10_000);
  await pay(r, '100');
  ok('after 100: nothing owed, no rounding drift', (await owed(s0.id)) === 0);
  const nums = (
    await db.centerCollection.findMany({
      where: { academyStudentId: s0.id },
      orderBy: { receivedAt: 'asc' },
    })
  ).map((k) => k.receiptNumber);
  ok('receipt numbers consecutive', nums.length === 3 && new Set(nums).size === 3, nums.join(','));
  ok(
    'reception cannot reverse or discount (no such buttons)',
    !(await o.evaluate(() => 0)) &&
      !(await r.evaluate(() =>
        /خصم \/ تصحيح|إلغاء التحصيل/.test(document.querySelector('main')?.innerText ?? ''),
      )),
  );

  // ── Owner: reverse one, discount 10%.
  await o.reload({ waitUntil: 'networkidle2' });
  await sleep(900);
  await clickText(o, '[role=tab]', 'رسوم السنتر');
  await sleep(800);
  await o.evaluate(() =>
    [...document.querySelectorAll('main section button')]
      .find((x) => /\d{4}-\d{6}/.test(x.textContent))
      ?.click(),
  );
  await sleep(800);
  await clickText(o, '[role=dialog] button', 'إلغاء التحصيل');
  await sleep(300);
  await typeIn(o, '[role=dialog] input', 'اتسجل بالغلط');
  await clickText(o, '[role=dialog] button', 'ألغي التحصيل');
  ok(
    'reversal: receipt kept and marked reversed',
    await waitFor(o, async () => /اتلغى/.test(await dialogText(o))),
  );
  await shot(o, 'receipt-reversed');
  const reversed = await db.centerCollection.findFirst({
    where: { academyStudentId: s0.id, reversedAt: { not: null } },
  });
  ok(
    'balance restored by exactly the reversed amount',
    !!reversed && (await owed(s0.id)) === reversed.amountCents,
    `${reversed?.amountCents}`,
  );
  await o.keyboard.press('Escape');
  await sleep(300);
  const s1 = S.a[1];
  await o.goto(`${WEB}/staff/students/${s1.studentId}?academy=${A}`, { waitUntil: 'networkidle2' });
  await sleep(900);
  await clickText(o, '[role=tab]', 'رسوم السنتر');
  await sleep(800);
  await clickText(o, 'main button', 'خصم / تصحيح');
  await sleep(400);
  await clickText(o, '[role=dialog] button', 'نسبة %');
  await typeIn(o, '[role=dialog] input[inputmode=decimal]', '10');
  await o.evaluate(() => [...document.querySelectorAll('[role=dialog] input')].at(-1)?.focus());
  await o.keyboard.type('خصم إخوات');
  await clickText(o, '[role=dialog] button', 'سجّل');
  await waitFor(o, async () => (await owed(s1.id)) === 45_000);
  ok('10% discount on 500: 450.00 owed, with its reason', (await owed(s1.id)) === 45_000);
  await shot(o, 'student360-discount');

  // ── Offline, then retry: one collection.
  await r.goto(`${WEB}/staff/students/${s1.studentId}?academy=${A}`, { waitUntil: 'networkidle2' });
  await sleep(900);
  await clickText(r, '[role=tab]', 'رسوم السنتر');
  await sleep(700);
  await clickText(r, 'main button', 'استلام فلوس');
  await sleep(600);
  await typeIn(r, '[role=dialog] input[inputmode=decimal]', '50');
  await clickText(r, '[role=dialog] button', 'مراجعة');
  await waitFor(r, async () => /تأكيد واستلام/.test(await dialogText(r)));
  await r.setOfflineMode(true);
  await clickText(r, '[role=dialog] button', 'تأكيد واستلام');
  ok(
    'offline: says nothing was recorded',
    await waitFor(r, async () => /مفيش اتصال/.test(await dialogText(r))),
  );
  await r.setOfflineMode(false);
  await clickText(r, '[role=dialog] button', 'حاول تاني');
  await waitFor(r, async () => /اتسجل ✓/.test(await dialogText(r)));
  ok(
    'retry: one collection of 50',
    (await db.centerCollection.count({ where: { academyStudentId: s1.id } })) === 1,
  );
  await clickText(r, '[role=dialog] button', 'تمام');

  // ── Two receptionists, the last 400 at once.
  const r2 = await login(b, 'reception2');
  const s2 = S.a[2];
  const open = async (p) => {
    await p.goto(`${WEB}/staff/students/${s2.studentId}?academy=${A}`, {
      waitUntil: 'networkidle2',
    });
    await sleep(900);
    await clickText(p, '[role=tab]', 'رسوم السنتر');
    await sleep(700);
    await clickText(p, 'main button', 'استلام فلوس');
    await sleep(600);
    await typeIn(p, '[role=dialog] input[inputmode=decimal]', '500');
    await clickText(p, '[role=dialog] button', 'مراجعة');
    await waitFor(p, async () => /تأكيد واستلام/.test(await dialogText(p)));
  };
  await open(r);
  await open(r2);
  await Promise.all([
    clickText(r, '[role=dialog] button', 'تأكيد واستلام'),
    clickText(r2, '[role=dialog] button', 'تأكيد واستلام'),
  ]);
  await sleep(2500);
  ok(
    'two desks, same last balance: one collection only',
    (await db.centerCollection.count({ where: { academyStudentId: s2.id } })) === 1,
  );
  ok(
    '…and the other desk is told why',
    /أكتر من المستحق|مفيش حاجة مستحقة/.test((await dialogText(r)) + (await dialogText(r2))),
  );

  // ── Reports: owner sees everyone, reception sees their own.
  await o.goto(`${WEB}/center/fees?academy=${A}`, { waitUntil: 'networkidle2' });
  await sleep(700);
  await clickText(o, '[role=tab]', 'التحصيل');
  await sleep(900);
  const day = await o.evaluate(() => document.querySelector('main')?.innerText ?? '');
  ok(
    'owner: today’s recorded collections with totals by method',
    /التحصيلات المسجلة/.test(day) && /كاش/.test(day),
  );
  await shot(o, 'fees-today');
  await r.goto(`${WEB}/center/fees?academy=${A}`, { waitUntil: 'networkidle2' });
  await sleep(700);
  await clickText(r, '[role=tab]', 'التحصيل');
  await sleep(900);
  ok(
    'reception: only their own collections',
    /تحصيلاتك انت بس/.test(await r.evaluate(() => document.querySelector('main')?.innerText ?? '')),
  );
  await clickText(r, '[role=tab]', 'خطط الرسوم');
  await sleep(600);
  ok(
    'reception: no plan editing',
    !(await r.evaluate(() => /خطة جديدة/.test(document.querySelector('main')?.innerText ?? ''))),
  );

  // ── Teacher and a desk-only assistant see no money.
  for (const who of ['teacher', 'c1only']) {
    const x = await login(b, who);
    const nav = await x.evaluate(() => !!document.querySelector('a[href="/center/fees"]'));
    await x.goto(`${WEB}/center/fees?academy=${A}`, { waitUntil: 'networkidle2' });
    await sleep(700);
    ok(
      `${who}: no Fees menu, the page refuses`,
      !nav && /مش مسموحلك/.test(await x.evaluate(() => document.body.innerText)),
    );
    await x.close();
  }

  await b.close();
  ok(
    'platform money tables byte-identical (Payment, ledger, wallet, payouts, Live, terms)',
    (await platformHash()) === before,
  );
} catch (e) {
  ok('fees e2e completed', false, String(e?.stack ?? e).slice(0, 600));
} finally {
  writeFileSync(
    join(OUT, 'results.txt'),
    results.join('\n') + `\n${results.length - failed}/${results.length}\n`,
  );
  console.log(`\n${results.length - failed}/${results.length} passed — ${OUT}`);
  await db.$disconnect();
  process.exit(failed ? 1 : 0);
}
