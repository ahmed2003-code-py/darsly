import { normalizePayerReference, referenceKindFor } from './payer-reference';

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
  it('is refused for every method, with the right thing to ask for', () => {
    const kindOf = (method: string) => {
      try { normalizePayerReference(method, ''); } catch (e: any) { return e.getResponse(); }
    };
    expect(kindOf('VODAFONE_CASH')).toMatchObject({ code: 'REFERENCE_REQUIRED', kind: 'WALLET_NUMBER' });
    expect(kindOf('INSTAPAY')).toMatchObject({ code: 'REFERENCE_REQUIRED', kind: 'TRANSACTION_REFERENCE' });
    expect(kindOf('VODAFONE_CASH')).toMatchObject({ message: expect.stringContaining('wallet number') });
  });

  it('treats whitespace as leaving it out', () => {
    expect(() => normalizePayerReference('INSTAPAY', '   ')).toThrow();
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
