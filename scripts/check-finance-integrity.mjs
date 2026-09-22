#!/usr/bin/env node
/**
 * Read-only integrity report for finance (Architecture Reset, Phase 7):
 * payment scope, cash lifecycle, ledger balance, double-settlement, payout
 * scope. Complements check-scope-integrity (Course/Enrollment/Payment
 * academyId consistency) — it does not repeat those checks. Reports; never
 * modifies. Exit 1 on anomalies, 0 when clean.
 *
 *   DATABASE_URL=postgresql://... node scripts/check-finance-integrity.mjs
 */
import { PrismaClient } from '@prisma/client';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const prisma = new PrismaClient();
const findings = [];
const report = (kind, rows) => {
  if (!rows.length) return;
  findings.push(kind);
  console.log(`\n${kind} (${rows.length})`);
  for (const r of rows.slice(0, 25)) console.log('   ' + JSON.stringify(r, (_, v) => (typeof v === 'bigint' ? Number(v) : v)));
};

// ── Payment scope ──
report('Payment whose academyId is neither its own tenantId nor a real Academy', await prisma.$queryRaw`
  SELECT p.id, p."academyId", p."tenantId" FROM "Payment" p LEFT JOIN "Academy" a ON a.id = p."academyId"
  WHERE p."academyId" IS NOT NULL AND a.id IS NULL`);
report('CENTER payment (organisation is a Center) with no revenue split configured at settlement time yet marked PAID', await prisma.$queryRaw`
  SELECT p.id FROM "Payment" p JOIN "Academy" a ON a.id = COALESCE(p."academyId", p."tenantId") AND a.kind = 'CENTER'
  WHERE p.status = 'PAID' AND p."amountCents" > 0 AND a."teacherSharePercent" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "AcademyMembership" m JOIN "TeacherProfile" tp ON tp.id = p."tenantId" WHERE m."userId" = tp."userId" AND m."academyId" = a.id AND m."revenueSharePercent" IS NOT NULL)`);

// ── Cash lifecycle ──
report('CASH payment with no cashOrigin (should be set by every cash-creating path)', await prisma.$queryRaw`
  SELECT id FROM "Payment" WHERE method = 'CASH' AND "cashOrigin" IS NULL AND "deletedAt" IS NULL`);
report('CASH payment PAID with no confirmer recorded (verifiedById)', await prisma.$queryRaw`
  SELECT id FROM "Payment" WHERE method = 'CASH' AND status = 'PAID' AND "verifiedById" IS NULL`);
report('CASH payment PAID but not settled (cash confirmation must settle in the same step)', await prisma.$queryRaw`
  SELECT id FROM "Payment" WHERE method = 'CASH' AND status = 'PAID' AND "settledAt" IS NULL`);
report('CASH payment with cashReceiver CENTER on a PERSONAL organisation (invalid combination)', await prisma.$queryRaw`
  SELECT p.id, p."academyId" FROM "Payment" p JOIN "Academy" a ON a.id = COALESCE(p."academyId", p."tenantId")
  WHERE p.method = 'CASH' AND p."cashReceiver" = 'CENTER' AND a.kind = 'PERSONAL'`);
report('TEACHER_RECORDED or CENTER_RECORDED cash with no recordedByUserId', await prisma.$queryRaw`
  SELECT id, "cashOrigin" FROM "Payment" WHERE method = 'CASH' AND "cashOrigin" IN ('TEACHER_RECORDED', 'CENTER_RECORDED') AND "recordedByUserId" IS NULL`);

// ── Settlement / ledger consistency ──
report('PAID + settled Payment with no LedgerTransaction (money moved with nothing booked)', await prisma.$queryRaw`
  SELECT p.id FROM "Payment" p LEFT JOIN "LedgerTransaction" t ON t."paymentId" = p.id
  WHERE p.status = 'PAID' AND p."settledAt" IS NOT NULL AND t.id IS NULL`);
report('Payment with more than one LedgerTransaction (duplicate settlement)', await prisma.$queryRaw`
  SELECT "paymentId", COUNT(*) AS n FROM "LedgerTransaction" WHERE "paymentId" IS NOT NULL GROUP BY "paymentId" HAVING COUNT(*) > 1`);
report('PayoutRequest with more than one LedgerTransaction (duplicate payout settlement)', await prisma.$queryRaw`
  SELECT "payoutId", COUNT(*) AS n FROM "LedgerTransaction" WHERE "payoutId" IS NOT NULL GROUP BY "payoutId" HAVING COUNT(*) > 1`);
report('LedgerTransaction whose entries do not balance (Σdebit ≠ Σcredit)', await prisma.$queryRaw`
  SELECT "transactionId", SUM(CASE WHEN direction = 'DEBIT' THEN "amountCents" ELSE 0 END) AS debit,
         SUM(CASE WHEN direction = 'CREDIT' THEN "amountCents" ELSE 0 END) AS credit
  FROM "LedgerEntry" WHERE "deletedAt" IS NULL GROUP BY "transactionId"
  HAVING SUM(CASE WHEN direction = 'DEBIT' THEN "amountCents" ELSE 0 END) <> SUM(CASE WHEN direction = 'CREDIT' THEN "amountCents" ELSE 0 END)`);
