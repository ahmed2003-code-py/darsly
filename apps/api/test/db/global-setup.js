/**
 * One database per Jest worker.
 *
 * The integration specs used to share a single database — locally, the dev
 * database itself. Under the default worker count (cores - 1) they collided:
 * a spec counting the whole ledger table saw another spec's entries, a
 * platform-wide account balance moved under it, serializable wallet writes
 * conflicted across unrelated suites (P2034). Every failure passed when the
 * suite ran alone. Sharing, not the code under test, was the fault.
 *
 * So: migrate a template database once per run, then give every worker its
 * own copy (CREATE DATABASE … TEMPLATE is a file copy — milliseconds).
 * `worker-db.js` points each worker's DATABASE_URL at its copy.
 *
 * No database reachable at DATABASE_URL → nothing is created and the specs
 * skip themselves, as before — unless REQUIRE_TEST_DB=1 (CI), where an
 * unreachable database is a failure, not a quiet skip.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const quote = (name) => `"${name.replace(/"/g, '""')}"`;

module.exports = async function globalSetup(globalConfig) {
  // Prisma reads apps/api/.env on its own when DATABASE_URL is unset — which
  // is how every spec silently landed in the dev database. Take DATABASE_URL
  // (and only it: that file also holds real provider keys no test should
  // inherit) so the URL is explicit and every worker gets its own copy below.
  // A value already in the environment wins (CI sets its own).
  if (!process.env.DATABASE_URL) {
    const file = path.resolve(__dirname, '../../.env');
    if (fs.existsSync(file)) {
      const fromFile = require('dotenv').parse(fs.readFileSync(file)).DATABASE_URL;
      if (fromFile) process.env.DATABASE_URL = fromFile;
    }
  }
  const base = process.env.DATABASE_URL;
  const required = process.env.REQUIRE_TEST_DB === '1';
  if (!base) {
    if (required) throw new Error('REQUIRE_TEST_DB=1 but DATABASE_URL is not set');
    return;
  }
  const url = new URL(base);
  const baseDb = decodeURIComponent(url.pathname.slice(1)) || 'postgres';
  const admin = new URL(base);
  admin.pathname = '/postgres';
  admin.search = '';

  const prisma = new PrismaClient({ datasources: { db: { url: admin.toString() } } });
  try {
    await prisma.$queryRawUnsafe('SELECT 1');
  } catch (e) {
    await prisma.$disconnect().catch(() => undefined);
    if (required) throw new Error(`REQUIRE_TEST_DB=1 but no database is reachable: ${e.message}`);
    console.warn('\n[test-db] no database reachable at DATABASE_URL — integration specs will skip');
    return;
  }

  const prefix = `${baseDb}_test`;
  const template = `${prefix}_tpl`;
  const workers = Math.max(1, globalConfig.maxWorkers || 1);
  const started = Date.now();
  try {
    await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${quote(template)} WITH (FORCE)`);
    await prisma.$executeRawUnsafe(`CREATE DATABASE ${quote(template)}`);
    const tplUrl = new URL(base);
    tplUrl.pathname = `/${template}`;
    // The same migrations production runs, in the same order — not `db push`.
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, DATABASE_URL: tplUrl.toString() },
      stdio: 'pipe',
      // npx is a .cmd shim on Windows: it only runs through the shell.
      shell: process.platform === 'win32',
    });
    for (let i = 1; i <= workers; i++) {
      const db = `${prefix}_w${i}`;
      await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${quote(db)} WITH (FORCE)`);
      await prisma.$executeRawUnsafe(`CREATE DATABASE ${quote(db)} TEMPLATE ${quote(template)}`);
    }
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
  // Workers are forked after this and inherit it; worker-db.js reads it.
  process.env.DARSLY_TEST_DB_PREFIX = prefix;
  console.log(
    `\n[test-db] ${workers} isolated database(s) from ${template} in ${Date.now() - started} ms`,
  );
};
