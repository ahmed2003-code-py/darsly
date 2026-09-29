#!/usr/bin/env node
/**
 * Verifies the error boundaries in a real browser, without crashing anything
 * real: the harness (harness.tsx) mounts the actual ErrorBoundary.tsx and a
 * test-only component that throws on demand.
 *
 * Needs Chrome (CHROME_PATH, or the default Windows/Linux locations). No
 * server and no port: the page is loaded with setContent.
 *
 *   node apps/web/scripts/error-boundary/verify.mjs [--shots <dir>]
 */
import { build } from 'esbuild';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const shotsAt = process.argv.includes('--shots')
  ? process.argv[process.argv.indexOf('--shots') + 1]
  : null;
const chrome =
  process.env.CHROME_PATH ??
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((p) => existsSync(p));
if (!chrome) throw new Error('No Chrome found — set CHROME_PATH');

const bundle = await build({
  entryPoints: [join(here, 'harness.tsx')],
  bundle: true,
  write: false,
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.json': 'json' },
  logLevel: 'silent',
  plugins: [
    {
      name: 'i18n-stub',
      setup(b) {
        b.onResolve({ filter: /^\.\.\/i18n$/ }, () => ({ path: join(here, 'i18n-stub.ts') }));
      },
    },
  ],
});
const js = bundle.outputFiles[0].text;

// The app's real stylesheet (theme tokens, .btn-primary): `npx vite build` first.
const assets = join(here, '../../dist/assets');
const cssFile = existsSync(assets) && readdirSync(assets).find((f) => /^index-.*[.]css$/.test(f));
if (!cssFile) throw new Error('Build the web app first (npx vite build in apps/web)');
const css = readFileSync(join(assets, cssFile), 'utf8');
const FONTS =
  'https://fonts.googleapis.com/css2?family=Rubik:wght@500;600;700;800&family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap';

const browser = await puppeteer.launch({
  executablePath: chrome,
  pipe: true,
  headless: true,
  // Ubuntu 24.04 CI runners forbid the unprivileged namespaces Chrome's sandbox needs.
  args: process.env.CI ? ['--no-sandbox'] : [],
});
let pass = 0;
let fail = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  ok ? pass++ : fail++;
};

async function open(lang, viewport) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  await page.setContent(
    `<!doctype html><html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8">` +
      `<link rel="stylesheet" href="${FONTS}"><style>${css}</style></head><body class="bg-surface text-on-surface"><div id="root"></div>` +
      `<script>window.HARNESS_LANG=${JSON.stringify(lang)}</script><script>${js.replace(/<\/script/g, '<\\/script')}</script></body></html>`,
    { waitUntil: 'load' },
  );
  return { page, logs };
}
const has = (page, sel) => page.$(sel).then(Boolean);
const text = (page) => page.evaluate(() => document.body.innerText);
const click = (page, id) => page.click(`[data-testid="${id}"]`);
const clickText = (page, t) =>
  page.evaluate(
    (t) =>
      [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === t)?.click(),
    t,
  );

const locale = (l) => JSON.parse(readFileSync(join(here, `../../src/i18n/${l}.json`), 'utf8'));
const ar = locale('ar');

{
  const { page, logs } = await open('ar', { width: 1280, height: 800 });
  check('renders the page normally', await has(page, '[data-testid="page"]'));

  await click(page, 'bug');
  const t1 = await text(page);
  check('a render bug shows the section fallback', t1.includes(ar.common.sectionError));
  check('the shell (nav) survives the crash', await has(page, '[data-testid="nav"]'));
  check('the crashed page content is gone', !(await has(page, '[data-testid="page"]')));
  check(
    'the crash is logged with its component stack',
    logs.some((l) => l.includes('[SectionErrorBoundary]')),
  );
  if (shotsAt) {
    mkdirSync(shotsAt, { recursive: true });
    await page.screenshot({ path: join(shotsAt, 'section-boundary-ar-desktop.png') });
  }

  await click(page, 'fix');
  await click(page, 'go-b');
  check('navigating to another route clears the fallback', await has(page, '[data-testid="page"]'));

  await click(page, 'once');
  check(
    'a transient failure shows the fallback',
    (await text(page)).includes(ar.common.sectionError),
  );
  await page.evaluate(() => (window.__broken = false));
  await clickText(page, ar.common.retry);
  check('Retry re-renders the page without reloading', await has(page, '[data-testid="page"]'));

  await click(page, 'chunk');
  const t2 = await text(page);
  check(
    'a lost lazy chunk is passed up to the root boundary',
    t2.includes(ar.common.unexpectedError),
  );
  check('…and not swallowed by the section boundary', !t2.includes(ar.common.sectionError));
  await page.close();
}
{
  const { page } = await open('ar', { width: 360, height: 740, deviceScaleFactor: 2 });
  await click(page, 'bug');
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  check('360px: the fallback fits without horizontal scroll', fits);
  if (shotsAt) await page.screenshot({ path: join(shotsAt, 'section-boundary-ar-mobile.png') });
  await page.close();
}
{
  const { page } = await open('en', { width: 360, height: 740, deviceScaleFactor: 2 });
  await click(page, 'bug');
  const en = locale('en');
  check('English copy in English', (await text(page)).includes(en.common.sectionError));
  if (shotsAt) await page.screenshot({ path: join(shotsAt, 'section-boundary-en-mobile.png') });
  await page.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
