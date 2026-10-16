/**
 * Release QA (2026-10) for three of the reported bugs, in a real browser and
 * over real HTTP — the in-process app, the real built web, a real Chrome
 * (live-e2e/harness.ts). The AI is a stub: no paid call is ever made.
 *
 *  1. Studio: the wizard cannot reach Preview without a generated page (the
 *     reported "No Response" was Preview's SITE_NO_PAGE); the colour survives
 *     back/forward and a refresh; Generate pressed twice is one job; leaving
 *     and coming back during generation follows the same job; a provider that
 *     refuses the account is told in words, once, never in its own; the
 *     published page shows; the "not live" banner is true.
 *  2. Storefront /a/:slug: unpublished = the current app (signed in) or the
 *     current public frame (a visitor), Arabic RTL and English LTR, a course's
 *     years from grades[], staff told the page is not live; published = the
 *     teacher's own site.
 *  3. The academic-year rule attacked over HTTP with real tokens and known
 *     ids: listings, course page, preview/video, class notes, own notes,
 *     attachments, quizzes, assignments, enrolment, payment.
 *
 * Usage: npm run build --workspace=@darsly/web
 *        cd apps/api && npx jest -c test/jest-e2e.json test/studio-storefront.e2e-spec.ts --runInBand
 */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import type { Page } from 'puppeteer-core';
import { bootHarness, reloadMounted, sleep, type Harness } from './live-e2e/harness';

jest.setTimeout(20 * 60_000);
const EN = require('../../web/src/i18n/en.json');
const PASSWORD = 'E2e-Studio-Passw0rd!';

/** What the stub AI does on its next calls. */
let aiMode: 'ok' | 'slow' | 'account' = 'ok';
let aiCalls = 0;
const L = (s: string) => ({ ar: s, en: s });
const COPY = {
  seo: { metaTitle: L('أكاديمية تجربة'), metaDescription: L('صفحة تجربة') },
  hero: { headline: L('اتعلم معانا'), subheadline: L('شرح واضح خطوة بخطوة'), ctaLabel: L('ابدأ') },
  about: { heading: L('عنّي'), body: L('مدرس رياضيات بخبرة عشر سنين.') },
  toolkitHeading: L('بدرّس'),
  highlights: [L('جبر'), L('هندسة')],
  credentialsHeading: L('خبرتي'),
  credentials: [L('بكالوريوس رياضيات'), L('عشر سنين تدريس')],
  process: [
    { title: L('نفهم'), body: L('نفهم الفكرة') },
    { title: L('نحل'), body: L('نحل أمثلة') },
    { title: L('نراجع'), body: L('نراجع قبل الامتحان') },
  ],
  faq: [{ q: L('الحصص فين؟'), a: L('أونلاين') }],
};

let h: Harness;
let why = '';
const ready = () => {
  if (!h) console.warn(`skipping the studio/storefront E2E: ${why}`);
  return !!h;
};

beforeAll(async () => {
  const r = await bootHarness({
    name: 'studio',
    db: 'darsly_studio_e2e',
    overrides: (b, m) =>
      b.overrideProvider(m.AiClient).useFactory({
        factory: (config: any, p: any) => {
          const ai = new m.AiClient(config, p);
          (ai as any).client = {
            responses: {
              create: async (params: any) => {
                aiCalls++;
                if (aiMode === 'account') {
                  throw Object.assign(
                    new Error(
                      'You exceeded your current quota, please check your plan and billing details.',
                    ),
                    {
                      status: 429,
                      error: { code: 'insufficient_quota', type: 'insufficient_quota' },
                    },
                  );
                }
                if (aiMode === 'slow') await sleep(6_000);
                const name = params?.text?.format?.name;
                return {
                  id: `resp_${aiCalls}`,
                  status: 'completed',
                  output_text: JSON.stringify(name === 'academy_fixed_copy' ? COPY : {}),
                  usage: { input_tokens: 10, output_tokens: 10 },
                };
              },
            },
          };
          return ai;
        },
        inject: [m.AcademySiteConfig, m.PrismaService],
      }),
  });
  if (typeof r === 'string') why = r;
  else h = r;
}, 10 * 60_000);
afterAll(async () => {
  await h?.close();
});

// ── The world ───────────────────────────────────────────────────────────────

