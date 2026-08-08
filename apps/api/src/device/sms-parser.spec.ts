import { createHash } from 'crypto';
import { PaymentMethod } from '@darsly/shared-types';
import {
  classifySender,
  isIncomingTransfer,
  parseIdentities,
  messageHash,
  normalizeSender,
  parseAmountCents,
  parseReference,
  SenderRuleLike,
} from './sms-parser';

const RULES: SenderRuleLike[] = [
  { brand: 'CIB', matchType: 'CONTAINS', pattern: 'cib', provider: PaymentMethod.BANK_TRANSFER, enabled: true, forwardToBackend: true, priority: 10 },
  { brand: 'Vodafone Cash', matchType: 'CONTAINS', pattern: 'vodafone', provider: PaymentMethod.VODAFONE_CASH, enabled: true, forwardToBackend: true, priority: 20 },
  { brand: 'InstaPay', matchType: 'EXACT', pattern: 'InstaPay', provider: PaymentMethod.INSTAPAY, enabled: true, forwardToBackend: true, priority: 30 },
  { brand: 'Disabled', matchType: 'CONTAINS', pattern: 'off', provider: PaymentMethod.OTHER, enabled: false, forwardToBackend: true, priority: 1 },
];

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('normalizeSender', () => {
  it('trims, collapses whitespace, lowercases', () => {
    expect(normalizeSender('  CIB   Bank ')).toBe('cib bank');
  });
});

describe('classifySender', () => {
  it('classifies CIB regardless of case/suffix (CONTAINS)', () => {
    expect(classifySender('CIB-Alerts', RULES)?.provider).toBe(PaymentMethod.BANK_TRANSFER);
    expect(classifySender('cibbank', RULES)?.brand).toBe('CIB');
  });

  it('classifies Vodafone Cash from a VodafoneCash sender id', () => {
    const c = classifySender('VodafoneCash', RULES);
    expect(c?.provider).toBe(PaymentMethod.VODAFONE_CASH);
    expect(c?.brand).toBe('Vodafone Cash');
  });

  it('separators in the sender id do not defeat a rule', () => {
    // Observed on a real handset: Vodafone Cash sends from "VF-Cash" while the
    // seeded rule reads "vfcash", so a genuine payment SMS was filed local-only.
    const rules: SenderRuleLike[] = [
      { brand: 'Vodafone Cash', matchType: 'CONTAINS', pattern: 'vfcash', provider: PaymentMethod.VODAFONE_CASH, enabled: true, forwardToBackend: true, priority: 21 },
    ];
    for (const sender of ['VF-Cash', 'VF Cash', 'VF_Cash', 'VF.Cash', 'VFCash', 'vf-cash']) {
      expect(classifySender(sender, rules)?.brand).toBe('Vodafone Cash');
    }
    expect(classifySender('CIB-Bank', RULES)?.brand).toBe('CIB');
  });

  it('separator stripping is for matching only and never changes the hash', () => {
    // messageHash must keep using normalizeSender, or idempotency would break
    // against events the backend has already stored.
    expect(normalizeSender('VF-Cash')).toBe('vf-cash');
    expect(messageHash('VF-Cash', 'body', new Date(1_000_000), sha256)).toBe(
      sha256('vf-cash body 1000'),
    );
  });

  it('EXACT match requires the whole sender to equal the pattern', () => {
    expect(classifySender('InstaPay', RULES)?.provider).toBe(PaymentMethod.INSTAPAY);
    expect(classifySender('InstaPay-Promo', RULES)).toBeNull();
  });

  it('returns null for unknown senders (stay local-only)', () => {
    expect(classifySender('+201099998888', RULES)).toBeNull();
    expect(classifySender('SomeShop', RULES)).toBeNull();
  });

  it('ignores disabled rules even when they would match', () => {
    expect(classifySender('turn-off-alerts', RULES)).toBeNull();
  });

  it('respects priority order (lower wins) when several rules match', () => {
    const rules: SenderRuleLike[] = [
      { brand: 'Generic', matchType: 'CONTAINS', pattern: 'bank', provider: PaymentMethod.OTHER, enabled: true, forwardToBackend: false, priority: 100 },
      { brand: 'CIB', matchType: 'CONTAINS', pattern: 'cib', provider: PaymentMethod.BANK_TRANSFER, enabled: true, forwardToBackend: true, priority: 10 },
    ];
    expect(classifySender('CIB Bank', rules)?.brand).toBe('CIB');
  });

  it('a malformed REGEX rule never throws — it just does not match', () => {
    const rules: SenderRuleLike[] = [
      { brand: 'Bad', matchType: 'REGEX', pattern: '([', provider: PaymentMethod.OTHER, enabled: true, forwardToBackend: true, priority: 1 },
    ];
    expect(() => classifySender('anything', rules)).not.toThrow();
    expect(classifySender('anything', rules)).toBeNull();
  });
});

describe('parseAmountCents', () => {
  it('parses Arabic amounts with ج.م', () => {
    expect(parseAmountCents('استلمت 450 ج.م من محفظتك')).toBe(45000);
    expect(parseAmountCents('تم إيداع 5,000 جنيه')).toBe(500000);
  });

  it('parses English EGP amounts with thousands + decimals', () => {
    expect(parseAmountCents('Your transaction of EGP 5,000.00 was completed')).toBe(500000);
    expect(parseAmountCents('received EGP450')).toBe(45000);
    expect(parseAmountCents('Amount: 1234.50 EGP')).toBe(123450);
  });

  it('returns null when no currency-qualified amount is present', () => {
    expect(parseAmountCents('Your OTP is 123456')).toBeNull();
    expect(parseAmountCents('Hello there')).toBeNull();
  });
});