report('LedgerEntry on a teacher:/academy: account with no academyId (Phase 7 backfill gap)', await prisma.$queryRaw`
  SELECT id, account FROM "LedgerEntry" WHERE (account LIKE 'teacher:%' OR account LIKE 'academy:%') AND "academyId" IS NULL AND "deletedAt" IS NULL`);
report('Ledger credit on a Center/teacher balance whose academyId disagrees with the account it names', await prisma.$queryRaw`
  SELECT id, account, "academyId" FROM "LedgerEntry"
  WHERE account LIKE 'academy:%' AND "deletedAt" IS NULL AND account <> ('academy:' || "academyId" || ':balance')`);

// ── Payouts: scope and balance ──
report('PayoutRequest whose academyId is not a real Academy', await prisma.$queryRaw`
  SELECT pr.id, pr."academyId" FROM "PayoutRequest" pr LEFT JOIN "Academy" a ON a.id = pr."academyId" WHERE pr."academyId" IS NOT NULL AND a.id IS NULL`);
report('PayoutMethodSaved on a CENTER with a non-null tenantId (should be organisation-owned, not author-owned)', await prisma.$queryRaw`
  SELECT pm.id FROM "PayoutMethodSaved" pm JOIN "Academy" a ON a.id = pm."academyId" WHERE a.kind = 'CENTER' AND pm."tenantId" IS NOT NULL`);

// COMPLETED payouts whose account balance (at the time, approximated by lifetime ledger) never dipped negative beyond what a payout should leave —
// full historical reconstruction is out of scope for a point-in-time check; instead assert every completed payout has its debit entry.
report('COMPLETED PayoutRequest with no matching ledger debit on its account', await prisma.$queryRaw`
  SELECT pr.id FROM "PayoutRequest" pr
  WHERE pr.status = 'COMPLETED' AND NOT EXISTS (
    SELECT 1 FROM "LedgerEntry" le JOIN "LedgerTransaction" lt ON lt.id = le."transactionId"
    WHERE lt."payoutId" = pr.id AND le.direction = 'DEBIT' AND le."amountCents" = pr."amountCents")`);

// ── Cash-accounting-review correction (see revenue-split.ts / ledger.service.ts):
// a :balance account is payout-eligible EARNINGS and must only ever be
// credited — cash collection no longer debits it. A negative :balance is
// therefore now a real anomaly (something debited earnings outside the
// known payout path). What a cash receiver still owes lives on its own
// :cash-liability account, which is EXPECTED to sit negative until a future
// remittance flow credits it — reported for visibility, not a failure.
report('Payout-eligible :balance account gone negative (should only ever be credited by sales, debited only by a matching payout)', await prisma.$queryRaw`
  SELECT account, SUM(CASE WHEN direction = 'CREDIT' THEN "amountCents" ELSE -"amountCents" END) AS balance
  FROM "LedgerEntry" WHERE "deletedAt" IS NULL AND (account LIKE 'teacher:%:balance' OR account LIKE 'academy:%:balance')
  GROUP BY account HAVING SUM(CASE WHEN direction = 'CREDIT' THEN "amountCents" ELSE -"amountCents" END) < 0`);

const cashLiabilities = await prisma.$queryRaw`
  SELECT account, -SUM(CASE WHEN direction = 'CREDIT' THEN "amountCents" ELSE -"amountCents" END) AS "owedCents"
  FROM "LedgerEntry" WHERE "deletedAt" IS NULL AND account LIKE '%:cash-liability'
  GROUP BY account HAVING SUM(CASE WHEN direction = 'CREDIT' THEN "amountCents" ELSE -"amountCents" END) < 0`;
if (cashLiabilities.length) {
  console.log(`\nOutstanding cash obligations (${cashLiabilities.length}) — expected: unremitted cash still owed, not an anomaly by itself:`);
  for (const r of cashLiabilities.slice(0, 25)) console.log('   ' + JSON.stringify(r, (_, v) => (typeof v === 'bigint' ? Number(v) : v)));
}
report(':cash-liability account sitting net-positive (would mean more was remitted than was ever collected)', await prisma.$queryRaw`
  SELECT account, SUM(CASE WHEN direction = 'CREDIT' THEN "amountCents" ELSE -"amountCents" END) AS balance
  FROM "LedgerEntry" WHERE "deletedAt" IS NULL AND account LIKE '%:cash-liability'
  GROUP BY account HAVING SUM(CASE WHEN direction = 'CREDIT' THEN "amountCents" ELSE -"amountCents" END) > 0`);

await prisma.$disconnect();
if (findings.length) { console.log(`\n${findings.length} anomaly kind(s).`); process.exit(1); }
console.log('\nFinance integrity: clean.');
