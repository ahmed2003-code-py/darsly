#!/usr/bin/env node
/**
 * C7 mutation run: break one day-operations rule at a time, run the C7 specs,
 * restore the file byte for byte (and prove it), and report which breakages
 * the tests caught. A survivor is reported as one — never rounded up. The
 * migration is mutated too (test databases are built from the migrations).
 * Never run other API tests while this runs: they compile the same files.
 *
 * Usage: node scripts/e2e/daily-mutate.cjs [M1,M5,…]   (needs the local test database)
 */
const { readFileSync, writeFileSync } = require('fs');
const { spawnSync } = require('child_process');
const { join } = require('path');

const API = join(__dirname, '..', '..', 'apps', 'api');
const SVC = 'src/daily-ops/daily-ops.service.ts';
const MIG = 'prisma/migrations/20261106100000_daily_operations/migration.sql';
const PERM = 'src/academy/permissions.ts';
const FEES = 'src/center-fees/center-fees.service.ts';

const MUTANTS = [
  [
    'M1',
    'a cancelled class counts in attendance',
    SVC,
    `const live = rows.filter((r) => r.status !== 'CANCELLED');`,
    `const live = rows;`,
  ],
  [
    'M2',
    'makeup visitors count as own learners marked (unmarked too low)',
    SVC,
    `r.present + r.late + r.absent + r.excused - r.makeup`,
    `r.present + r.late + r.absent + r.excused`,
  ],
  [
    'M3',
    'a manual record counts as a desk check-in',
    SVC,
    `count(r.id) FILTER (WHERE r.method IN ('QR', 'CODE'))::int AS "checkIns"`,
    `count(r.id)::int AS "checkIns"`,
  ],
  [
    'M4',
    'reversals counted by the day the money came in, not the day reversed',
    FEES,
    `AND "reversedAt" >= (\${s}::timestamptz AT TIME ZONE 'UTC') AND "reversedAt" < (\${e}::timestamptz AT TIME ZONE 'UTC')`,
    `AND "reversedAt" IS NOT NULL AND "receivedAt" >= (\${s}::timestamptz AT TIME ZONE 'UTC') AND "receivedAt" < (\${e}::timestamptz AT TIME ZONE 'UTC')`,
  ],
  [
    'M5',
    'net ignores reversals',
    FEES,
    `netCents: received.amountCents - reversedToday.amountCents,`,
    `netCents: received.amountCents,`,
  ],
  [
    'M6',
    'an ended class with open attendance is not an exception',
    SVC,
    `      else if (!r.closed)\n`,
    `      else if (false)\n`,
  ],
  [
    'M7',
    'closing with exceptions needs no note',
    SVC,
    `if (report.exceptions.length && !dto.exceptionNote?.trim())`,
    `if (false)`,
  ],
  [
    'M8',
    're-closing needs no reason (silently overwrites the meaning of the day)',
    SVC,
    `if (last && !dto.reason?.trim())`,
    `if (false)`,
  ],
  ['M9', 'a future day can be closed', SVC, `if (dto.date > clock.today)`, `if (false)`],
  [
    'M10',
    'a repeated close request makes a second close',
    SVC,
    `    if (prior) return this.replay(prior, dto.date);\n`,
    `\n`,
  ],
  [
    'M11',
    'no lock: concurrent closes race',
    SVC,
    '          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ctx.academyId}), hashtext(${dto.date}))`;\n',
    ``,
  ],
  [
    'M12',
    'money shown to a daily.view holder without fees.report',
    SVC,
    `collections: ctx.can('fees.report') ? f.collections : null,`,
    `collections: f.collections,`,
  ],
  [
    'M13',
    'exam totals shown to a group-scoped member',
    SVC,
    `ctx.can('grades.view') && (ctx.role === 'OWNER' || ctx.isPlatformAdmin) ? f.exams : null,`,
    `ctx.can('grades.view') ? f.exams : null,`,
  ],
  [
    'M14',
    'drift compares raw JSON (JSONB key order = false drift)',
    SVC,
    `      return canon(rest);\n`,
    `      return JSON.stringify(rest);\n`,
  ],
  [
    'M15',
    'the close note goes into the audit log',
    SVC,
    `        exceptions: (row.exceptions as unknown[]).length,
`,
    `        exceptions: (row.exceptions as unknown[]).length,
        note: dto.exceptionNote,
`,
  ],
  [
    'M16',
    'DB: a close can be edited',
    MIG,
    `BEFORE UPDATE OR DELETE ON "CenterDayClose"`,
    `BEFORE TRUNCATE ON "CenterDayClose"`,
  ],
  [
    'M17',
    'DB: versions may skip',
    MIG,
    `IF NEW."version" <> COALESCE(`,
    `IF FALSE AND NEW."version" <> COALESCE(`,
  ],
  [
    'M18',
    'teachers get daily.view by default',
    PERM,
    `    'grades.view',\n    'grades.manage',\n  ],`,
    `    'grades.view',\n    'grades.manage',\n    'daily.view',\n  ],`,
  ],
  [
    'M19',
    'daily-ops writes attendance',
    SVC,
    `  async clock(academyId: string) {\n`,
    `  async clock(academyId: string) {\n    await this.prisma.attendanceRecord.updateMany({ where: { id: '__none__' }, data: {} });\n`,
  ],
];

