#!/usr/bin/env node
/**
 * C5 student follow-up — real browser E2E: real Chrome, the real API, real
 * PostgreSQL, the fixture from desk-seed.cjs + followup-seed.cjs. Every outcome
 * is checked in the database; platform money and the C4 books are hashed
 * before and after and must not change because of follow-up.
 *
 * Usage: DATABASE_URL=…/darsly_c3e2e WEB=http://localhost:4000 node scripts/e2e/followup-e2e.mjs
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
const F = JSON.parse(readFileSync(join(tmpdir(), 'darsly-followup-e2e.json'), 'utf8'));
const OUT = process.env.E2E_OUT ?? join(tmpdir(), 'darsly-followup-e2e');
mkdirSync(OUT, { recursive: true });
const WEB = process.env.WEB ?? 'http://localhost:4000';
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const db = new PrismaClient();
const A = F.academyId;
const U = F.followUp;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let failed = 0;
const ok = (name, cond, detail = '') => {
  const line = `${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? ` — ${detail}` : ''}`;
  results.push(line);
  if (!cond) failed++;
  console.log(line);
};
const TEMPLATE_AR = 'مرحبًا، نرجو التواصل مع السنتر بخصوص متابعة الطالب.';
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
const dialogText = (p) =>
  p.evaluate(() => document.querySelector('[role=dialog]')?.innerText ?? '');
const mainText = (p) =>
  p.evaluate(() => document.querySelector('main')?.innerText ?? document.body.innerText);
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
      const el = [...document.querySelectorAll(s)].find(
        (e) => e.textContent.includes(x) && !e.disabled,
      );
      el?.click();
      return !!el;
    },
    sel,
    text,
  );
/** A button inside the Today row of one learner. */
const rowButton = (p, name, text) =>
  p.evaluate(
    (n, x) => {
      const li = [...document.querySelectorAll('main li')].find((l) => l.textContent.includes(n));
      const b = li && [...li.querySelectorAll('button')].find((e) => e.textContent.includes(x));
      b?.click();
      return !!b;
    },
    name,
    text,
  );
const shot = (p, n) => p.screenshot({ path: join(OUT, `${n}.png`) });

