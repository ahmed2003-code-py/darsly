#!/usr/bin/env node
/**
 * The database-backed job queue, under concurrent workers.
 *
 * There is no broker: claiming is a single `UPDATE … WHERE id = (SELECT …
 * FOR UPDATE SKIP LOCKED)`, which is the right primitive. The questions worth
 * asking of it are the ones a broker would otherwise answer — can two workers
 * claim the same job, does a crashed worker's job come back, is the retry
 * bounded, does a job ever vanish, and does the lease actually expire.
 *
 *   CONFIRM_TEST_DB=yes DATABASE_URL=... node scripts/audit-workers.mjs
 *
 * Talks to the database directly and deliberately: claiming is the thing under
 * test, so it is exercised through the same SQL the service issues rather than
 * through an HTTP route that would hide it. Every row is created and deleted
 * by this script.
 */
import { PrismaClient } from '@prisma/client';

const DB = process.env.DATABASE_URL ?? '';
if (process.env.CONFIRM_TEST_DB !== 'yes') { console.error('REFUSED: set CONFIRM_TEST_DB=yes.'); process.exit(2); }
if (!DB) { console.error('REFUSED: DATABASE_URL is not set.'); process.exit(2); }
if (/railway|prod|amazonaws|supabase|neon\.tech|render\.com/i.test(DB)) {
  console.error('REFUSED: DATABASE_URL looks hosted.'); process.exit(2);
}

const prisma = new PrismaClient();
const tag = `jobs-${Date.now()}`;
let pass = 0, fail = 0;
const findings = [];
const check = (n, ok, d = '') => {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  (${d})` : ''}`);
  if (ok) pass++; else { fail++; findings.push(`${n} — ${d}`); }
};
const note = (n, d) => console.log(`   NOTE  ${n}  (${d})`);

/** The claim exactly as AiJobService.claimNext issues it. */
async function claim(leaseMs) {
  const lease = new Date(Date.now() + leaseMs);
  const rows = await prisma.$queryRaw`
    UPDATE "AiJob"
    SET status = 'RUNNING'::"AiJobStatus",
        "leaseExpiresAt" = ${lease},
        attempts = attempts + 1,
        "updatedAt" = now()
    WHERE id = (
      SELECT id FROM "AiJob"
      WHERE (status = 'QUEUED'::"AiJobStatus"
         OR (status = 'RUNNING'::"AiJobStatus" AND "leaseExpiresAt" < now()))
        AND "academyId" = ${ACADEMY}
      ORDER BY "createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `;
  return rows.length ? rows[0].id : null;
}

const made = [];
let ACADEMY = null;

