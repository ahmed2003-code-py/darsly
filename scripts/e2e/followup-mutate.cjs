#!/usr/bin/env node
/**
 * C5 mutation run: break one follow-up rule at a time, run the follow-up
 * specs, restore the file byte for byte (and prove it), and report which
 * breakages the tests caught. A survivor is reported as one — never rounded up.
 *
 * The migration is mutated too: the test databases are built from the
 * migrations on every run, so a weakened database rule is really in force.
 *
 * Usage: node scripts/e2e/followup-mutate.cjs [M1,M5,…]   (needs the local test database)
 */
const { readFileSync, writeFileSync } = require('fs');
const { spawnSync } = require('child_process');
const { join } = require('path');

const API = join(__dirname, '..', '..', 'apps', 'api');
const SIG = 'src/follow-up/signals.service.ts';
const SVC = 'src/follow-up/follow-up.service.ts';
const TL = 'src/follow-up/timeline.service.ts';
const GF = 'src/follow-up/guardian-fees.view.ts';
const CTRL = 'src/follow-up/follow-up.controller.ts';
const PERM = 'src/academy/permissions.ts';
const MIG = 'prisma/migrations/20261104100000_student_follow_up/migration.sql';

const MUTANTS = [
  [
    'M1',
    'an EXCUSED absence breaks/counts in a streak',
    SIG,
    `AND r."deletedAt" IS NULL AND r."homeGroupId" IS NULL AND r.status <> 'EXCUSED'`,
    `AND r."deletedAt" IS NULL AND r."homeGroupId" IS NULL`,
  ],
  [
    'M2',
    'an absence a makeup covered still counts',
    SIG,
    `(r.status = 'ABSENT' AND NOT (gs.id IS NOT NULL AND EXISTS (`,
    `(r.status = 'ABSENT' AND NOT (FALSE AND EXISTS (`,
  ],
  [
    'M3',
    "a guest's visit counts in the host group's streak",
    SIG,
    `AND r."deletedAt" IS NULL AND r."homeGroupId" IS NULL AND r.status <> 'EXCUSED'`,
    `AND r."deletedAt" IS NULL AND r.status <> 'EXCUSED'`,
  ],
  [
    'M4',
    'cancelled classes count in a streak',
    SIG,
    `AND sh.date >= \${since}::date AND (gs.id IS NULL OR gs.status <> 'CANCELLED')`,
    `AND sh.date >= \${since}::date`,
  ],
  [
    'M5',
    'withdrawn learners raise streak signals',
    SIG,
    `            AND s.status = 'ACTIVE' \${one}\n        ), ranked AS (`,
    `            \${one}\n        ), ranked AS (`,
  ],
  [
    'M6',
    'a case opens for a signal that is not raised',
    SVC,
    'if (!signals.some((x) => x.reason === dto.reason && x.signalKey === signalKey))',
    'if (false && !signals.some((x) => x.reason === dto.reason && x.signalKey === signalKey))',
  ],
  [
    'M7',
    'a request key is not replayed (double click = two cases)',
    SVC,
    '      if (byKey) {',
    '      if (byKey && false) {',
  ],
  [
    'M8',
    'closing is not a compare-and-set on OPEN',
    SVC,
    "    const res = await this.prisma.studentFollowUp.updateMany({\n      where: { id, academyId: ctx.academyId, status: 'OPEN' },\n      data: { status, closedAt",
    '    const res = await this.prisma.studentFollowUp.updateMany({\n      where: { id, academyId: ctx.academyId },\n      data: { status, closedAt',
  ],
  [
    'M9',
    "another learner's guardian accepted for a contact",
    SVC,
    "            studentId: s.studentId,\n            status: 'ACTIVE',\n          },\n          select: { id: true },",
    "            status: 'ACTIVE',\n          },\n          select: { id: true },",
  ],
  [
    'M10',
    'the contact note goes into the audit log',
    SVC,
    '          followUpId: row.followUpId,\n        },',
    '          followUpId: row.followUpId,\n          note: row.note,\n        },',
  ],
  [
    'M11',
    'fee events in the timeline without fees.view',
    TL,
    "      ctx.can('fees.view') && (await this.flags.isEnabled(ctx.academyId, 'centerFees'));",
    "      await this.flags.isEnabled(ctx.academyId, 'centerFees');",
  ],
  [
    'M12',
    "guardians see fees without the academy's choice",
    GF,
    '    if (!(await this.settings.get(academyId)).guardianFeesVisible) return null;\n',
    '',
  ],
  [
    'M13',
    'teachers hold follow-up by default',
    PERM,
    "    'payment.view',\n  ],\n  // An assistant holds exactly what the owner granted them",
    "    'payment.view',\n    'followup.view',\n  ],\n  // An assistant holds exactly what the owner granted them",
  ],
  [
    'M14',
    'Reception may change the settings',
    CTRL,
    "@AcademyStaffFeature('academy.manage', 'studentFollowUp')",
    "@AcademyStaffFeature('followup.manage', 'studentFollowUp')",
  ],
  [
    'M15',
    'database lets a contact be edited',
    MIG,
    'CREATE TRIGGER "StudentContact_no_update" BEFORE UPDATE ON "StudentContact"\n  FOR EACH ROW EXECUTE FUNCTION followup_contact_no_update();',
    '',
  ],
  [
    'M16',
    'database lets a case cross academies',
    MIG,
    '  IF s_academy IS DISTINCT FROM NEW."academyId" THEN',
    '  IF FALSE THEN',
  ],
  [
    'M17',
    'follow-up writes attendance',
    SIG,
    '    const out: Signal[] = [];',
    "    const out: Signal[] = [];\n    await this.prisma.attendanceRecord.updateMany({ where: { id: '__none__' }, data: {} });",
  ],
];

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
  const mutated = text.replace(find, replace);
  writeFileSync(path, crlf ? mutated.replace(/\n/g, '\r\n') : mutated);
  const run = spawnSync('npx', ['jest', 'src/follow-up', '--silent'], {
    cwd: API,
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, C5_SCALE: '0' },
  });
  writeFileSync(path, original);
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
  join(require('os').tmpdir(), 'darsly-followup-mutations.txt'),
  results.join('\n') + `\n${caught}/${ran}\n`,
);
