import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * C7 OWNS ONLY THE DAY CLOSES.
 *
 * The day's figures are read from C2–C6; nothing in daily-ops may write a
 * class, an attendance record, a card, a charge, a collection, a case, an
 * exam — or any platform money — and nothing outside daily-ops may write a
 * close. Closing a day therefore cannot change, block or "fix" anything.
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
const WRITE =
  /\.(\w+)\.(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\b|\b(INSERT INTO|UPDATE|DELETE FROM)\s+"(\w+)"/;
const PLATFORM =
  /\.(payment|paymentEvent|ledgerTransaction|ledgerEntry|walletTransaction|walletTopup|payoutRequest|livePurchase|commercialTerms)\b|"(Payment|PaymentEvent|LedgerTransaction|LedgerEntry|WalletTransaction|WalletTopup|PayoutRequest|LivePurchase|CommercialTerms)"|from '\.\.\/(payments|wallet|payouts|live\/commerce)/;

describe('C7 boundary', () => {
  const mine = files(join(SRC, 'daily-ops'));

  it('daily-ops writes nothing but its own closes', () => {
    const writes = offenders(WRITE, mine).filter((l) => !/\.centerDayClose\.create\b/.test(l));
    expect(writes).toEqual([]);
  });

  it('daily-ops never touches platform money', () => {
    expect(offenders(PLATFORM, mine)).toEqual([]);
  });

  it('nothing outside daily-ops writes a day close', () => {
    const others = files(SRC).filter((f) => !relative(SRC, f).startsWith('daily-ops'));
    expect(
      offenders(
        /\.centerDayClose\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b|\b(INSERT INTO|UPDATE|DELETE FROM) "CenterDayClose"/,
        others,
      ),
    ).toEqual([]);
  });
});
