#!/usr/bin/env node
/**
 * C4 mutation run: break one money guard at a time, run the center-fees specs,
 * restore the file byte for byte (and prove it), and report which breakages
 * the tests caught. A survivor is reported as one — never rounded up.
 *
 * The migration is mutated too: the test databases are built from the
 * migrations on every run, so a weakened database rule is really in force.
 *
 * Usage: node scripts/e2e/fees-mutate.cjs   (needs the local test database)
 */
const { readFileSync, writeFileSync } = require('fs');
const { spawnSync } = require('child_process');
const { join } = require('path');

const API = join(__dirname, '..', '..', 'apps', 'api');
const SVC = 'src/center-fees/center-fees.service.ts';
const PLANS = 'src/center-fees/fee-plans.service.ts';
const CTRL = 'src/center-fees/center-fees.controller.ts';
const DTO = 'src/center-fees/dto.ts';
const MIG = 'prisma/migrations/20261103100000_center_fees/migration.sql';
const PERM = 'src/academy/permissions.ts';

const MUTANTS = [
  [
    'M1',
    'center money touches platform money (a ledger read in collect)',
    SVC,
    '      await this.lockStudent(tx, ctx.academyId, s.id);\n      const prior = await tx.centerCollection',
    '      await this.lockStudent(tx, ctx.academyId, s.id);\n      await tx.ledgerEntry.count();\n      const prior = await tx.centerCollection',
  ],
  [
    'M2',
    'academy scope dropped when finding the learner',
    SVC,
    'where: { id: academyStudentId, academyId: ctx.academyId },\n      select: { id: true, fullName: true, code: true, status: true, studentId: true },',
    'where: { id: academyStudentId },\n      select: { id: true, fullName: true, code: true, status: true, studentId: true },',
  ],
  [
    'M3',
    'idempotency skipped (no replay of a request key)',
    SVC,
    '      if (prior) {\n        if (\n          prior.academyStudentId',
    '      if (prior && false) {\n        if (\n          prior.academyStudentId',
  ],
  [
    'M4',
    'overpayment allowed (leftover ignored)',
    SVC,
    '      if (leftoverCents > 0)',
    '      if (leftoverCents > 0 && false)',
  ],
  [
    'M5',
    'receipt number from count + 1 (no atomic counter)',
    SVC,
    'INSERT INTO "CenterReceiptCounter" ("academyId", year, last) VALUES (${ctx.academyId}, ${year}, 1)\n        ON CONFLICT ("academyId", year) DO UPDATE SET last = "CenterReceiptCounter".last + 1\n        RETURNING last',
    'SELECT (count(*) + 1)::int AS last FROM "CenterCollection" WHERE "academyId" = ${ctx.academyId}',
  ],
  [
    'M6',
    'client-supplied collector accepted by the DTO',
    DTO,
    '  @IsOptional() @IsString() @MaxLength(200) note?: string;',
    '  @IsOptional() @IsString() @MaxLength(200) note?: string;\n  @IsOptional() @IsString() receivedBy?: string;',
  ],
  [
    'M7',
    'negative amounts accepted',
    DTO,
    "  @IsInt() @Min(1) @Max(MAX_CENTS) amountCents: number;\n  @IsIn(['CASH',",
    "  @IsInt() @Min(-MAX_CENTS) @Max(MAX_CENTS) amountCents: number;\n  @IsIn(['CASH',",
  ],
  [
    'M8',
    'a reversal hard-deletes the collection',
    SVC,
    '      await tx.centerCollection.update({\n        where: { id: k.id },\n        data: { reversedAt: now, reversedBy: ctx.userId, reversalReason: reason.trim() },\n      });',
    '      void now;\n      await tx.centerAllocation.deleteMany({ where: { collectionId: k.id } });\n      await tx.centerCollection.delete({ where: { id: k.id } });',
  ],
  [
    'M9',
    'a plan price change rewrites posted charges',
    PLANS,
    "    await this.audit.log({\n      actorUserId: ctx.userId,\n      action: dto.status === 'ARCHIVED' ? 'fees.plan.archive' : 'fees.plan.update',",
    "    if (dto.amountCents != null)\n      await this.prisma.centerCharge.updateMany({ where: { planId: plan.id }, data: { amountCents: dto.amountCents } });\n    await this.audit.log({\n      actorUserId: ctx.userId,\n      action: dto.status === 'ARCHIVED' ? 'fees.plan.archive' : 'fees.plan.update',",
  ],
  [
    'M10',
    'Reception may discount (adjust guarded by fees.collect)',
    CTRL,
    "  @Post('charges/:id/adjustments')\n  @AcademyStaffFeature('fees.adjust', 'centerFees')",
    "  @Post('charges/:id/adjustments')\n  @AcademyStaffFeature('fees.collect', 'centerFees')",
  ],
  [
    'M11',
    'teachers see fees by default',
    PERM,
    "    'guardian.manage',\n    'payment.view',\n  ],\n  // An assistant holds",
    "    'guardian.manage',\n    'payment.view',\n    'fees.view',\n    'fees.collect',\n  ],\n  // An assistant holds",
  ],
  [
    'M12',
    'overdue boundary: due today counted overdue',
    'src/center-fees/money.ts',
    "  if (b.dueOn < today) return 'OVERDUE';",
    "  if (b.dueOn <= today) return 'OVERDUE';",
  ],
  [
    'M13',
    'monthly generation not idempotent (no skipDuplicates)',
    PLANS,
    '      data: rows.map((r) => this.monthlyRow(plan, r.id, period, anchor)),\n      skipDuplicates: true,',
    '      data: rows.map((r) => this.monthlyRow(plan, r.id, period, anchor)),',
  ],
  [
    'M14',
    'a reversed collection still counts as paid (balance view)',
    MIG,
    '    WHERE al."chargeId" = c.id AND k."reversedAt" IS NULL) p;',
    '    WHERE al."chargeId" = c.id) p;',
  ],
  [
    'M15',
    'database lets a discount go below what was paid',
    MIG,
    '  IF center_charge_net(c.id) < 0 OR center_charge_net(c.id) < center_charge_paid(c.id) THEN',
    '  IF center_charge_net(c.id) < -100000000 THEN',
  ],
];

const results = [];
for (const [id, desc, file, find, replace] of MUTANTS) {
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
  const run = spawnSync('npx', ['jest', 'src/center-fees', '--silent'], {
    cwd: API,
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, C4_SCALE: '0' },
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
console.log(
  `\n${caught}/${ran} mutations caught${ran < MUTANTS.length ? ` (${MUTANTS.length - ran} skipped)` : ''}`,
);
writeFileSync(
  join(require('os').tmpdir(), 'darsly-fees-mutations.txt'),
  results.join('\n') + `\n${caught}/${ran}\n`,
);