async function user(role: 'TEACHER' | 'STUDENT' | 'SUPER_ADMIN', tag: string) {
  const argon2 = require('argon2');
  const email = `e2e-${role.toLowerCase()}-${tag}-${randomUUID().slice(0, 6)}@e2e.test`;
  const u = await h.prisma.user.create({
    data: { role, fullName: `${role} ${tag}`, email, passwordHash: await argon2.hash(PASSWORD) },
  });
  return { ...u, email };
}

async function world() {
  const tag = randomUUID().slice(0, 6);
  const bacc1 = await h.prisma.gradeLevel.create({
    data: { nameAr: 'أولى بكالوريا', nameEn: 'Baccalaureate 1', code: `e2e-b1-${tag}` },
  });
  const bacc2 = await h.prisma.gradeLevel.create({
    data: { nameAr: 'تانية بكالوريا', nameEn: 'Baccalaureate 2', code: `e2e-b2-${tag}` },
  });
  const sec3 = await h.prisma.gradeLevel.create({
    data: { nameAr: 'تالتة ثانوي', nameEn: 'Secondary 3', code: `e2e-s3-${tag}` },
  });
  const teacher = await user('TEACHER', tag);
  const tp = await h.prisma.teacherProfile.create({
    data: { userId: teacher.id, slug: `e2e-t-${tag}`, status: 'APPROVED' },
  });
  const slug = `e2e-a-${tag}`;
  await h.prisma.academy.create({
    data: { id: tp.id, slug, name: `أكاديمية ${tag}`, ownerUserId: teacher.id, feeValue: 0 },
  });
  await h.prisma.academyMembership.create({
    data: {
      userId: teacher.id,
      academyId: tp.id,
      role: 'OWNER',
      status: 'ACTIVE',
      joinedAt: new Date(),
    },
  });
  const admin = await user('SUPER_ADMIN', tag);

  const course = async (title: string, gradeIds: string[]) => {
    const c = await h.prisma.course.create({
      data: {
        tenantId: tp.id,
        academyId: tp.id,
        title,
        priceCents: 5000,
        status: 'PUBLISHED',
        grades: { create: gradeIds.map((gradeId) => ({ gradeId })) },
      },
    });
    const unit = await h.prisma.courseUnit.create({ data: { courseId: c.id, title: 'U1' } });
    const preview = await h.prisma.lesson.create({
      data: { unitId: unit.id, title: 'Trial', isFreePreview: true },
    });
    const paid = await h.prisma.lesson.create({ data: { unitId: unit.id, title: 'Paid' } });
    return { c, preview, paid };
  };
  const scoped = await course('Course for Bacc 1 and 2', [bacc1.id, bacc2.id]);
  const open = await course('Course for every year', []);
  const key = `qa/${randomUUID()}.pdf`;
  const file = join(process.env.STORAGE_LOCAL_PATH!, key);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '%PDF-1.4 e2e');
  const attachment = await h.prisma.attachment.create({
    data: {
      lessonId: scoped.preview.id,
      fileName: 'sheet.pdf',
      storageKey: key,
      mimeType: 'application/pdf',
    },
  });
  await h.prisma.quiz.create({ data: { lessonId: scoped.preview.id } }).catch(() => undefined);

  const student = async (gradeId: string | null, held?: 'ACTIVE' | 'EXPIRED') => {
    const u = await user('STUDENT', tag);
    const sp = await h.prisma.studentProfile.create({ data: { userId: u.id, gradeId } });
    if (held) {
      await h.prisma.enrollment.create({
        data: {
          studentId: sp.id,
          courseId: scoped.c.id,
          tenantId: tp.id,
          academyId: tp.id,
          status: held,
          approvedAt: new Date(Date.now() - 86_400_000),
          ...(held === 'EXPIRED' ? { expiresAt: new Date(Date.now() - 3600_000) } : {}),
        },
      });
    }
    return u;
  };
  return {
    slug,
    tp,
    teacher,
    admin,
    scoped,
    open,
    attachment,
    students: {
      match: await student(bacc1.id),
      matchOther: await student(bacc2.id),
      wrong: await student(sec3.id),
      none: await student(null),
      heldActive: await student(sec3.id, 'ACTIVE'),
      heldExpired: await student(sec3.id, 'EXPIRED'),
    },
  };
}
type World = Awaited<ReturnType<typeof world>>;