describe('parseReference', () => {
  it('prefers a labelled reference (Arabic + English)', () => {
    expect(parseReference('استلمت 450 ج.م، رقم العملية 884213')).toBe('884213');
    expect(parseReference('Ref: TXN-88421 completed')).toBe('TXN-88421');
    expect(parseReference('transaction 9A8B7C6D done')).toBe('9A8B7C6D');
  });

  it('falls back to a 6+ digit run', () => {
    expect(parseReference('credited 500 EGP 778812 thanks')).toBe('778812');
  });

  it('returns null when there is no plausible reference', () => {
    expect(parseReference('credited 500 EGP')).toBeNull();
  });
});

describe('parseReference — real wallet SMS carry no transaction id', () => {
  // Vodafone Cash never sends a transaction reference; the sending wallet's
  // mobile number is the only identity in the message, and it is what the
  // student types at checkout.
  it('takes the sending mobile number as the transfer identity', () => {
    expect(parseReference('تم استلام مبلغ 5 جنيه من رقم 01029166461 المسجل بإسم احمد')).toBe('01029166461');
    expect(parseReference('تم استلام مبلغ 5.00 جنيه من 01002589923؛ رصيدك الحالي 300.00 جنيه')).toBe('01002589923');
  });

  it('is not fooled by a balance or a date printed before the number', () => {
    expect(parseReference('رصيدك 250000 جنيه. تم استلام مبلغ 450 جنيه من 01112223344')).toBe('01112223344');
  });

  it('still prefers an explicitly labelled reference when the bank sends one', () => {
    expect(parseReference('تم تحويل 5.00 جم، رقم العملية TXN-884213، من 01029166461')).toBe('TXN-884213');
  });

  it('returns null when the message carries no identity at all', () => {
    expect(parseReference('تم استلام مبلغ 5 جنيه على محفظتك')).toBeNull();
  });
});

describe('isIncomingTransfer — money in, not money out', () => {
  it('accepts real incoming wallet and bank messages', () => {
    expect(isIncomingTransfer('تم استلام مبلغ 12 جنيه من رقم 01029166461')).toBe(true);
    expect(isIncomingTransfer('Your account was credited with EGP 5,000')).toBe(true);
  });

  it('rejects an outgoing debit from the listener phone itself', () => {
    // Seen in production: the listener sits on a phone that also SENDS money, and
    // this was being booked as an incoming payment.
    expect(
      isIncomingTransfer('يرجى العلم انه تم تنفيذ تحويل لحظي بمبلغ 15.00 جم من حسابك المنتهي بـ ********7717'),
    ).toBe(false);
    expect(isIncomingTransfer('تم خصم مبلغ 50 جنيه من محفظتك')).toBe(false);
    expect(isIncomingTransfer('EGP 100 debited from your account')).toBe(false);
  });

  it('rejects anything that is not clearly incoming', () => {
    expect(isIncomingTransfer('رصيدك الحالي 250 جنيه')).toBe(false);
    expect(isIncomingTransfer('')).toBe(false);
  });
});

describe('parseIdentities — the student typed one of these', () => {
  const walletSms =
    'تم استلام مبلغ 12 جنيه من رقم 01029166461 المسجل بإسم Abdelrahman على رقم محفظتك 01002589923. رقم العملية 022484917650';

  it('returns the sending mobile AND the transaction reference', () => {
    const ids = parseIdentities(walletSms, ['01002589923']);
    expect(ids).toContain('01029166461'); // what the student types at checkout
    expect(ids).toContain('022484917650'); // what the wallet calls the transfer
  });

  it('excludes the platform own receiving number', () => {
    // It appears in every message; matching on it would tie every transfer to
    // whichever student happened to type the platform's number.
    expect(parseIdentities(walletSms, ['01002589923'])).not.toContain('01002589923');
  });

  it('picks up a bank reference with no mobile number in the message', () => {
    const bank = 'تم إضافة مبلغ 5.00 جم لحسابك برقم مرجعي 83541d9a بتاريخ 08-08-2026';
    expect(parseIdentities(bank)).toContain('83541d9a');
  });

  it('is empty when the message carries no identifier', () => {
    expect(parseIdentities('تم استلام مبلغ 5 جنيه على محفظتك')).toEqual([]);
  });
});

describe('messageHash', () => {
  it('is deterministic for the same normalized inputs', () => {
    const t = new Date('2026-08-08T06:12:34.000Z');
    const a = messageHash('CIB', 'body', t, sha256);
    const b = messageHash(' cib ', 'body', new Date('2026-08-08T06:12:34.999Z'), sha256);
    expect(a).toBe(b); // sender normalized + second-resolution timestamp
  });

  it('differs when the body differs', () => {
    const t = new Date('2026-08-08T06:12:34.000Z');
    expect(messageHash('CIB', 'a', t, sha256)).not.toBe(messageHash('CIB', 'b', t, sha256));
  });
});