const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
const platformBefore = await hashOf(PLATFORM);
const c4Before = await hashOf(C4);
try {
  // ── Reception: Today's signals ───────────────────────────────────────
  const r = await login(b, 'reception');
  await r.goto(`${WEB}/center/follow-up?academy=${A}`, { waitUntil: 'networkidle2' });
  const listed = await waitFor(async () => {
    const tx = await mainText(r);
    return [U.absent.name, U.late.name, U.fees.name, U.owing.name].every((n) => tx.includes(n));
  });
  const today = await mainText(r);
  ok("Today's signals list the absent streak, the late streak and the overdue fees", listed, '');
  ok(
    'reasons are spelled out (no raw keys)',
    /غياب ورا بعض/.test(today) &&
      /تأخير ورا بعض/.test(today) &&
      /رسوم متأخرة/.test(today) &&
      !/followUp\./.test(today),
  );
  await shot(r, 'today');

  // Open a case from the signal, with a double click.
  ok('open-case button on the absent learner', await rowButton(r, U.absent.name, 'افتح متابعة'));
  await waitFor(async () => /فتح متابعة/.test(await dialogText(r)));
  const openBtn = await r.evaluateHandle(() =>
    [...document.querySelectorAll('[role=dialog] button[type=submit]')].find((x) =>
      x.textContent.includes('افتح متابعة'),
    ),
  );
  const ob = await openBtn.asElement().boundingBox();
  await r.mouse.click(ob.x + ob.width / 2, ob.y + ob.height / 2, { clickCount: 2, delay: 30 });
  await waitFor(async () => !(await dialogText(r)));
  const cases = await db.studentFollowUp.findMany({ where: { academyStudentId: U.absent.id } });
  ok(
    'double click: exactly one ABSENT_STREAK case',
    cases.length === 1 && cases[0].reason === 'ABSENT_STREAK' && cases[0].status === 'OPEN',
    cases.length,
  );
  await waitFor(async () => (await mainText(r)).includes('في متابعة مفتوحة'));

  // Log a contact — the WhatsApp handoff is privacy-safe; double click = one contact.
  ok('contact button on the absent learner', await rowButton(r, U.absent.name, 'سجّل تواصل'));
  await waitFor(async () => /تسجيل تواصل/.test(await dialogText(r)));
  await waitFor(async () =>
    r.evaluate(() => !!document.querySelector('[role=dialog] a[href^="https://wa.me/"]')),
  );
  const wa = await r.evaluate(
    () =>
      document.querySelector('[role=dialog] a[href^="https://wa.me/"]')?.getAttribute('href') ?? '',
  );
  const waText = decodeURIComponent(wa.split('text=')[1] ?? '');
  ok(
    'WhatsApp link: digits only + the fixed template; no name, amount or attendance detail',
    /^https:\/\/wa\.me\/\d{10,15}\?text=/.test(wa) &&
      waText === TEMPLATE_AR &&
      !wa.includes(encodeURIComponent(U.absent.name)),
    wa.slice(0, 40),
  );
  const tel = await r.evaluate(
    () => document.querySelector('[role=dialog] a[href^="tel:"]')?.getAttribute('href') ?? '',
  );
  ok('call link is tel:+digits', /^tel:\+\d{10,15}$/.test(tel), tel);
  await r.select(
    '[role=dialog] select:nth-of-type(1)',
    await r.evaluate(() => document.querySelector('[role=dialog] select')?.value),
  );
  await clickText(r, '[role=dialog] button[role=radio]', 'بعتنا رسالة');
  await r.evaluate(() => {
    const s = [...document.querySelectorAll('[role=dialog] select')][1];
    if (s) {
      s.value = 'WHATSAPP';
      s.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await r.type('[role=dialog] textarea', 'الأم ردت إن عنده برد');
  await shot(r, 'contact-dialog');
  const save = await r.evaluateHandle(() =>
    [...document.querySelectorAll('[role=dialog] button[type=submit]')].find((x) =>
      x.textContent.includes('سجّل التواصل'),
    ),
  );
  const sb = await save.asElement().boundingBox();
  await r.mouse.click(sb.x + sb.width / 2, sb.y + sb.height / 2, { clickCount: 2, delay: 30 });
  await waitFor(async () => !(await dialogText(r)));
  const contacts = await db.studentContact.findMany({ where: { academyStudentId: U.absent.id } });
  ok(
    'double click: exactly one contact, linked to the open case, WhatsApp / message sent, note kept',
    contacts.length === 1 &&
      contacts[0].followUpId === cases[0].id &&
      contacts[0].channel === 'WHATSAPP' &&
      contacts[0].outcome === 'MESSAGE_SENT' &&
      contacts[0].note === 'الأم ردت إن عنده برد',
    JSON.stringify(contacts.map((c) => [c.channel, c.outcome])),
  );
  const audit = await db.auditLog.findMany({
    where: { academyId: A, action: 'followup.contact.log' },
  });
  ok(
    'the audit has the contact but not its note',
    audit.length === 1 && !JSON.stringify(audit[0].meta).includes('برد'),
  );

  // Offline, then retry: one contact.
  await rowButton(r, U.late.name, 'سجّل تواصل');
  await waitFor(async () => /تسجيل تواصل/.test(await dialogText(r)));
  // The dialog loads who can be reached first; the outcomes appear after.
  await waitFor(async () =>
    r.evaluate(() => !!document.querySelector('[role=dialog] button[role=radio]')),
  );
  await clickText(r, '[role=dialog] button[role=radio]', 'مابيردش');
  await r.setOfflineMode(true);
  await clickText(r, '[role=dialog] button[type=submit]', 'سجّل التواصل');
  ok(
    'offline: the dialog says nothing was recorded',
    await waitFor(async () => /مفيش اتصال/.test(await dialogText(r))),
  );
  ok(
    'offline: nothing recorded, the dialog stays open',
    (await db.studentContact.count({ where: { academyStudentId: U.late.id } })) === 0 &&
      /تسجيل تواصل/.test(await dialogText(r)),
  );
  await shot(r, 'contact-offline');
  await r.setOfflineMode(false);
  await sleep(500);
  await clickText(r, '[role=dialog] button[type=submit]', 'حاول تاني');
  const closedAfterRetry = await waitFor(async () => !(await dialogText(r)));
  if (!closedAfterRetry)
    console.log(
      '   after retry the dialog says:',
      (await dialogText(r)).replace(/\s+/g, ' ').slice(-160),
    );
  ok(
    'retry with the same key: exactly one contact',
    (await db.studentContact.count({ where: { academyStudentId: U.late.id } })) === 1,
  );

  // ── Student 360 → Follow-up ──────────────────────────────────────────
  await r.goto(`${WEB}/staff/students/${U.absent.studentId}?academy=${A}`, {
    waitUntil: 'networkidle2',
  });
  await sleep(900);
  ok('Student 360 has a Follow-up tab', await clickText(r, '[role=tab]', 'المتابعة'));
  await waitFor(async () => /اللي حصل/.test(await mainText(r)));
  await waitFor(async () => /تواصل مع الأهل/.test(await mainText(r)));
  const s360 = await mainText(r);
  ok(
    'Student 360 Follow-up: the open case, the contact with its note, the timeline (attendance, contact)',
    /غياب ورا بعض/.test(s360) &&
      /الأم ردت/.test(s360) &&
      /حصة/.test(s360) &&
      /تواصل مع الأهل/.test(s360),
  );
  ok('the register number shows as a contact only', /رقم بس — مش ولي أمر متصل/.test(s360));
  await shot(r, 'student360-followup');
  await r.goto(`${WEB}/staff/students/${U.fees.studentId}?academy=${A}`, {
    waitUntil: 'networkidle2',
  });
  await sleep(900);
  await clickText(r, '[role=tab]', 'المتابعة');
  ok(
    'Reception holds fees.view: the fee charge is in the timeline',
    await waitFor(async () => /رسوم: ملزمة/.test(await mainText(r))),
  );

  // ── Register contact → explicit invitation → guardian ────────────────
  const usersBefore = await db.user.count({ where: { role: 'GUARDIAN' } });
  await clickText(r, '[role=tab]', 'أولياء الأمور');
  await waitFor(async () => /ادعوه كولي أمر/.test(await mainText(r)));
  ok(
    'reading the register contact created no account',
    (await db.user.count({ where: { role: 'GUARDIAN' } })) === usersBefore,
  );
  await shot(r, 'guardians-register-contact');
  await clickText(r, 'main button', 'ادعوه كولي أمر');
  await waitFor(async () => !!(await dialogText(r)));
  const prefilled = await r.evaluate(() =>
    [...document.querySelectorAll('[role=dialog] input')].map((i) => i.value),
  );
  const regPhone = (await db.academyStudent.findUniqueOrThrow({ where: { id: U.fees.id } }))
    .guardianPhone;
  ok(
    'the invite form is pre-filled from the register contact (staff still confirm)',
    prefilled.some((v) => v.replace(/\D/g, '').endsWith(regPhone.replace(/\D/g, '').slice(-9))),
    prefilled.join(' | '),
  );
  // The register holds no name for this contact: staff type it, as they would.
  const nameInput = await r.$('[role=dialog] input');
  if (nameInput && !(await r.evaluate((i) => i.value, nameInput)))
    await nameInput.type('والد الطالب');
  await r.evaluate(() => document.querySelector('[role=dialog] form')?.requestSubmit());
  await waitFor(async () => /\/g#/.test(await dialogText(r)));
  const linkUrl = (await dialogText(r)).match(/https?:\/\/\S+\/g#[A-Za-z0-9_-]+/)?.[0];
  ok('explicit invite: a guardian link is made and shown once', !!linkUrl);
  const link = await db.guardianLink.findFirst({
    where: { academyId: A, studentId: U.fees.studentId, status: 'ACTIVE' },
  });
  ok('a guardian link now exists for this learner', !!link);
  await r.keyboard.press('Escape');
  await sleep(500);
  await r.reload({ waitUntil: 'networkidle2' });
  await sleep(900);
  await clickText(r, '[role=tab]', 'أولياء الأمور');
  ok(
    'the new guardian is INVITED until the link is opened',
    await waitFor(async () => /متدعي/.test(await mainText(r))),
  );

  // The guardian opens the link: CONNECTED; fees hidden until the owner chooses.
  const gctx = await b.createBrowserContext();
  const g = await gctx.newPage();
  await g.setViewport({ width: 390, height: 844 });
  await g.goto(linkUrl.replace(/^https?:\/\/[^/]+/, WEB), { waitUntil: 'networkidle2' });
  await sleep(2500);
  const gText = await g.evaluate(() => document.body.innerText);
  ok(
    'the guardian is in — and sees no fees by default',
    /\S/.test(gText) && !/رسوم السنتر/.test(gText),
  );
  await r.reload({ waitUntil: 'networkidle2' });
  await sleep(900);
  await clickText(r, '[role=tab]', 'أولياء الأمور');
  ok(
    'after opening the link the guardian is CONNECTED',
    await waitFor(async () => /متصل/.test(await mainText(r))),
  );

  // ── Owner: settings ──────────────────────────────────────────────────
  const o = await login(b, 'owner');
  await o.goto(`${WEB}/center/follow-up?academy=${A}`, { waitUntil: 'networkidle2' });
  await sleep(900);
  ok('owner sees the Settings tab', await clickText(o, '[role=tab]', 'الإعدادات'));
  await sleep(800);
  await o.evaluate(() => {
    const box = [...document.querySelectorAll('main input[type=checkbox]')].pop();
    box?.click();
  });
  await clickText(o, 'main button[type=submit]', 'حفظ');
  await waitFor(async () => /اتحفظ/.test(await mainText(o)));
  await g.reload({ waitUntil: 'networkidle2' });
  await sleep(2000);
  const gFees = await g.evaluate(() => document.body.innerText);
  ok(
    'guardian fees ON: the guardian sees what is owed (150.00) — and nothing internal',
    /رسوم السنتر/.test(gFees) && /150\.00/.test(gFees) && !/ملاحظة|استلم/.test(gFees),
  );
  await g.screenshot({ path: join(OUT, 'guardian-fees.png') });
  // Threshold: 4 absences needed → the 3-absence streaks disappear; nothing else changes.
  const attBefore = await hashOf(['AttendanceRecord', 'StudentFollowUp']);
  await o.evaluate(() => {
    const n = document.querySelector('main input[type=number]');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(n, '4');
    n.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await clickText(o, 'main button[type=submit]', 'حفظ');
  await waitFor(async () => /اتحفظ/.test(await mainText(o)));
  await clickText(o, '[role=tab]', 'النهارده');
  await sleep(1500);
  const after4 = await mainText(o);
  ok(
    'threshold 4: the 3-absence streak signals are gone; attendance and cases untouched',
    !after4.includes(U.absent.name) &&
      JSON.stringify(await hashOf(['AttendanceRecord', 'StudentFollowUp'])) ===
        JSON.stringify(attBefore),
  );
  await clickText(o, '[role=tab]', 'الإعدادات');
  await sleep(700);
  await o.evaluate(() => {
    const n = document.querySelector('main input[type=number]');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(n, '3');
    n.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await clickText(o, 'main button[type=submit]', 'حفظ');
  await waitFor(async () => /اتحفظ/.test(await mainText(o)));

  // ── Two receptionists close the same case at once ────────────────────
  const r2 = await login(b, 'reception2');
  const openClose = async (p) => {
    await p.goto(`${WEB}/center/follow-up?academy=${A}`, { waitUntil: 'networkidle2' });
    await sleep(800);
    await clickText(p, '[role=tab]', 'المتابعات');
    await waitFor(async () => (await mainText(p)).includes(U.absent.name));
    await p.evaluate((n) => {
      const li = [...document.querySelectorAll('main li')].find((l) => l.textContent.includes(n));
      [...(li?.querySelectorAll('button') ?? [])]
        .find((e) => e.textContent.trim() === 'قفل')
        ?.click();
    }, U.absent.name);
    await waitFor(async () => /قفل المتابعة/.test(await dialogText(p)));
  };
  await Promise.all([openClose(r), openClose(r2)]);
  await clickText(r2, '[role=dialog] button[role=radio]', 'مش محتاجة');
  await r.type('[role=dialog] textarea', 'الأم أكدت إنه هيرجع');
  await r2.type('[role=dialog] textarea', 'مش محتاجة متابعة');
  await Promise.all([
    r.evaluate(() => document.querySelector('[role=dialog] form')?.requestSubmit()),
    r2.evaluate(() => document.querySelector('[role=dialog] form')?.requestSubmit()),
  ]);
  await sleep(2500);
  const closed = await db.studentFollowUp.findUniqueOrThrow({ where: { id: cases[0].id } });
  const texts = [await dialogText(r), await dialogText(r2)];
  ok(
    'two people close at once: one terminal state; the other is told it is already closed',
    ['RESOLVED', 'DISMISSED'].includes(closed.status) &&
      texts.filter((x) => /اتقفلت خلاص/.test(x)).length === 1,
    `${closed.status} | ${texts.map((x) => x.slice(0, 40)).join(' || ')}`,
  );
  await r2.close();

  // ── Never an attendance gate ─────────────────────────────────────────
  await r.goto(`${WEB}/desk?academy=${A}`, { waitUntil: 'networkidle2' });
  await sleep(700);
  await r.click('[data-desk-input]');
  await r.keyboard.type(U.owing.code, { delay: 2 });
  await r.keyboard.press('Enter');
  await sleep(1500);
  await r.click('[data-desk-input]');
  await r.keyboard.press('Enter');
  await waitFor(async () =>
    /حاضر ✓|متأخر/.test(
      await r.evaluate(() => document.querySelector('section[aria-live]')?.innerText ?? ''),
    ),
  );
  const rec = await db.attendanceRecord.findFirst({
    where: { studentId: U.owing.studentId, session: { groupSessionId: F.classes.A } },
  });
  ok(
    'CRITICAL: the overdue learner with an absence streak checks in at the desk',
    !!rec && ['PRESENT', 'LATE'].includes(rec.status),
    rec?.status,
  );
  await r.close();

  // ── A teacher sees nothing of follow-up ──────────────────────────────
  const t = await login(b, 'teacher');
  ok(
    'teacher: no Student follow-up in the navigation',
    !/متابعة الطلاب/.test(await t.evaluate(() => document.body.innerText)),
  );
  await t.goto(`${WEB}/center/follow-up?academy=${A}`, { waitUntil: 'networkidle2' });
  await sleep(1200);
  const tt = await t.evaluate(() => document.body.innerText);
  ok(
    'teacher opening /center/follow-up: refused, no learner shown',
    !tt.includes(U.absent.name) && /صلاحية|مش مفعّلة/.test(tt),
  );
  await t.close();

  ok(
    'platform money untouched by every C5 flow',
    JSON.stringify(await hashOf(PLATFORM)) === JSON.stringify(platformBefore),
  );
  ok(
    'the C4 books untouched by every C5 flow',
    JSON.stringify(await hashOf(C4)) === JSON.stringify(c4Before),
  );
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
