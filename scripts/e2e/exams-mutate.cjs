#!/usr/bin/env node
/**
 * C6 mutation run: break one paper-exam rule at a time, run the paper-exam
 * specs, restore the file byte for byte (and prove it), and report which
 * breakages the tests caught. A survivor is reported as one — never rounded up.
 *
 * The migration is mutated too: the test databases are built from the
 * migrations on every run, so a weakened database rule is really in force.
 *
 * Usage: node scripts/e2e/exams-mutate.cjs [M1,M5,…]   (needs the local test database)
 */
const { readFileSync, writeFileSync } = require('fs');
const { spawnSync } = require('child_process');
const { join } = require('path');

const API = join(__dirname, '..', '..', 'apps', 'api');
const READ = 'src/paper-exams/grades-read.service.ts';
const SVC = 'src/paper-exams/paper-exams.service.ts';
const SIG = 'src/follow-up/signals.service.ts';
const PERM = 'src/academy/permissions.ts';
const MIG = 'prisma/migrations/20261105100000_paper_exams/migration.sql';

const MUTANTS = [
  // ── The historical roster ──
  [
    'M1',
    'roster: a learner withdrawn before the exam is on it',
    READ,
    `        AND (s.status = 'ACTIVE' OR s."leftAt" > (\${start.toISOString()}::timestamptz AT TIME ZONE 'UTC'))\``,
    '`',
  ],
  [
    'M2',
    "roster: today's group instead of the exam date's (a learner moved since is dropped)",
    READ,
    `AND (m."deletedAt" IS NULL OR m."deletedAt" > (\${start.toISOString()}::timestamptz AT TIME ZONE 'UTC'))`,
    'AND m."deletedAt" IS NULL',
  ],
  [
    'M3',
    'roster: a learner who joined after the exam is on it',
    READ,
    `        AND m."addedAt" < (\${end.toISOString()}::timestamptz AT TIME ZONE 'UTC')\n`,
    '',
  ],
  // ── Statistics ──
  [
    'M4',
    'statistics: ABSENT counts as 0 in the average',
    READ,
    `round(avg(r.score) FILTER (WHERE r.status = 'SCORED'))::int AS average`,
    `round(avg(coalesce(r.score, 0)))::int AS average`,
  ],
  [
    'M5',
    'statistics: reaching the pass mark exactly is not a pass',
    READ,
    `r.score >= e."passScore"`,
    `r.score > e."passScore"`,
  ],
  [
    'M6',
    'statistics: the lowest ignores a 0',
    READ,
    `min(r.score) FILTER (WHERE r.status = 'SCORED')::int AS lowest`,
    `min(nullif(r.score, 0)) FILTER (WHERE r.status = 'SCORED')::int AS lowest`,
  ],
  // ── LOW_GRADE ──
  [
    'M7',
    'LOW_GRADE: a draft exam raises it',
    READ,
    `AND o.kind = 'REGULAR' AND o.status = 'PUBLISHED'`,
    `AND o.kind = 'REGULAR'`,
  ],
  [
    'M8',
    'LOW_GRADE: the makeup is not the effective result',
    READ,
    `COALESCE(mk.score, CASE WHEN r.status = 'SCORED' THEN r.score END) AS score`,
    `CASE WHEN r.status = 'SCORED' THEN r.score END AS score`,
  ],
  ['M9', 'LOW_GRADE: an unpublished makeup counts', READ, ` AND me.status = 'PUBLISHED'\n`, `\n`],
  [
    'M10',
    'LOW_GRADE: exactly the pass mark is low',
    READ,
    `eff.score < eff.pass)`,
    `eff.score <= eff.pass)`,
  ],
  [
    'M11',
    'LOW_GRADE: exactly the threshold is low',
    READ,
    `eff.score::bigint * 100 < \${lowGradePercent}`,
    `eff.score::bigint * 100 <= \${lowGradePercent}`,
  ],
  [
    'M12',
    'LOW_GRADE: a withdrawn learner raises it',
    READ,
    `JOIN "AcademyStudent" s ON s.id = eff."academyStudentId" AND s.status = 'ACTIVE'`,
    `JOIN "AcademyStudent" s ON s.id = eff."academyStudentId"`,
  ],
  [
    'M13',
    'LOW_GRADE: Reception (no grades.view) gets grade signals',
    SIG,
    `if (!ctx.can('grades.view')) return undefined;`,
    `if (false) return undefined;`,
  ],
  [
    'M14',
    'LOW_GRADE: still raised with the flag off',
    READ,
    `    if (!(await this.flags.isEnabled(academyId, 'paperExams'))) return [];\n    const { lowGradePercent }`,
    `    const { lowGradePercent }`,
  ],
  // ── Reach, guardians ──
  [
    'M15',
    'a teacher reaches every group',
    READ,
    `if (ctx.role === 'OWNER' || ctx.isPlatformAdmin) return null;`,
    `return null;`,
  ],
  [
    'M16',
    'guardians see grades without the academy choosing to',
    READ,
    `    if (!(await this.settings(academyId)).guardianGradesVisible) return null;\n`,
    '',
  ],
  [
    'M17',
    'a learner history (and the guardian) shows unpublished exams',
    READ,
    `        AND e.status = 'PUBLISHED'\n        \${reach`,
    `        \${reach`,
  ],
  [
    'M18',
    'teachers get grades.correct by default',
    PERM,
    `    'grades.view',\n    'grades.manage',\n  ],`,
    `    'grades.view',\n    'grades.manage',\n    'grades.correct',\n  ],`,
  ],
  // ── Saving, publishing, correcting ──
  [
    'M19',
    'a repeated save request is applied twice',
    SVC,
    `if (done) return { replayed: true, saved: 0, conflicts: [] };`,
    `if (false && done) return { replayed: true, saved: 0, conflicts: [] };`,
  ],
  [
    'M20',
    'a stale save overwrites silently (no version check)',
    SVC,
    `if ((cur?.version ?? null) !== (r.version ?? null)) {`,
    `if (false) {`,
  ],
  [
    'M21',
    'publication with learners still ungraded',
    SVC,
    `        if (missing.length)\n`,
    `        if (false && missing.length)\n`,
  ],
  [
    'M22',
    'publication with a result for someone off the roster',
    SVC,
    `        if (illegal.length)\n`,
    `        if (false && illegal.length)\n`,
  ],
  [
    'M23',
    'a stale correction overwrites silently',
    SVC,
    `if (cur.version !== dto.version)`,
    `if (false)`,
  ],
  [
    'M24',
    'the correction reason is not kept',
    SVC,
    `            reason: dto.reason.trim(),\n`,
    `            reason: 'n/a',\n`,
  ],
  [
    'M25',
    'the correction reason goes into the audit log',
    SVC,
    `{ academyStudentId, toStatus: res.status }`,
    `{ academyStudentId, toStatus: res.status, reason: dto.reason }`,
  ],
  [
    'M26',
    'a makeup is offered to learners who sat the exam',
    SVC,
    `r.status IN ('ABSENT', 'EXCUSED')`,
    `r.status IN ('ABSENT', 'EXCUSED', 'SCORED')`,
  ],
  [
    'M27',
    'a makeup is offered to learners who already have one',
    SVC,
    `WHERE o."makeupKey" = r."examId" AND`,
    `WHERE FALSE AND o."makeupKey" = r."examId" AND`,
  ],
  [
    'M28',
    'an original is voided while its makeup lives',
    SVC,
    `makeupOfExamId: id, status: { not: 'VOID' } }`,
    `makeupOfExamId: '__none__', status: { not: 'VOID' } }`,
  ],
  [
    'M29',
    'the CSV formula guard is gone',
    SVC,
    "      if (/^[=+\\-@\\t\\r]/.test(t)) t = `'${t}`;\n",
    '',
  ],
  [
    'M30',
    'paper exams write attendance',
    SVC,
    `  async exportCsv(ctx: AcademyContext, id: string) {\n`,
    `  async exportCsv(ctx: AcademyContext, id: string) {\n    await this.prisma.attendanceRecord.updateMany({ where: { id: '__none__' }, data: {} });\n`,
  ],
  // ── The database ──
  [
    'M31',
    'DB: revisions can be edited',
    MIG,
    `CREATE TRIGGER "PaperExamRevision_append_only" BEFORE UPDATE OR DELETE ON "PaperExamRevision"`,
    `CREATE TRIGGER "PaperExamRevision_append_only" BEFORE TRUNCATE ON "PaperExamRevision"`,
  ],
  [
    'M32',
    'DB: a score above the maximum is stored',
    MIG,
    `IF NEW."score" IS NOT NULL AND NEW."score" > e."maxScore" THEN`,
    `IF FALSE THEN`,
  ],
  [
    'M33',
    'DB: a published result can be deleted',
    MIG,
    `IF (SELECT "status" FROM "PaperExam" WHERE id = OLD."examId") <> 'DRAFT' THEN`,
    `IF FALSE THEN`,
  ],
  [
    'M34',
    'DB: two effective makeups for one learner',
    MIG,
    `CREATE UNIQUE INDEX "PaperExamResult_one_effective_makeup"`,
    `CREATE INDEX "PaperExamResult_one_effective_makeup"`,
  ],
  [
    'M35',
    'DB: voiding a makeup does not free the slot',
    MIG,
    `UPDATE "PaperExamResult" SET "makeupKey" = NULL WHERE "examId" = NEW.id AND "makeupKey" IS NOT NULL;`,
    `NULL;`,
  ],
  [
    'M36',
    'DB: a published exam can be re-dated',
    MIG,
    `IF OLD."status" = 'PUBLISHED' AND (NEW."groupId" <> OLD."groupId" OR NEW."examDate" <> OLD."examDate"`,
    `IF OLD."status" = 'PUBLISHED' AND (NEW."groupId" <> OLD."groupId"`,
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
  const run = spawnSync('npx', ['jest', 'src/paper-exams', '--silent'], {
    cwd: API,
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, C6_SCALE: '0' },
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
  join(require('os').tmpdir(), 'darsly-exams-mutations.txt'),
  results.join('\n') + `\n${caught}/${ran}\n`,
);
