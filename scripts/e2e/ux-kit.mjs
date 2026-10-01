/**
 * Shared pieces of the responsive audits (fees-ux.mjs; desk-ux.mjs carries
 * its own copy): sign in, check a screen, walk it through every width.
 *
 * Checks per screen: sideways scroll · raw translation keys · controls under
 * 40 px on phones · controls pushed off-screen · content left under the
 * bottom nav at the true end of the scroll · a dialog running below the
 * viewport. Every screen is saved as a PNG for a person to look at.
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
export const puppeteer = require('puppeteer-core');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const heightFor = (w) => (w < 600 ? 844 : w < 1100 ? 1024 : 900);

export function makeKit({ F, WEB, OUT, WIDTHS, namespaces }) {
  mkdirSync(OUT, { recursive: true });
  const report = [];
  const raw = new RegExp(`\\b(${namespaces.join('|')})\\.[a-zA-Z_.]+[a-zA-Z]\\b`, 'g');

  async function login(browser, who, lang) {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width: 1280, height: 900 });
    await p.evaluateOnNewDocument((l) => {
      try {
        localStorage.setItem('darsly_lang', l);
        localStorage.setItem('darsly-lang', l);
      } catch {
        /* first paint */
      }
      window.print = () => undefined;
      // Instant scrolling on every page of the session, so a screenshot is never mid-scroll.
      document.addEventListener('DOMContentLoaded', () => {
        const s = document.createElement('style');
        s.textContent = 'html{scroll-behavior:auto!important}';
        document.head.appendChild(s);
      });
    }, lang);
    await p.goto(`${WEB}/login`, { waitUntil: 'networkidle2' });
    const c = F.credentials?.[who] ?? { email: F.emails[who], password: F.password };
    await p.type('input[autocomplete=username]', c.email);
    await p.type('input[autocomplete=current-password]', c.password);
    await Promise.all([
      p.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => null),
      p.keyboard.press('Enter'),
    ]);
    await sleep(800);
    return p;
  }

  const inspect = (p) =>
    p.evaluate((rawSrc) => {
      const out = [];
      const W = innerWidth;
      if (document.documentElement.scrollWidth > W + 1) out.push('SIDEWAYS');
      const m = document.body.innerText.match(new RegExp(rawSrc, 'g'));
      if (m) out.push(`RAW ${m.slice(0, 2)}`);
      for (const root of document.querySelectorAll('main, [role=dialog], [role=alertdialog]'))
        for (const el of root.querySelectorAll(
          'button, a[href], select, input:not([type=hidden]), summary, [role=switch], [role=tab]',
        )) {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height || el.closest('nav') || el.closest('.sr-only')) continue;
          if (el.matches('input[type=checkbox], input[type=radio]')) continue; // the label is the target
          if (W < 768 && (r.height < 40 || (r.width < 40 && el.tagName !== 'INPUT')))
            out.push(
              `SMALL "${(el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 14)}" ${Math.round(r.width)}x${Math.round(r.height)}`,
            );
          if ((r.right > W + 1 || r.left < -1) && !el.closest('[class*="overflow-x-auto"]'))
            out.push(`OFFSCREEN "${(el.textContent || '').trim().slice(0, 14)}"`);
        }
      // An amount never spills out of its card, row or dialog (money must read whole).
      for (const m of document.querySelectorAll('bdi.whitespace-nowrap')) {
        const box = m.closest('.card, li, [role=dialog]');
        if (!box) continue;
        const r = m.getBoundingClientRect();
        const c = box.getBoundingClientRect();
        if (r.width && (r.right > c.right + 1 || r.left < c.left - 1))
          out.push(`MONEY CLIPPED "${m.textContent.trim().slice(0, 16)}"`);
      }
      for (const d of document.querySelectorAll('[role=dialog], [role=alertdialog]')) {
        const r = d.getBoundingClientRect();
        if (r.height && r.bottom > innerHeight + 1 && getComputedStyle(d).overflowY === 'visible')
          out.push('DIALOG BELOW VIEWPORT');
      }
      return [...new Set(out)];
    }, raw.source);

  const hiddenAtEnd = (p) =>
    p.evaluate(async () => {
      for (const e of [document.scrollingElement, ...document.querySelectorAll('*')])
        if (
          e &&
          e.scrollHeight > e.clientHeight + 2 &&
          (e === document.scrollingElement || /auto|scroll/.test(getComputedStyle(e).overflowY))
        )
          e.scrollTop = e.scrollHeight;
      await new Promise((r) => setTimeout(r, 300));
      const bar = [...document.querySelectorAll('.shell-bottom')].find(
        (e) => getComputedStyle(e).display !== 'none',
      );
      const top = bar ? bar.getBoundingClientRect().top : innerHeight;
      const n = [...document.querySelectorAll('main a[href], main button, main input')].filter(
        (e) => {
          const r = e.getBoundingClientRect();
          if (e.closest('details:not([open])') && !e.closest('summary')) return false;
          return r.height && r.bottom > top + 1 && r.top < innerHeight && !e.closest('.sticky');
        },
      ).length;
      window.scrollTo(0, 0);
      return n;
    });

  async function sweep(p, name, lang, { dialog = false } = {}) {
    for (const w of WIDTHS) {
      await p.setViewport({ width: w, height: heightFor(w) });
      await sleep(350);
      const issues = await inspect(p);
      if (!dialog) {
        const hidden = await hiddenAtEnd(p);
        if (hidden) issues.push(`${hidden} under the bottom nav at scroll end`);
      }
      await p.screenshot({ path: join(OUT, `${name}-${lang}-${w}.png`) });
      if (
        !dialog &&
        w < 600 &&
        (await p.evaluate(() => document.documentElement.scrollHeight > innerHeight + 4))
      ) {
        await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await sleep(150);
        await p.screenshot({ path: join(OUT, `${name}-${lang}-${w}-end.png`) });
        await p.evaluate(() => window.scrollTo(0, 0));
      }
      report.push({ name, lang, w, issues });
      console.log(
        `${lang} ${String(w).padStart(4)} ${name.padEnd(22)} ${issues.length ? '⚠ ' + issues.slice(0, 4).join(' ‖ ') : 'ok'}`,
      );
    }
    await p.setViewport({ width: 1280, height: 900 });
    await sleep(200);
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

  return { login, inspect, sweep, clickText, report };
}
