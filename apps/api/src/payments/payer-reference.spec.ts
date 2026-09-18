import { normalizePayerReference, referenceKindFor, referenceRequiredFor } from './payer-reference';

/**
 * What the student has to tell us about their transfer.
 *
 * This is the only link between the money that arrived and the person who owes
 * it. It used to be an optional free-text box labelled "TXN / 010…", which
 * meant a student could submit a payment with nothing to match it to — and
 * every one of those reached an admin looking exactly like a real one.
 */
describe('which identifier each method can actually be matched on', () => {
  it('asks a wallet payer for their number', () => {
    // A Vodafone Cash SMS carries no transaction id at all. What it does carry
    // is the sending wallet: «تم استلام مبلغ 10.00 جنيه من 01284120292».
    expect(referenceKindFor('VODAFONE_CASH')).toBe('WALLET_NUMBER');
  });

  it('asks a bank or InstaPay payer for the reference', () => {
    // A bank SMS carries «برقم مرجعي 05b6efa4» and no phone number.
    expect(referenceKindFor('INSTAPAY')).toBe('TRANSACTION_REFERENCE');
    expect(referenceKindFor('BANK_TRANSFER')).toBe('TRANSACTION_REFERENCE');
  });
});

describe('a wallet number', () => {
  it('is stored as the bare local number, however it was typed', () => {
    // The SMS prints one spelling and the student types another, so all of
    // these have to arrive at the one number the message will carry. The
    // last is the same number with its leading zero left off, which is a
    // thing people do and not a different wallet.
    for (const typed of [
      '01284120292', '+201284120292', '201284120292',
      '0128 412 0292', '0128-412-0292', '1284120292',
    ]) {
      expect(normalizePayerReference('VODAFONE_CASH', typed)).toBe('01284120292');
    }
  });

  it('is refused when it could not be an Egyptian wallet', () => {
    for (const bad of [
      '0123456',      // too short to be a number at all
      '09984120292',  // not one of the four live prefixes
      '12345678901',  // right length, wrong shape
      '0100258992',   // one digit short of a real one
    ]) {
      expect(() => normalizePayerReference('VODAFONE_CASH', bad)).toThrow();
    }
  });

  it('names what is wrong, so the student can fix it themselves', () => {
    const err: any = (() => { try { normalizePayerReference('VODAFONE_CASH', '0123'); } catch (e) { return e; } })();
    expect(err.getResponse()).toMatchObject({ code: 'BAD_WALLET_NUMBER', kind: 'WALLET_NUMBER' });
  });
});

describe('a transfer reference', () => {
  it('is kept exactly as the bank wrote it', () => {
    // Not ours to reshape — only the whitespace around it is.
    expect(normalizePayerReference('INSTAPAY', '  05b6efa4 ')).toBe('05b6efa4');
    expect(normalizePayerReference('BANK_TRANSFER', 'f9cbbce8')).toBe('f9cbbce8');
    expect(normalizePayerReference('INSTAPAY', '023683598446')).toBe('023683598446');
  });

  it('is refused when there is too little of it to identify one transfer', () => {
    expect(() => normalizePayerReference('INSTAPAY', 'ab')).toThrow();
    expect(() => normalizePayerReference('INSTAPAY', '--')).toThrow();
  });
});