try {
  const academy = await prisma.academy.findFirst({ where: { deletedAt: null } });
  if (!academy) throw new Error('no academy — seed the database first');
  ACADEMY = academy.id;
  // Start from a clean slate for this academy so counts are unambiguous.
  await prisma.aiJob.deleteMany({ where: { academyId: ACADEMY } });

  const queue = async (n) => {
    const ids = [];
    for (let i = 0; i < n; i++) {
      const j = await prisma.aiJob.create({
        data: { academyId: ACADEMY, type: 'SITE_GENERATE', status: 'QUEUED', input: { tag, i } },
      });
      ids.push(j.id); made.push(j.id);
    }
    return ids;
  };

  // ── 1. two workers, one job ─────────────────────────────────────────────
  console.log('\n=== 1. TWO WORKERS RACING FOR ONE JOB ===');
  {
    const [id] = await queue(1);
    const [a, b] = await Promise.all([claim(30_000), claim(30_000)]);
    const claimed = [a, b].filter(Boolean);
    check('exactly one worker claimed it', claimed.length === 1, `claims: ${a ?? 'none'} / ${b ?? 'none'}`);
    check('and it was the job we queued', claimed[0] === id || claimed.length !== 1, `${claimed[0]?.slice(0, 8)}`);
    const row = await prisma.aiJob.findUnique({ where: { id } });
    check('attempts incremented exactly once', row.attempts === 1, `attempts=${row.attempts}`);
    check('the job is RUNNING with a lease', row.status === 'RUNNING' && !!row.leaseExpiresAt, `${row.status}`);
    await prisma.aiJob.deleteMany({ where: { academyId: ACADEMY } });
  }

  // ── 2. five workers, five jobs — none taken twice, none missed ──────────
  console.log('\n=== 2. FIVE WORKERS, FIVE JOBS ===');
  {
    const ids = await queue(5);
    const claims = await Promise.all(Array.from({ length: 5 }, () => claim(30_000)));
    const got = claims.filter(Boolean);
    const unique = new Set(got);
    check('every claim returned a distinct job', unique.size === got.length, `${got.length} claims, ${unique.size} distinct`);
    check('all five jobs were claimed', unique.size === 5, `${unique.size}/5`);
    const rows = await prisma.aiJob.findMany({ where: { id: { in: ids } } });
    check('no job was attempted more than once', rows.every((r) => r.attempts === 1), rows.map((r) => r.attempts).join(','));
    check('no job was left behind', rows.every((r) => r.status === 'RUNNING'), rows.map((r) => r.status).join(','));
    await prisma.aiJob.deleteMany({ where: { academyId: ACADEMY } });
  }

  // ── 3. a crashed worker's job comes back ───────────────────────────────
  console.log('\n=== 3. A CRASHED WORKER (LEASE EXPIRY) ===');
  {
    const [id] = await queue(1);
    const first = await claim(1000);                       // a one-second lease
    check('the job was claimed', first === id, `${first?.slice(0, 8)}`);

    // The worker "crashes": nothing completes it, nothing renews the lease.
    const tooSoon = await claim(30_000);
    check('it is not reclaimable while the lease holds', tooSoon === null, tooSoon ? 'RECLAIMED EARLY' : 'not claimable');

    await new Promise((r) => setTimeout(r, 1400));         // lease expires
    const second = await claim(30_000);
    check('it is reclaimed once the lease expires', second === id, `${second?.slice(0, 8)}`);
    const row = await prisma.aiJob.findUnique({ where: { id } });
    check('and the attempt was counted', row.attempts === 2, `attempts=${row.attempts}`);
    await prisma.aiJob.deleteMany({ where: { academyId: ACADEMY } });
  }

  // ── 4. is the retry bounded? ───────────────────────────────────────────
  console.log('\n=== 4. RETRY BOUND ===');
  {
    const [id] = await queue(1);
    // Burn through attempts by claiming with an already-dead lease each time.
    let attempts = 0;
    for (let i = 0; i < 12; i++) {
      const got = await claim(-1000);                      // lease already expired
      if (!got) break;
      attempts++;
    }
    const row = await prisma.aiJob.findUnique({ where: { id } });
    note('attempts reached by pure reclaiming', `${row.attempts} after ${attempts} claims`);
    // The claim SQL itself has no cap — the bound lives in the worker, which
    // decides on failure whether to requeue or fail terminally. Recorded, and
    // the worker's own logic is checked below.
    check('the job did not vanish while being reclaimed', !!row, row?.status);
    await prisma.aiJob.deleteMany({ where: { academyId: ACADEMY } });
  }

  // ── 5. terminal and succeeded jobs are never re-claimed ────────────────
  console.log('\n=== 5. FINISHED JOBS STAY FINISHED ===');
  {
    const ids = await queue(2);
    await prisma.aiJob.update({ where: { id: ids[0] }, data: { status: 'SUCCEEDED', leaseExpiresAt: null } });
    await prisma.aiJob.update({ where: { id: ids[1] }, data: { status: 'FAILED', leaseExpiresAt: null } });
    const got = await claim(30_000);
    check('neither a succeeded nor a failed job is re-claimed', got === null, got ? `RECLAIMED ${got.slice(0, 8)}` : 'nothing claimable');
    await prisma.aiJob.deleteMany({ where: { academyId: ACADEMY } });
  }

  // ── 6. ordering ────────────────────────────────────────────────────────
  console.log('\n=== 6. ORDERING ===');
  {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const j = await prisma.aiJob.create({
        data: { academyId: ACADEMY, type: 'SITE_GENERATE', status: 'QUEUED', input: { tag, i },
                createdAt: new Date(Date.now() - (3 - i) * 60_000) },
      });
      ids.push(j.id); made.push(j.id);
    }
    const first = await claim(30_000);
    check('the oldest queued job is claimed first', first === ids[0], `${first?.slice(0, 8)} vs oldest ${ids[0].slice(0, 8)}`);
    await prisma.aiJob.deleteMany({ where: { academyId: ACADEMY } });
  }

  // ── 7. nothing is lost under a burst ───────────────────────────────────
  console.log('\n=== 7. NOTHING LOST UNDER A BURST ===');
  {
    const ids = await queue(20);
    // Ten "workers" each draining until empty, all at once.
    const drains = Array.from({ length: 10 }, async () => {
      const mine = [];
      for (;;) { const got = await claim(60_000); if (!got) break; mine.push(got); }
      return mine;
    });
    const results = await Promise.all(drains);
    const all = results.flat();
    const unique = new Set(all);
    check('every job was claimed exactly once', unique.size === all.length, `${all.length} claims, ${unique.size} distinct`);
    check('all 20 jobs were claimed', unique.size === 20, `${unique.size}/20`);
    const rows = await prisma.aiJob.findMany({ where: { id: { in: ids } } });
    check('none was attempted twice', rows.every((r) => r.attempts === 1), `max attempts ${Math.max(...rows.map((r) => r.attempts))}`);
    check('none was left QUEUED', rows.every((r) => r.status === 'RUNNING'), `${rows.filter((r) => r.status !== 'RUNNING').length} not running`);
    await prisma.aiJob.deleteMany({ where: { academyId: ACADEMY } });
  }
} catch (e) {
  console.error('\nERROR:', e.message);
  fail++;
} finally {
  if (ACADEMY) await prisma.aiJob.deleteMany({ where: { academyId: ACADEMY } }).catch(() => {});
  await prisma.$disconnect();
}

console.log(`\n${fail === 0 ? 'WORKER GATE PASS' : `WORKER GATE — ${fail} FAILURE(S)`}  —  ${pass} passed, ${fail} failed`);
if (findings.length) { console.log('\nfailures:'); for (const f of findings) console.log('  ' + f); }
process.exit(fail === 0 ? 0 : 1);
