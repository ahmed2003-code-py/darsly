import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * C5 OWNS ONLY FOLLOW-UP CASES AND CONTACT HISTORY.
 *
 * Who needs follow-up is derived from the truth other phases own — C1's
 * register, C2's attendance, C3's cards, C4's fees, the Guardian domain — and
 * C5 must never write any of it, never read C4's tables except through
 * CenterFeesService, and never touch platform money. This spec keeps that true
 * in the code itself, so no later change can quietly turn a signal into an
 * attendance or money write.
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

/** Models other phases own — C5 may read some of them, never write any. */
const OTHERS =
  'academyStudent|studentProfile|user|groupMembership|group|groupSession|attendanceSession|attendanceRecord|academyStudentCard|guardian|guardianLink|guardianAccessToken|centerFeePlan|centerCharge|centerAdjustment|centerCollection|centerAllocation|centerReceiptCounter';
const WRITE = new RegExp(
  `\\.(${OTHERS})\\.(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\\b|\\b(INSERT INTO|UPDATE|DELETE FROM) "(AcademyStudent|StudentProfile|User|GroupMembership|Group|GroupSession|AttendanceSession|AttendanceRecord|AcademyStudentCard|Guardian|GuardianLink|GuardianAccessToken|Center\\w+)"`,
);
const C4_MODELS =
  /\.(centerFeePlan|centerCharge|centerAdjustment|centerCollection|centerAllocation|centerReceiptCounter)\b|"Center(FeePlan|Charge|Adjustment|Collection|Allocation|ReceiptCounter|ChargeBalance)"/;
const PLATFORM =
  /\.(payment|paymentEvent|ledgerTransaction|ledgerEntry|walletTransaction|walletTopup|payoutRequest|livePurchase|commercialTerms)\b|"(Payment|PaymentEvent|LedgerTransaction|LedgerEntry|WalletTransaction|WalletTopup|PayoutRequest|LivePurchase|CommercialTerms)"|from '\.\.\/(payments|wallet|payouts|live\/commerce)/;

describe('C5 boundary', () => {
  const mine = files(join(SRC, 'follow-up'));
  const offenders = (re: RegExp) =>
    mine.flatMap((f) =>
      lines(f)
        .filter(({ line }) => re.test(line))
        .map(({ line, i }) => `${relative(SRC, f)}:${i + 1}: ${line.trim()}`),
    );

  it('follow-up writes nothing other phases own (register, groups, classes, attendance, cards, guardians, fees)', () => {
    expect(offenders(WRITE)).toEqual([]);
  });

  it('follow-up reads fees only through CenterFeesService', () => {
    expect(offenders(C4_MODELS)).toEqual([]);
  });

  it('follow-up never touches platform money', () => {
    expect(offenders(PLATFORM)).toEqual([]);
  });

  it('nothing outside follow-up writes a follow-up case or contact', () => {
    const out = files(SRC)
      .filter((f) => !relative(SRC, f).startsWith('follow-up'))
      .flatMap((f) =>
        lines(f)
          .filter(({ line }) =>
            /\.(studentFollowUp|studentContact|academyFollowUpSettings)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/.test(
              line,
            ),
          )
          .map(({ line, i }) => `${relative(SRC, f)}:${i + 1}: ${line.trim()}`),
      );
    expect(out).toEqual([]);
  });
});
