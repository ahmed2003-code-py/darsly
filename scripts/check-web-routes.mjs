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
import { fileURLToPath } from 'node:url';

// fileURLToPath, not .pathname: on Windows .pathname yields '/D:/…' (and %20 for spaces), which join() mangles.
const WEB = fileURLToPath(new URL('../apps/web/', import.meta.url));
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

// Plural forms are one key with a suffix per form, and the forms differ by
// language: Arabic has six (zero, one, two, few, many, other), English two.
// A key written with only `_one`/`_other` in Arabic works for 1 and fails for
// 12 — Arabic's 12 is "many" — and the reader sees the raw key. That shipped
// once ("drafts.removedAll" after clearing twelve drafts), so a plural key must
// carry every form its language uses, and is not compared form-by-form across
// languages.
const PLURAL = /_(zero|one|two|few|many|other)$/;
const FORMS = { ar: ['zero', 'one', 'two', 'few', 'many', 'other'], en: ['one', 'other'] };
const pluralBases = (dict) =>
  new Set(
    Object.keys(dict)
      .filter((k) => PLURAL.test(k))
      .map((k) => k.replace(PLURAL, '')),
  );
const arPlural = pluralBases(ar);
const enPlural = pluralBases(en);
for (const [lang, dict, bases] of [
  ['ar', ar, new Set([...arPlural, ...enPlural])],
  ['en', en, new Set([...arPlural, ...enPlural])],
]) {
  for (const base of bases) {
    const missing = FORMS[lang].filter((f) => !(`${base}_${f}` in dict));
    if (missing.length)
      fail.push(`i18n: ${lang}.json plural "${base}" is missing form(s) ${missing.join(', ')}`);
  }
}
/** Defined as a plain key, or as a plural whose base this is. */
const defined = (dict, key) => key in dict || `${key}_other` in dict;

for (const key of Object.keys(ar))
  if (!PLURAL.test(key) && !(key in en)) fail.push(`i18n: "${key}" missing from en.json`);
for (const key of Object.keys(en))
  if (!PLURAL.test(key) && !(key in ar)) fail.push(`i18n: "${key}" missing from ar.json`);

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
  if (!defined(ar, key) && !defined(en, key))
    fail.push(`i18n: t('${key}') is used but defined nowhere`);
}

// A key does not have to sit inside `t(` to be a key.
//
// `t(kind === 'PAPER' ? 'studio.modePaper' : 'studio.modeContent')` shipped to
// production and drew the literal words "studio.modePaper" as a page title,
// because the check above only ever looked at the character after `t(`. The
// rename that orphaned those three strings passed every gate we had.
//
// So every string literal that *looks* like a key into a namespace we actually
// have is checked, wherever it appears. A namespace nobody defined is ignored
// — that is a filename or a MIME type, not a key — which keeps this specific
// about the failure it exists to catch.
const namespaces = new Set(Object.keys(ar).map((k) => k.split('.')[0]));
// Real strings that collide with the shape: a namespace, a dot, a word.
const NOT_KEYS = new Set(['common.js', 'common.css']);
for (const file of sources) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/'([a-z][A-Za-z0-9]*(?:\.[A-Za-z][\w]*)+)'/g)) {
    const key = m[1];
    if (NOT_KEYS.has(key)) continue;
    if (!namespaces.has(key.split('.')[0])) continue;
    if (defined(ar, key) || defined(en, key)) continue;
    // A prefix of real keys is a template base (`paper.type.` + a variable).
    if (Object.keys(ar).some((k) => k.startsWith(`${key}.`))) continue;
    fail.push(
      `i18n: "${key}" reads like a translation key and is defined nowhere (${file.replace(WEB, '')})`,
    );
  }
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