const api = async (
  token: string,
  method: string,
  path: string,
  body?: unknown,
  academyId?: string,
) => {
  const r = await fetch(`${h.base}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(academyId ? { 'X-Academy-Id': academyId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON (a file) */
  }
  return { status: r.status, json, text };
};
const codeOf = (r: { status: number; json: any }) =>
  r.status < 300 ? 'OK' : (r.json?.code ?? `HTTP_${r.status}`);

// ── 3. The academic-year rule, attacked over HTTP ───────────────────────────

describe('the academic-year rule, over real HTTP with known ids', () => {
  let w: World;
  const tok: Record<string, string> = {};
  beforeAll(async () => {
    if (!h) return;
    w = await world();
    for (const [k, u] of Object.entries(w.students))
      tok[k] = (await h.login(u.email, PASSWORD)).accessToken;
    tok.teacher = (await h.login(w.teacher.email, PASSWORD)).accessToken;
    tok.admin = (await h.login(w.admin.email, PASSWORD)).accessToken;
  }, 120_000);

  // allowed (OK, or a refusal that is not about access: no video, no wallet…) vs refused.
  const expected: Record<
    string,
    { listed: boolean; door: 'OK' | 'COURSE_OTHER_YEAR' | 'YEAR_REQUIRED'; paid: string }
  > = {
    match: { listed: true, door: 'OK', paid: 'NOT_ENROLLED' },
    matchOther: { listed: true, door: 'OK', paid: 'NOT_ENROLLED' },
    wrong: { listed: false, door: 'COURSE_OTHER_YEAR', paid: 'COURSE_OTHER_YEAR' },
    none: { listed: true, door: 'YEAR_REQUIRED', paid: 'YEAR_REQUIRED' },
    heldActive: { listed: false, door: 'OK', paid: 'OK' },
    heldExpired: { listed: false, door: 'OK', paid: 'NOT_ENROLLED' },
  };

  for (const kind of Object.keys(expected)) {
    it(`a student — ${kind}`, async () => {
      if (!ready()) return;
      const t = tok[kind];
      const want = expected[kind];
      const out: Record<string, string> = {};

      const store = await api(t, 'GET', `/academies/${w.slug}/courses`);
      const site = await api(t, 'GET', `/a/${w.slug}/courses`);
      const disc = await api(t, 'GET', `/courses?teacherId=${w.tp.id}`);
      const listed = (store.json as any[]).some((c) => c.id === w.scoped.c.id);
      expect(listed).toBe(want.listed);
      expect((site.json as any[]).some((c) => c.url === `/course/${w.scoped.c.id}`)).toBe(
        want.listed,
      );
      expect((disc.json.items as any[]).some((c) => c.id === w.scoped.c.id)).toBe(want.listed);
      // A course that names no year is for everyone.
      expect((store.json as any[]).some((c) => c.id === w.open.c.id)).toBe(true);

      const detail = await api(t, 'GET', `/courses/${w.scoped.c.id}`);
      out.detail = detail.json?.viewer?.yearState;
      expect(out.detail).toBe(
        want.door === 'OK' ? 'OK' : want.door === 'YEAR_REQUIRED' ? 'YEAR_REQUIRED' : 'OTHER_YEAR',
      );

      // The free preview: allowed means "the video is not ready" (none here), never a year refusal.
      const play = await api(t, 'POST', '/playback/sessions', { lessonId: w.scoped.preview.id });
      out.preview = codeOf(play);
      expect(out.preview).toBe(want.door === 'OK' ? 'VIDEO_NOT_READY' : want.door);
      const playPaid = await api(t, 'POST', '/playback/sessions', { lessonId: w.scoped.paid.id });
      out.paid = codeOf(playPaid);
      expect(out.paid).toBe(want.paid === 'OK' ? 'VIDEO_NOT_READY' : want.paid);

      out.classNotes = codeOf(
        await api(t, 'GET', `/playback/lessons/${w.scoped.preview.id}/class-notes`),
      );
      expect(out.classNotes).toBe(want.door);
      out.notes = codeOf(
        await api(t, 'POST', `/playback/lessons/${w.scoped.preview.id}/notes`, {
          timestampSec: 1,
          body: 'n',
        }),
      );
      expect(out.notes).toBe(want.door);

      const att = await api(t, 'GET', `/files/attachments/${w.attachment.id}`);
      out.attachment = att.status === 200 ? 'OK' : `HTTP_${att.status}`;
      expect(out.attachment).toBe(want.door === 'OK' ? 'OK' : 'HTTP_404');

      const quiz = await api(t, 'GET', `/lessons/${w.scoped.preview.id}/quiz`);
      out.quiz = codeOf(quiz);
      if (want.door !== 'OK') expect(out.quiz).toBe(want.door);
      else expect(['OK', 'HTTP_404', 'NOT_FOUND']).toContain(out.quiz);
      const assign = await api(t, 'GET', `/lessons/${w.scoped.preview.id}/assignment`);
      out.assignment = codeOf(assign);
      if (want.door !== 'OK') expect(out.assignment).toBe(want.door);

      // Every way into the course refuses the wrong year (and asks for a missing one).
      const enrol = await api(t, 'POST', '/enrollments', { courseId: w.scoped.c.id });
      out.enrol = codeOf(enrol);
      const pay = await api(t, 'POST', '/payments', {
        courseId: w.scoped.c.id,
        method: 'INSTAPAY',
        reference: 'x',
      });
      out.payment = codeOf(pay);
      const wallet = await api(t, 'POST', '/payments/from-wallet', { courseId: w.scoped.c.id });
      out.wallet = codeOf(wallet);
      if (want.door !== 'OK' && kind !== 'heldActive' && kind !== 'heldExpired') {
        expect(out.enrol).toBe(want.door);
        expect(out.payment).toBe(want.door);
        expect(out.wallet).toBe(want.door);
      } else {
        for (const c of [out.enrol, out.payment, out.wallet]) {
          expect(['COURSE_OTHER_YEAR', 'YEAR_REQUIRED']).not.toContain(c);
        }
      }
      h.note(`year rule over HTTP — ${kind}`, true, out);
    });
  }

  it('the owner teacher and the super admin are never narrowed', async () => {
    if (!ready()) return;
    for (const [who, t] of [
      ['teacher', tok.teacher],
      ['admin', tok.admin],
    ] as const) {
      for (const lesson of [w.scoped.preview.id, w.scoped.paid.id]) {
        const r = await api(t, 'POST', '/playback/sessions', { lessonId: lesson });
        expect(codeOf(r)).toBe('VIDEO_NOT_READY');
      }
      const att = await api(t, 'GET', `/files/attachments/${w.attachment.id}`);
      expect(att.status).toBe(200);
      h.note(`year rule over HTTP — ${who} not narrowed`, true);
    }
  });
});

// ── 1 & 2. Studio and the storefront, in the browser ────────────────────────

const text = (p: Page) => p.evaluate(() => document.body.innerText);
async function clickText(p: Page, label: string, selector = 'button') {
  await h.waitFor(
    `button "${label}"`,
    () =>
      p.evaluate(
        (l, s) =>
          [...document.querySelectorAll(s)].some(
            (b) => b.textContent?.trim().includes(l) && !(b as HTMLButtonElement).disabled,
          ),
        label,
        selector,
      ),
    20_000,
  );
  await p.evaluate(
    (l, s) => {
      const b = [...document.querySelectorAll(s)].find(
        (x) => x.textContent?.trim().includes(l) && !(x as HTMLButtonElement).disabled,
      ) as HTMLElement;
      b.click();
    },
    label,
    selector,
  );
}
const nextDisabled = (p: Page) =>
  p.evaluate(
    () =>
      (document.querySelector('[data-action="wizard-next"]') as HTMLButtonElement | null)
        ?.disabled ?? null,
  );
const pressedPalette = (p: Page) =>
  p.evaluate(
    () =>
      document.querySelector('[data-palette][aria-pressed="true"]')?.getAttribute('data-palette') ??
      null,
  );
/** The guided flow (the page falls back to tabs if its first overview did not load). */
async function intoWizard(p: Page) {
  await h.waitFor(
    'studio loaded',
    async () =>
      !!(await p.$('[data-action="wizard-next"]')) || (await text(p)).includes(EN.studio.guided),
    30_000,
  );
  if (!(await p.$('[data-action="wizard-next"]'))) await clickText(p, EN.studio.guided);
  await h.waitFor('studio wizard', () => p.$('[data-action="wizard-next"]'), 30_000);
}

async function wizardTo(p: Page, step: 'generate') {
  // facts → media → generate: two presses of the wizard's Next.
  for (let i = 0; i < 2; i++) {
    await h.waitFor('wizard Next', async () => (await nextDisabled(p)) === false, 20_000);
    await p.click('[data-action="wizard-next"]');
    await sleep(300);
  }
  await h.waitFor(`wizard at ${step}`, () => p.$('[data-palette]'), 20_000);
}

describe('Studio and the storefront, in a real browser', () => {
  let w: World;
  let teacherAuth: any;
  beforeAll(async () => {
    if (!h) return;
    w = await world();
    teacherAuth = await h.login(w.teacher.email, PASSWORD);
    // The facts the generation needs (the "required information" step).
    const r = await api(
      teacherAuth.accessToken,
      'PUT',
      '/academy/facts',
      {
        fullName: 'مدرس تجربة',
        bio: 'مدرس رياضيات بخبرة عشر سنين في تدريس الثانوي والبكالوريا.',
        subjects: ['رياضيات'],
      },
      w.tp.id,
    );
    if (r.status >= 300) throw new Error(`facts ${r.status} ${r.text}`);
  }, 120_000);

  it('unpublished /a/:slug: the current app for a student, the public frame for a visitor', async () => {
    if (!ready()) return;
    const studentAuth = await h.login(w.students.match.email, PASSWORD);
    const ctx = await h.browser.createBrowserContext();
    const p = await h.openAs(ctx, studentAuth, `/a/${w.slug}`, 'en');
    await h.waitFor(
      'storefront course card',
      async () => (await text(p)).includes('Course for Bacc 1 and 2'),
      30_000,
    );
    const t1 = await text(p);
    // The years from grades[] (several), in English.
    expect(t1).toContain('Baccalaureate 1, Baccalaureate 2');
    // Inside the app: the signed-in shell, never the old "Sign in" header.
    const shell = await p.evaluate(
      (signIn) => ({
        dir:
          document.documentElement.dir ||
          document.body.dir ||
          getComputedStyle(document.body).direction,
        signIn: [...document.querySelectorAll('a')].some((a) => a.textContent?.trim() === signIn),
        nav: !!document.querySelector('aside, nav'),
        iframe: !!document.querySelector('iframe'),
      }),
      EN.storefront.login,
    );
    h.note(
      'storefront unpublished, signed-in student: inside the app',
      !shell.signIn && shell.nav && !shell.iframe,
      shell,
    );
    expect(shell.signIn).toBe(false);
    expect(shell.nav).toBe(true);
    expect(shell.iframe).toBe(false);
    // A wrong-year student is not shown the course; the open course stays.
    const wrongAuth = await h.login(w.students.wrong.email, PASSWORD);
    const ctxW = await h.browser.createBrowserContext();
    const pw = await h.openAs(ctxW, wrongAuth, `/a/${w.slug}`, 'en');
    await h.waitFor(
      'open course listed',
      async () => (await text(pw)).includes('Course for every year'),
      30_000,
    );
    expect(await text(pw)).not.toContain('Course for Bacc 1 and 2');
    await ctxW.close();
    await ctx.close();

    // A visitor, in Arabic: the public frame, right to left, sign-in and sign-up.
    const vctx = await h.browser.createBrowserContext();
    const v = await h.openAs(vctx, null, `/a/${w.slug}`, 'ar');
    await h.waitFor(
      'visitor storefront',
      async () => (await text(v)).includes('Course for Bacc 1 and 2'),
      30_000,
    );
    const vis = await v.evaluate(() => ({
      dir: getComputedStyle(document.querySelector('[dir]') ?? document.body).direction,
      links: [...document.querySelectorAll('a')].map((a) => a.getAttribute('href')),
    }));
    expect(vis.dir).toBe('rtl');
    expect(vis.links).toEqual(expect.arrayContaining(['/login', '/register']));
    expect(await text(v)).toContain('أولى بكالوريا، تانية بكالوريا');
    // Direct URL refreshed: the same page.
    await reloadMounted(v);
    await h.waitFor(
      'after refresh',
      async () => (await text(v)).includes('Course for Bacc 1 and 2'),
      30_000,
    );
    h.note('storefront unpublished, visitor: public frame, RTL, sign-in/up, refresh', true, vis);
    await vctx.close();

    // The teacher on their own page is told it is not live.
    const tctx = await h.browser.createBrowserContext();
    const tp = await h.openAs(tctx, teacherAuth, `/a/${w.slug}`, 'en');
    await h.waitFor(
      'staff not-live note',
      async () => (await text(tp)).includes(EN.storefront.notLiveForStaff),
      30_000,
    );
    h.note('storefront unpublished, staff: told it is not live', true);
    await tctx.close();
  });

  it('Studio: no Preview without a page; colour kept; one job; friendly failure; publish', async () => {
    if (!ready()) return;
    const ctx = await h.browser.createBrowserContext();
    const p = await h.openAs(ctx, teacherAuth, '/academy/studio', 'en');
    const sitePreview400: string[] = [];
    p.on('response', (r) => {
      if (/\/academy\/site\/preview/.test(r.url()) && r.status() === 400)
        sitePreview400.push(r.url());
    });
    await intoWizard(p);
    // The not-live banner from the start.
    expect(await p.$('[data-studio-live="no"]')).not.toBeNull();

    await wizardTo(p, 'generate');
    // The original bug: a colour picked, Next pressed — Next is closed, Preview never asked.
    await p.click('[data-palette="forest"]');
    expect(await nextDisabled(p)).toBe(true);
    await p.evaluate(() =>
      (document.querySelector('[data-action="wizard-next"]') as HTMLButtonElement).click(),
    );
    await p.evaluate(() =>
      (document.querySelector('[data-action="wizard-next"]') as HTMLButtonElement).click(),
    );
    await sleep(500);
    expect(await p.$('[data-palette]')).not.toBeNull();
    expect(await text(p)).toContain(EN.studio.wizard.generateFirst);
    h.note('studio: Next is closed on Generate until a page exists', true);

    // Back and forward: the colour is kept. A refresh: still kept.
    await clickText(p, EN.studio.wizard.prev);
    await sleep(300);
    await p.click('[data-action="wizard-next"]');
    await h.waitFor('back at generate', () => p.$('[data-palette]'), 15_000);
    expect(await pressedPalette(p)).toBe('forest');
    await reloadMounted(p);
    await intoWizard(p);
    await wizardTo(p, 'generate');
    expect(await pressedPalette(p)).toBe('forest');
    h.note('studio: colour kept across back/forward and a refresh', true);

    // A slow generation, Generate pressed twice: one job.
    aiMode = 'slow';
    await p.evaluate(() => {
      const b = document.querySelector('[data-action="generate"]') as HTMLButtonElement;
      b.click();
      b.click();
    });
    await h.waitFor(
      'generating',
      async () => (await text(p)).includes(EN.studio.generate.generating),
      15_000,
    );
    // Leave the step and come back while it works: it follows the same job.
    await clickText(p, EN.studio.wizard.prev);
    await sleep(500);
    await p.click('[data-action="wizard-next"]');
    await h.waitFor(
      'done',
      async () => (await text(p)).includes(EN.studio.generate.successTitle),
      60_000,
    );
    const jobs = await h.prisma.aiJob.count({
      where: { academyId: w.tp.id, type: 'SITE_GENERATE' },
    });
    h.note(
      'studio: Generate twice = one job; navigation during generation follows it',
      jobs === 1,
      { jobs },
    );
    expect(jobs).toBe(1);
    const site1 = await h.prisma.academySite.findUnique({ where: { academyId: w.tp.id } });
    expect(JSON.stringify(site1.draftDoc)).toContain('#059669'); // forest
    aiMode = 'ok';

    // Preview opens, and is a page (never SITE_NO_PAGE).
    await clickText(p, EN.studio.generate.previewBtn);
    await h.waitFor('preview iframe', () => p.$('iframe'), 20_000);
    expect(sitePreview400).toEqual([]);
    h.note('studio: Preview opens on a page; no SITE_NO_PAGE asked for', true);

    // Back, another colour, generate again.
    await clickText(p, EN.studio.wizard.prev);
    await h.waitFor(
      'generate step again',
      async () =>
        !!(await p.$('[data-palette]')) || (await text(p)).includes(EN.studio.generate.again),
      15_000,
    );
    if (!(await p.$('[data-palette]'))) await clickText(p, EN.studio.generate.again);
    await p.click('[data-palette="sunset"]');
    await p.click('[data-action="generate"]');
    await h.waitFor(
      'done again',
      async () => (await text(p)).includes(EN.studio.generate.successTitle),
      60_000,
    );
    const site2 = await h.prisma.academySite.findUnique({ where: { academyId: w.tp.id } });
    expect(JSON.stringify(site2.draftDoc)).toContain('#ea580c'); // sunset
    h.note('studio: a new colour, generated again', true);

    // A provider that refuses the account: told in words, once, never its own text.
    await clickText(p, EN.studio.generate.again);
    aiMode = 'account';
    const before = aiCalls;
    await p.click('[data-action="generate"]');
    await h.waitFor(
      'friendly failure',
      async () => (await text(p)).includes(EN.studio.generate.errors.AI_PROVIDER_UNAVAILABLE),
      60_000,
    );
    const body = await text(p);
    const leaked = /insufficient_quota|exceeded your current quota|OpenAI|429/i.test(body);
    const failed = await h.prisma.aiJob.findFirst({
      where: { academyId: w.tp.id, status: 'FAILED' },
      orderBy: { createdAt: 'desc' },
    });
    h.note(
      'studio: account failure is friendly, terminal, one call',
      !leaked && failed.attempts === 1 && aiCalls - before === 1,
      {
        attempts: failed.attempts,
        calls: aiCalls - before,
        leaked,
      },
    );
    expect(leaked).toBe(false);
    expect(failed.attempts).toBe(1);
    expect(aiCalls - before).toBe(1);
    // Retry once the account is fixed (after the client's account pause).
    aiMode = 'ok';
    const { AiClient } = require('../src/academy-site/ai/ai.client');
    (h.app.get(AiClient) as any).accountRefused = null;
    await p.click('[data-action="generate"]');
    await h.waitFor(
      'retry succeeded',
      async () => (await text(p)).includes(EN.studio.generate.successTitle),
      60_000,
    );
    h.note('studio: retry succeeds', true);

    // Preview → Publish: the banner goes, the page is live.
    await clickText(p, EN.studio.generate.previewBtn);
    await h.waitFor('preview', () => p.$('iframe'), 20_000);
    await p.click('[data-action="wizard-next"]');
    await clickText(p, EN.studio.publish.publishBtn);
    await h.waitFor('published', async () => !(await p.$('[data-studio-live="no"]')), 30_000);
    const status = await (await fetch(`${h.base}/api/v1/a/${w.slug}/site-status`)).json();
    expect(status.published).toBe(true);
    h.note('studio: published; the not-live banner is gone', true);
    await ctx.close();

    // Published: /a/:slug is the teacher's own site, isolated in its frame.
    const sctx = await h.browser.createBrowserContext();
    const s = await h.openAs(
      sctx,
      await h.login(w.students.match.email, PASSWORD),
      `/a/${w.slug}`,
      'en',
    );
    await h.waitFor('published site frame', () => s.$('iframe'), 30_000);
    const html = await (await fetch(`${h.base}/api/v1/a/${w.slug}`)).text();
    expect(html).toContain('اتعلم معانا');
    h.note('storefront published: the Studio site, in its own frame', true);
    await sctx.close();
  });

  it('a Center academy unpublished: the same current fallback', async () => {
    if (!ready()) return;
    const owner = await user('STAFF' as any, 'center').catch(() => null);
    const tag = randomUUID().slice(0, 6);
    const centerSlug = `e2e-c-${tag}`;
    await h.prisma.academy.create({
      data: {
        slug: centerSlug,
        name: `سنتر ${tag}`,
        kind: 'CENTER',
        ownerUserId: owner?.id ?? w.teacher.id,
      },
    });
    const vctx = await h.browser.createBrowserContext();
    const v = await h.openAs(vctx, null, `/a/${centerSlug}`, 'en');
    await h.waitFor('center page', async () => (await text(v)).includes(`سنتر ${tag}`), 30_000);
    expect(await text(v)).toContain(EN.storefront.noCourses);
    h.note('storefront: a Center renders the same current fallback', true);
    await vctx.close();
  });
});
