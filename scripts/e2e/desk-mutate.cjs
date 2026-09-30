#!/usr/bin/env node
/**
 * C3 mutation run: break one guard at a time, run the desk specs, restore
 * the file byte for byte (and prove it), and report which breakages the
 * tests caught. A survivor is reported as one — never rounded up.
 *
 * Usage: node scripts/e2e/desk-mutate.cjs   (needs the local test database)
 */
const { readFileSync, writeFileSync } = require('fs');
const { spawnSync } = require('child_process');
const { join } = require('path');

const API = join(__dirname, '..', '..', 'apps', 'api');
const f = (p) => join(API, 'src', p);
const DESK = 'desk/desk.service.ts';
const ATT = 'class-ops/class-attendance.service.ts';

const MUTANTS = [
  [
    'M1',
    'academy scoping removed from card lookup',
    DESK,
    'if (!card || card.academyId !== ctx.academyId) {',
    'if (!card) {',
  ],
  ['M2', 'revoked card accepted', DESK, 'if (card.revokedAt) {', 'if (false) {'],
  [
    'M3',
    'raw token persisted instead of its hash',
    DESK,
    "tokenHash: hashCardToken(token),\n          issuedBy: ctx.userId,\n        },\n        select: { id: true, issuedAt: true },\n      });\n    });\n    await this.audit.log({\n      actorUserId: ctx.userId,\n      action: 'card.issue',",
    "tokenHash: token,\n          issuedBy: ctx.userId,\n        },\n        select: { id: true, issuedAt: true },\n      });\n    });\n    await this.audit.log({\n      actorUserId: ctx.userId,\n      action: 'card.issue',",
  ],
  [
    'M4',
    'client checkedInAt accepted by the check-in DTO',
    'desk/dto.ts',
    '@IsOptional() @IsId() makeupForSessionId?: string;',
    '@IsOptional() @IsId() makeupForSessionId?: string;\n  @IsOptional() @IsString() checkedInAt?: string;',
  ],
  [
    'M5',
    'makeup capacity bypassed',
    ATT,
    'if (group.capacity != null) {',
    'if (group.capacity != null && false) {',
  ],
  [
    'M6',
    'withdrawn learner accepted at the desk',
    ATT,
    "      if (record.status !== 'ACTIVE')\n        throw new ConflictException({\n          message: 'This student has withdrawn; reactivate them first',\n          code: 'STUDENT_WITHDRAWN',\n        });\n      const open =",
    '      const open =',
  ],
  [
    'M7',
    'desk resolve guarded by the register capability instead of desk.checkin',
    'desk/desk.controller.ts',
    "@AcademyStaffFeature('desk.checkin', 'receptionDesk')\n  @ApiOperation({ summary: '[academy] Who this is",
    "@AcademyStaffFeature('student.directory', 'receptionDesk')\n  @ApiOperation({ summary: '[academy] Who this is",
  ],
  [
    'M8',
    'issue ignores an existing active card',
    DESK,
    "      if (active)\n        throw new ConflictException({\n          message: 'This student already has a card — reissue to replace it',",
    "      if (active && false)\n        throw new ConflictException({\n          message: 'This student already has a card — reissue to replace it',",
  ],
  [
    'M9',
    'reissue leaves the old card active',
    DESK,
    "data: { revokedAt: now, revokedBy: ctx.userId, revokeReason: dto.reason ?? 'REISSUED' },",
    "data: { revokeReason: dto.reason ?? 'REISSUED' },",
  ],
  [
    'M10',
    'ambiguous class auto-selected (first open class wins)',
    DESK,
    ': openHome.length === 1',
    ': openHome.length >= 1',
  ],
  [
    'M11',
    'closed attendance not refused at the desk',
    ATT,
    'if (open?.closedAt)\n',
    'if (open?.closedAt && false)\n',
  ],
  [
    'M12',
    'raw token written to the log',
    DESK,
    '      const token = normalizeDeskInput(dto.token);',
    '      const token = normalizeDeskInput(dto.token);\n      this.logger.log(`desk scan ${token}`);',
  ],
  [
    'M13',
    'check-in does not re-check the card under lock (revoke race)',
    ATT,
    'if (input.cardId) {',
    'if (input.cardId && false) {',
  ],
  [
    'M14',
    'method not derived from the identifier (always MANUAL)',
    DESK,
    'method: who.method,',
    "method: 'MANUAL',",
  ],
];

const results = [];
for (const [id, desc, file, find, replace] of MUTANTS) {
  const path = f(file);
  const original = readFileSync(path);
  const text = original.toString('utf8').replace(/\r\n/g, '\n');
  const crlf = original.includes('\r\n');
  const hits = text.split(find).length - 1;
  if (hits !== 1) {
    results.push(`SKIPPED  ${id} ${desc} (pattern found ${hits}×)`);
    continue;
  }
  const mutated = text.replace(find, replace);
  writeFileSync(path, crlf ? mutated.replace(/\n/g, '\r\n') : mutated);
  const run = spawnSync('npx', ['jest', 'src/desk', '--silent'], {
    cwd: API,
    shell: true,
    encoding: 'utf8',
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
  join(require('os').tmpdir(), 'darsly-desk-mutations.txt'),
  results.join('\n') + `\n${caught}/${ran}\n`,
);
