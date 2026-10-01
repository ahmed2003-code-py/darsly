import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * CENTER MONEY IS NOT PLATFORM MONEY.
 *
 * Darsly's platform money — a Payment for a course or a Live seat, the
 * double-entry ledger, wallets, payouts, Live purchases, commercial terms —
 * is money Darsly processes, holds or earns a fee on. A center's tuition for
 * its own physical classes is not: Darsly is not a party to it. This spec
 * keeps the two apart in the code itself, so no refactor can quietly route
 * one into the other:
 *
 *  1. nothing in center-fees/ reads or writes a platform money model, or
 *     imports from the payments / wallet / payouts / live-commerce code;
 *  2. nothing outside center-fees/ touches a center-fees model.
 *
 * (The database keeps them apart too: no foreign key in either direction.)
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

const PLATFORM =
  /\.(payment|paymentEvent|paymentMethodConfig|ledgerTransaction|ledgerEntry|walletTransaction|walletTopup|payoutRequest|livePurchase|commercialTerms|coupon)\b|"(Payment|PaymentEvent|LedgerTransaction|LedgerEntry|WalletTransaction|WalletTopup|PayoutRequest|LivePurchase|CommercialTerms)"|from '\.\.\/(payments|wallet|payouts|live\/commerce|ledger)/;
const CENTER =
  /\.(centerFeePlan|centerCharge|centerAdjustment|centerCollection|centerAllocation|centerReceiptCounter)\b|"Center(FeePlan|Charge|Adjustment|Collection|Allocation|ReceiptCounter|ChargeBalance)"/;

describe('center money / platform money boundary', () => {
  it('center-fees never touches platform money', () => {
    const offenders = files(join(SRC, 'center-fees')).flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .map((line, i) => ({ line, i }))
        .filter(
          ({ line }) =>
            PLATFORM.test(line) && !line.trim().startsWith('*') && !line.trim().startsWith('//'),
        )
        .map(({ line, i }) => `${relative(SRC, f)}:${i + 1}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it('platform code never touches center money', () => {
    const offenders = files(SRC)
      .filter((f) => !relative(SRC, f).startsWith('center-fees'))
      .flatMap((f) =>
        readFileSync(f, 'utf8')
          .split('\n')
          .map((line, i) => ({ line, i }))
          .filter(({ line }) => CENTER.test(line))
          .map(({ line, i }) => `${relative(SRC, f)}:${i + 1}: ${line.trim()}`),
      );
    expect(offenders).toEqual([]);
  });
});