// Every mutant site must be original before starting: a run killed mid-mutant
// leaves its file mutated, and anything compiled from it then lies. Never run
// other API tests while this runs — they compile the same files.
for (const [id, , file, find] of MUTANTS) {
  const n = readFileSync(join(API, file), 'utf8').replace(/\r\n/g, '\n').split(find).length - 1;
  if (n !== 1)
    throw new Error(`${id}: ${file} is not original (pattern found ${n}×) — restore it first`);
}
let pending = null; // [path, original bytes] while a mutant is applied
const restore = () => {
  if (pending) writeFileSync(pending[0], pending[1]);
  pending = null;
};
process.on('exit', restore);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(sig, () => {
    restore();
    process.exit(130);
  });

const only = process.argv[2] ? new Set(process.argv[2].split(',')) : null;
const results = [];
for (const [id, desc, file, find, replace] of MUTANTS) {
  if (only && !only.has(id)) continue;
  const path = join(API, file);
  const original = readFileSync(path);
  const text = original.toString('utf8').replace(/\r\n/g, '\n');
  const crlf = original.includes('\r\n');
  const hits = text.split(find).length - 1;
  if (hits !== 1) {
    results.push(`SKIPPED  ${id} ${desc} (pattern found ${hits}×)`);
    console.log(results.at(-1));
    continue;
  }
  const mutated = text.replace(find, () => replace);
  pending = [path, original];
  writeFileSync(path, crlf ? mutated.replace(/\n/g, '\r\n') : mutated);
  const run = spawnSync('npx', ['jest', 'src/daily-ops', '--silent'], {
    cwd: API,
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, C7_SCALE: '0' },
  });
  restore();
  if (!readFileSync(path).equals(original)) throw new Error(`${file} NOT restored after ${id}`);
  const caught = run.status !== 0;
  const failed = (run.stdout + run.stderr).match(/✕ .+/g)?.slice(0, 2).join(' / ') ?? '';
  results.push(
    `${caught ? 'CAUGHT  ' : 'SURVIVED'} ${id} ${desc}${caught && failed ? `  ← ${failed}` : ''}`,
  );
  console.log(results.at(-1));
}
const caught = results.filter((r) => r.startsWith('CAUGHT')).length;
const ran = results.filter((r) => !r.startsWith('SKIPPED')).length;
const total = only ? only.size : MUTANTS.length;
console.log(`\n${caught}/${ran} mutations caught${ran < total ? ` (${total - ran} skipped)` : ''}`);
writeFileSync(
  join(require('os').tmpdir(), 'darsly-daily-mutations.txt'),
  results.join('\n') + `\n${caught}/${ran}\n`,
);
