import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * C8 OWNS ONLY ITS TEACHER BOOKS — what the CENTER owes and pays its TEACHERS.
 *
 * Three kinds of money never meet: platform money (Payment, Ledger*, Wallet*,
 * PayoutRequest, LivePurchase, CommercialTerms), what students owe the center
 * (C4's Center* tables — read only through CenterFeesService), and what the
 * center owes its teachers (C8). Nothing in teacher-settlement may write
 * anything but its own tables, and nothing outside may write them.
 */
const SRC = join(__dirname, '..');
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(join(dir, e.name))
      : /\.ts$/.test(e.name) && !/\.spec\.ts$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );
const lines = (f: string) =>
  readFileSync(f, 'utf8')
    .split('\n')
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => !line.trim().startsWith('*') && !line.trim().startsWith('//'));
const offenders = (re: RegExp, set: string[]) =>
  set.flatMap((f) =>
    lines(f)
      .filter(({ line }) => re.test(line))
      .map(({ line, i }) => `${relative(SRC, f)}:${i + 1}: ${line.trim()}`),
  );
const OWN =
  /\.(teacherAgreement|teacherSettlement|teacherSettlementLine|teacherSettlementAdjustment|teacherSettlementPayment)\./;
const WRITE =
  /\.(\w+)\.(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\(|\b(INSERT INTO|UPDATE|DELETE FROM)\s+"(\w+)"/;
const PLATFORM =
  /\.(payment|paymentEvent|ledgerTransaction|ledgerEntry|walletTransaction|walletTopup|payoutRequest|livePurchase|commercialTerms)\b|"(Payment|PaymentEvent|LedgerTransaction|LedgerEntry|WalletTransaction|WalletTopup|PayoutRequest|LivePurchase|CommercialTerms)"|from '\.\.\/(payments|wallet|payouts|live\/commerce)/;
const C4 =
  /\.(centerFeePlan|centerCharge|centerAdjustment|centerCollection|centerAllocation|centerReceiptCounter)\b|"Center(FeePlan|Charge|Adjustment|Collection|Allocation|ReceiptCounter)"/;

describe('C8 boundary', () => {
  const mine = files(join(SRC, 'teacher-settlement'));

  it('teacher-settlement writes only its own books', () => {
    expect(offenders(WRITE, mine).filter((l) => !OWN.test(l))).toEqual([]);
  });

  it('teacher-settlement never touches platform money (no payout, no wallet, no ledger)', () => {
    expect(offenders(PLATFORM, mine)).toEqual([]);
  });

  it("teacher-settlement reads the students' fee books only through CenterFeesService", () => {
    expect(offenders(C4, mine)).toEqual([]);
  });

  it('nothing outside teacher-settlement writes the teacher books', () => {
    const others = files(SRC).filter((f) => !relative(SRC, f).startsWith('teacher-settlement'));
    expect(
      offenders(
        /\.(teacherAgreement|teacherSettlement|teacherSettlementLine|teacherSettlementAdjustment|teacherSettlementPayment)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b|\b(INSERT INTO|UPDATE|DELETE FROM) "Teacher(Agreement|Settlement\w*)"/,
        others,
      ),
    ).toEqual([]);
  });
});
