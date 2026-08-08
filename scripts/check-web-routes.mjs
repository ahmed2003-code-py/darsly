#!/usr/bin/env node
/**
 * Guard against the two failures that broke the funnel silently:
 *
 *  1. An internal link pointing at a path no route serves. The academy sites
 *     linked to `/courses/<id>` while the app only ever served `/course/:id`,
 *     so every course card in every generated site was a 404 and nothing
 *     anywhere reported it.
 *
 *  2. A translation key that exists in one language but not the other, or is
 *     used in code and defined nowhere. Either way the UI silently falls back —
 *     which is how Arabic ended up showing inside the English interface.
 *
 * Usage: node scripts/check-web-routes.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const WEB = new URL('../apps/web/', import.meta.url).pathname;
const fail = [];

// ── routes ───────────────────────────────────────────────────────────────────
const app = readFileSync(join(WEB, 'src/App.tsx'), 'utf8');
const routes = [...app.matchAll(/path="([^"]+)"/g)].map((m) => m[1]).filter((r) => r !== '*');
const matchers = routes.map(
  (r) => new RegExp(`^${r.replace(/:[^/]+/g, '[^/]+').replace(/\/$/, '')}/?$`),
);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(tsx?|ts)$/.test(name) ? [full] : [];
  });
}
const sources = walk(join(WEB, 'src'));

const links = new Set(['/discover', '/course/any', '/a/any-slug']); // emitted by generated academy sites
for (const file of sources) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/(?:to|href)="(\/[^"]*)"/g)) links.add(m[1]);
}
for (const link of links) {
  const path = link.split(/[?#]/)[0].replace(/\/$/, '') || '/';
  if (!matchers.some((m) => m.test(path))) fail.push(`route: nothing serves ${link}`);
}

// ── translations ─────────────────────────────────────────────────────────────
const flatten = (obj, prefix = '') =>
  Object.entries(obj).reduce((acc, [k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return Object.assign(acc, v && typeof v === 'object' ? flatten(v, key) : { [key]: v });
  }, {});

const ar = flatten(JSON.parse(readFileSync(join(WEB, 'src/i18n/ar.json'), 'utf8')));
const en = flatten(JSON.parse(readFileSync(join(WEB, 'src/i18n/en.json'), 'utf8')));

for (const key of Object.keys(ar)) if (!(key in en)) fail.push(`i18n: "${key}" missing from en.json`);
for (const key of Object.keys(en)) if (!(key in ar)) fail.push(`i18n: "${key}" missing from ar.json`);

// The language switcher legitimately names the other language in its own script.
const ALLOW_ARABIC_IN_ENGLISH = new Set(['common.language']);
for (const [key, value] of Object.entries(en)) {
  if (typeof value === 'string' && /[؀-ۿ]/.test(value) && !ALLOW_ARABIC_IN_ENGLISH.has(key)) {
    fail.push(`i18n: en.json "${key}" still contains Arabic — ${value}`);
  }
}

const used = new Set();
for (const file of sources) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/\bt\(\s*'([A-Za-z][\w.]*)'/g)) used.add(m[1]);
}
for (const key of used) {
  if (!(key in ar) && !(key in en)) fail.push(`i18n: t('${key}') is used but defined nowhere`);
}

// ── report ───────────────────────────────────────────────────────────────────
if (fail.length) {
  console.error(`✗ ${fail.length} problem(s):`);
  for (const f of fail) console.error(`   ${f}`);
  process.exit(1);
}
console.log(
  `✓ ${routes.length} routes, ${links.size} internal links, ` +
    `${Object.keys(ar).length} translation keys — all consistent`,
);