describe('leaving it out', () => {
  it('is refused for Vodafone Cash, which really does share one', () => {
    const kindOf = (method: string) => {
      try { normalizePayerReference(method, ''); } catch (e: any) { return e.getResponse(); }
    };
    expect(kindOf('VODAFONE_CASH')).toMatchObject({ code: 'REFERENCE_REQUIRED', kind: 'WALLET_NUMBER' });
    expect(kindOf('VODAFONE_CASH')).toMatchObject({ message: expect.stringContaining('wallet number') });
  });

  it('treats whitespace as leaving it out', () => {
    expect(() => normalizePayerReference('VODAFONE_CASH', '   ')).toThrow();
  });

  /**
   * The rule this file used to enforce, and why it is gone.
   *
   * There is no reference an InstaPay sender and an InstaPay receiver both see:
   * the student's receipt says «المرجع 770916345902» and the bank's SMS says
   * «برقم مرجعي 3979e788». Demanding one meant demanding something that could
   * never match, so every such transfer went to a human — and students typed
   * whatever let the form submit, most often our own number off the screen in
   * front of them. The receipt identifies these instead (proof-check.ts).
   */
  it('is accepted as empty on a rail with no shared reference', () => {
    expect(normalizePayerReference('INSTAPAY', '')).toBe('');
    expect(normalizePayerReference('INSTAPAY', '   ')).toBe('');
    expect(normalizePayerReference('BANK_TRANSFER', undefined)).toBe('');
  });

  it('still checks a reference the student did supply', () => {
    expect(normalizePayerReference('INSTAPAY', '770916345902')).toBe('770916345902');
    expect(() => normalizePayerReference('INSTAPAY', 'ab')).toThrow();
  });

  /**
   * Seen in production: the number printed on the "transfer to" card is the one
   * that gets copied into "which number did you transfer from". It can never
   * match — the SMS parser deliberately drops the receiving number from a
   * message's identities — so the top-up would have sat in manual review.
   */
  it('refuses our own receiving number as the sender', () => {
    const ours = ['01002589923'];
    try {
      normalizePayerReference('VODAFONE_CASH', '01002589923', ours);
      throw new Error('should have refused');
    } catch (e: any) {
      expect(e.getResponse()).toMatchObject({ code: 'OWN_NUMBER', kind: 'WALLET_NUMBER' });
    }
    // Same number, spelled with a country code, is still ours.
    expect(() => normalizePayerReference('VODAFONE_CASH', '+201002589923', ours)).toThrow();
    // Anyone else's number still goes through.
    expect(normalizePayerReference('VODAFONE_CASH', '01284120292', ours)).toBe('01284120292');
    // And with no handles known, nothing is refused on this ground.
    expect(normalizePayerReference('VODAFONE_CASH', '01002589923')).toBe('01002589923');
  });
});

/**
 * Paying from a wallet balance.
 *
 * This is the regression that broke every wallet purchase in production.
 *
 * Requiring a transfer reference was right for the methods that have one, and
 * wrong for the one that does not. Money in a wallet is already inside the
 * platform: no bank is involved, no SMS arrives, and there is nothing for the
 * matcher to match. `payFromWallet` fills the payment form in on the student's
 * behalf and has no reference to give — so the requirement refused the request
 * before any money moved.
 *
 * It was invisible to the unit suite because nothing exercised payFromWallet
 * end to end; it took a real request against a running API to surface it:
 *
 *   POST /payments/from-wallet
 *   400  {"code":"REFERENCE_REQUIRED","kind":"TRANSACTION_REFERENCE"}
 */
describe('a wallet payment has no transfer to reference', () => {
  /**
   * The runtime regression this guards.
   *
   * Money in a wallet is already inside the platform: no bank is involved, no
   * SMS arrives, and there is nothing for the matcher to match. When every
   * method was required to carry a reference, `payFromWallet` — which fills the
   * payment form in on the student's behalf and has none to give — was refused
   * before any money moved, and every wallet purchase returned:
   *
   *   POST /payments/from-wallet
   *   400  {"code":"REFERENCE_REQUIRED","kind":"TRANSACTION_REFERENCE"}
   *
   * No unit test saw it; it took a real request against a running API. The
   * requirement is now narrowed to the one rail whose SMS actually carries a
   * matchable identifier, which covers this case too — so these assert the
   * behaviour rather than the mechanism, and hold however it is implemented.
   */
  it('is not required to carry one', () => {
    expect(referenceRequiredFor('WALLET')).toBe(false);
  });

  it('is accepted with nothing supplied', () => {
    expect(normalizePayerReference('WALLET', undefined)).toBe('');
    expect(normalizePayerReference('WALLET', '')).toBe('');
  });

  it('is still required from the one rail that can actually be matched on it', () => {
    // Vodafone Cash prints the sending wallet in its SMS, so the student can be
    // asked for it and the answer can be checked. This is the guard the wallet
    // exemption must not widen into.
    expect(referenceRequiredFor('VODAFONE_CASH')).toBe(true);
    expect(() => normalizePayerReference('VODAFONE_CASH', '')).toThrow();
  });
});
