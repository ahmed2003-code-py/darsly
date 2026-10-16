/**
 * The in-process Darsly for browser E2E specs: the real AppModule (with the
 * overrides a spec asks for), the real built web app, a dedicated local
 * PostgreSQL migrated from scratch, and a real Chrome. Everything here is on
 * this machine; no provider key is read (they are set to stubs before the
 * .env file can fill them).
 *
 * The lessons of the meeting E2E (live-meeting.e2e-spec.ts) are built in:
 *  - ServeStaticModule registers nothing under Test.createTestingModule, so
 *    the web build is mounted here;
 *  - Chrome's Local Network Access checks are off for loopback;
 *  - this machine's sandbox refuses a socket now and then — listen is retried,
 *    assets are served from disk, and every timed-out wait dumps every page.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { INestApplication } from '@nestjs/common';
import type { Browser, BrowserContext, Page } from 'puppeteer-core';

export const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
export const WEB_DIR = join(__dirname, '..', '..', '..', 'web', 'dist');
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Reload and wait for the app to mount. Here a reload now and then comes back
 * blank (an asset request refused by the machine, `net::ERR_FAILED`) — the
 * environment, not the app — so a blank page is reloaded once more.
 */
export async function reloadMounted(page: Page) {
  const mounted = () =>
    page
      .waitForFunction(() => (document.getElementById('root')?.childElementCount ?? 0) > 0, {
        timeout: 15_000,
      })
      .then(() => true)
      .catch(() => false);
  await page.reload({ waitUntil: 'domcontentloaded' });
  if (!(await mounted())) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await mounted();
  }
}

/**
 * Headless Chrome on a profile of its own. On this machine Chrome now and then
 * refuses to start ("The browser is already running" for a brand-new profile)
 * — an environment hiccup, not the app: a fresh profile, a beat later, starts.
 */
export async function launchChrome(out: string, args: string[]): Promise<Browser> {
  const puppeteer = require('puppeteer-core');
  for (let attempt = 1; ; attempt++) {
    try {
      return await puppeteer.launch({
        executablePath: CHROME,
        headless: true,
        userDataDir: join(out, `profile-${Date.now()}-${attempt}`),
        dumpio: !!process.env.E2E_DUMPIO,
        args,
      });
    } catch (e) {
      if (attempt >= 3) throw e;
      console.warn(`[e2e] Chrome did not start (attempt ${attempt}): ${(e as Error).message}`);
      await sleep(1500 * attempt);
    }
  }
}

export interface Harness {
  app: INestApplication;
  base: string;
  prisma: any;
  browser: Browser;
  OUT: string;
  report: { name: string; ok: boolean; detail?: unknown }[];
  note(name: string, ok: boolean, detail?: unknown): void;
  waitFor<T>(
    what: string,
    fn: () => Promise<T | null | undefined | false> | T | null | undefined | false,
    timeoutMs?: number,
    everyMs?: number,
  ): Promise<T>;
  login(
    identifier: string,
    password: string,
  ): Promise<{ accessToken: string; refreshToken: string; user: unknown }>;
  openAs(
    ctx: BrowserContext,
    auth: { accessToken: string; refreshToken: string; user: unknown } | null,
    path: string,
    lang?: 'ar' | 'en',
  ): Promise<Page>;
  close(): Promise<void>;
}

/** Null (with the reason) when this machine cannot run it: no Chrome, no web build, no local DB. */
export async function bootHarness(o: {
  name: string;
  db: string;
  overrides?: (b: any, mods: Record<string, any>) => any;
}): Promise<Harness | string> {
  if (!existsSync(CHROME)) return `no Chrome at ${CHROME}`;
  if (!existsSync(join(WEB_DIR, 'index.html'))) return 'the web app is not built';
  const OUT = process.env.E2E_OUT ?? join(tmpdir(), `darsly-${o.name}-e2e`);
  mkdirSync(OUT, { recursive: true });

  const dotenv = require('dotenv');
  const fromFile = (() => {
    try {
      return dotenv.parse(readFileSync(join(__dirname, '..', '..', '.env')));
    } catch {
      return {} as Record<string, string>;
    }
  })();
  const dbUrl = new URL(process.env.DATABASE_URL ?? fromFile.DATABASE_URL ?? 'postgresql://x/none');
  if (!['localhost', '127.0.0.1'].includes(dbUrl.hostname)) return 'refusing: not a local database';
  const adminUrl = new URL(dbUrl.toString());
  adminUrl.pathname = '/postgres';
  dbUrl.pathname = `/${o.db}`;
  dbUrl.search = '?schema=public';
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: dbUrl.toString(),
    JWT_ACCESS_SECRET: 'e2e-access-secret-at-least-32-characters-long-x',
    JWT_REFRESH_SECRET: 'e2e-refresh-secret-at-least-32-characters-long-y',
    OPENAI_API_KEY: 'stub-key-e2e-not-a-real-key',
    RESEND_API_KEY: '',
    DAILY_API_KEY: '',
    S3_ENDPOINT: '',
    S3_ACCESS_KEY: '',
    S3_SECRET_KEY: '',
    S3_BUCKET: '',
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_PATH: join(OUT, 'storage'),
    REDIS_URL: '',
    CF_REALTIME_APP_ID: 'e2e-fake-sfu',
    CF_REALTIME_APP_SECRET: 'e2e-fake-sfu',
    LIVE_PROVIDER: 'cloudflare',
    LIVE_RECORDER_ENABLED: 'false',
    AI_ACADEMY_ENABLED: 'true',
    AI_MONTHLY_BUDGET_CENTS: '0',
    WORKER_ENABLED: 'true',
    ALLOWED_ORIGINS: 'http://127.0.0.1',
  });

  const { PrismaClient } = require('@prisma/client');
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${o.db} WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE ${o.db}`);
  } catch (e) {
    return `no local database: ${(e as Error).message.split('\n')[0]}`;
  } finally {
    await admin.$disconnect();
  }
  require('child_process').execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['prisma', 'migrate', 'deploy'],
    {
      cwd: join(__dirname, '..', '..'),
      env: process.env,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    },
  );

  const browser = await launchChrome(OUT, [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--disable-features=WebRtcHideLocalIpsWithMdns,LocalNetworkAccessChecks,LocalNetworkAccessChecksWarn,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests',
    '--no-first-run',
  ]);

  const { Test } = require('@nestjs/testing');
  const { ValidationPipe } = require('@nestjs/common');
  const { IoAdapter } = require('@nestjs/platform-socket.io');
  const express = require('express');
  const mods = {
    AppModule: require('../../src/app.module').AppModule,
    AiClient: require('../../src/academy-site/ai/ai.client').AiClient,
    AcademySiteConfig: require('../../src/academy-site/academy-site.config').AcademySiteConfig,
    PrismaService: require('../../src/prisma/prisma.service').PrismaService,
  };
  let builder = Test.createTestingModule({ imports: [mods.AppModule] });
  if (o.overrides) builder = o.overrides(builder, mods);
  const moduleRef = await builder.compile();
  const app: INestApplication = moduleRef.createNestApplication();
  const server = app.getHttpAdapter().getInstance();
  server.use(express.static(WEB_DIR, { index: false }));
  server.get(/^\/(?!api\/).*/, (_req: unknown, res: { sendFile: (p: string) => void }) =>
    res.sendFile(join(WEB_DIR, 'index.html')),
  );
  (app as any).use(require('../../src/common/request-context').requestIdMiddleware);
  const { JSON_BODY_LIMIT } = require('../../src/common/validation');
  (app as any).use(express.json({ limit: JSON_BODY_LIMIT }));
  (app as any).use(express.urlencoded({ limit: JSON_BODY_LIMIT, extended: true }));
  (app as any).use(require('../../src/common/errors/body-parser-errors').bodyParserErrors);
  require('../../src/common/routing').configureRouting(app);
  app.useGlobalPipes(
    new ValidationPipe(
      require('../../src/common/errors/validation-exception.factory').VALIDATION_PIPE_OPTIONS,
    ),
  );
  app.useWebSocketAdapter(new IoAdapter(app));
  for (let i = 0; ; i++) {
    try {
      await app.listen(0, '127.0.0.1');
      break;
    } catch (e) {
      if (i >= 7 || (e as NodeJS.ErrnoException).code !== 'EACCES') throw e;
      await sleep(1_000 * (i + 1));
    }
  }
  const port = (app.getHttpServer().address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const prisma = moduleRef.get(mods.PrismaService);

  const report: Harness['report'] = [];
  const pages: Page[] = [];
  const logs = new WeakMap<Page, string[]>();
  const note = (name: string, ok: boolean, detail?: unknown) => {
    report.push({ name, ok, detail });
    // eslint-disable-next-line no-console
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`,
    );
  };
  const dump = async (p: Page, tag: string) => {
    try {
      await p.screenshot({ path: join(OUT, `${tag}.png`) as `${string}.png`, fullPage: true });
      const text = await p.evaluate(() => document.body?.innerText ?? '');
      writeFileSync(
        join(OUT, `${tag}.txt`),
        [p.url(), text, (logs.get(p) ?? []).join('\n')].join('\n\n'),
      );
    } catch {
      /* best effort */
    }
  };
  const waitFor: Harness['waitFor'] = async (what, fn, timeoutMs = 30_000, everyMs = 250) => {
    const t0 = Date.now();
    let last: unknown;
    while (Date.now() - t0 < timeoutMs) {
      try {
        const v = await fn();
        if (v) return v as any;
      } catch (e) {
        last = e;
      }
      await sleep(everyMs);
    }
    const tag = `timeout-${what.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}-${Date.now()}`;
    for (const [i, p] of pages.entries()) if (!p.isClosed()) await dump(p, `${tag}-page${i}`);
    throw new Error(`timed out waiting for: ${what}${last ? ` (${String(last)})` : ''}`);
  };
  const login: Harness['login'] = async (identifier, password) => {
    const r = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password, deviceName: 'e2e' }),
    });
    if (!r.ok) throw new Error(`login ${r.status} ${await r.text()}`);
    return r.json() as any;
  };
  const openAs: Harness['openAs'] = async (ctx, auth, path, lang = 'en') => {
    const page = await ctx.newPage();
    pages.push(page);
    const log: string[] = [];
    logs.set(page, log);
    await page.setViewport({ width: 1280, height: 900 });
    page.on('dialog', (d) => void d.accept());
    page.on('console', (m) => log.push(`[${m.type()}] ${m.text()}`.slice(0, 300)));
    page.on('pageerror', (e) => log.push(`[pageerror] ${String(e)}`.slice(0, 300)));
    page.on('response', (r) => {
      if (r.status() >= 400)
        log.push(`[http ${r.status()}] ${r.request().method()} ${r.url().slice(0, 160)}`);
    });
    await page.evaluateOnNewDocument(
      (a, l) => {
        try {
          if (a) localStorage.setItem('darsly-auth', JSON.stringify({ state: a, version: 0 }));
          localStorage.setItem('darsly_lang', l);
          localStorage.setItem('darsly-lang', l);
        } catch {
          /* first paint */
        }
      },
      auth as any,
      lang,
    );
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      if (r.isInterceptResolutionHandled()) return;
      const u = new URL(r.url());
      if (
        u.origin !== base ||
        u.pathname.startsWith('/api/') ||
        u.pathname.startsWith('/socket.io')
      ) {
        void r.continue();
        return;
      }
      const file = join(WEB_DIR, decodeURIComponent(u.pathname));
      const isFile = u.pathname !== '/' && existsSync(file) && statSync(file).isFile();
      const target = isFile ? file : join(WEB_DIR, 'index.html');
      const types: Record<string, string> = {
        js: 'text/javascript',
        css: 'text/css',
        html: 'text/html; charset=utf-8',
        svg: 'image/svg+xml',
        png: 'image/png',
        woff2: 'font/woff2',
        json: 'application/json',
        webmanifest: 'application/manifest+json',
        ico: 'image/x-icon',
      };
      void r.respond({
        status: 200,
        contentType: types[target.split('.').pop() ?? ''] ?? 'application/octet-stream',
        body: readFileSync(target),
      });
    });
    await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
    const mounted = () =>
      page
        .waitForFunction(() => (document.getElementById('root')?.childElementCount ?? 0) > 0, {
          timeout: 15_000,
        })
        .then(() => true)
        .catch(() => false);
    if (!(await mounted())) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await mounted();
    }
    return page;
  };
  return {
    app,
    base,
    prisma,
    browser,
    OUT,
    report,
    note,
    waitFor,
    login,
    openAs,
    close: async () => {
      writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
      await browser.close().catch(() => undefined);
      await app.close().catch(() => undefined);
    },
  };
}
