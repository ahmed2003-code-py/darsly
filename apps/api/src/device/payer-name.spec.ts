import { namesAgree, normalizeArabicName, parsePayerName } from './sms-parser';

/**
 * The name of the person who sent the money.
 *
 * It is the only piece of evidence on a transfer that a student cannot read off
 * somebody else's receipt: the amount and the reference are both on the
 * screenshot they were forwarded, and the name is whoever actually holds the
 * wallet. So it is what turns "a transfer of this size arrived around then"
 * into "this person paid" — and getting it wrong in either direction is
 * expensive. A missed name sends a real payment to manual review; a wrongly
 * accepted one credits a course to somebody who did not buy it.
 *
 * The two bodies below are real messages, kept verbatim.
 */
const VODAFONE = [
  'تم استلام مبلغ 10.00 جنيه من 01284120292؛',
  'المسجل بإسم احمد عبدالعزيز هريدى على',
  'على رقم محفظتك 01002589923 بتاريخ 13-09-26 23:38.',
  'رصيدك الحالي: 42.54 جنيه',
  'رقم العملية: 023683598446',
  'تقدر تتابع كل مصروفاتك من تاريخ المعاملات على أبلكيشن أنا فودافون http://vf.eg/vfcash',
].join('\n');

const CIB_INSTAPAY = [
  'يرجى العلم انه تم تنفيذ تحويل لحظي بمبلغ 2.00 جم إلى حسابك المنتهي بـ 7717********',
  'من ادهم محمد اشرف يسري ابو برقم مرجعي 05b6efa4 بتاريخ 2026-09-14 12:14',
  'للمزيد، برجاء الاتصال بـ 19666',
].join('\n');

/** The same bank message for money going the other way — a debit, not a credit. */
const CIB_OUTGOING = [
  'يرجى العلم انه تم تنفيذ تحويل لحظي بمبلغ 405.00 جم من حسابك المنتهي بـ 7717********',
  'برقم مرجعي f9cbbce8 بتاريخ 2026-09-13 23:29',
].join('\n');

describe('reading the payer off the message', () => {
  it('reads the registered name out of a wallet transfer', () => {
    expect(parsePayerName(VODAFONE)).toBe('احمد عبدالعزيز هريدى');
  });

  it('reads the sender name out of a bank transfer', () => {
    expect(parsePayerName(CIB_INSTAPAY)).toBe('ادهم محمد اشرف يسري ابو');
  });

  it('finds nobody to name on an outgoing debit', () => {
    // There is no payer: the account holder is the one who sent it. A name
    // invented here would be matched against a student who did nothing.
    expect(parsePayerName(CIB_OUTGOING)).toBeNull();
  });

  it('finds nobody to name when the message does not say', () => {
    expect(parsePayerName('تم استلام مبلغ 10.00 جنيه على رقم محفظتك 01002589923')).toBeNull();
    expect(parsePayerName('')).toBeNull();
  });
});

describe('folding the spellings of one name together', () => {
  it('ignores the differences Egyptians type either way', () => {
    // Hamza on alif, final ya, and ta marbuta.
    expect(normalizeArabicName('أحمد')).toBe(normalizeArabicName('احمد'));
    expect(normalizeArabicName('هريدي')).toBe(normalizeArabicName('هريدى'));
    expect(normalizeArabicName('فاطمة')).toBe(normalizeArabicName('فاطمه'));
  });

  it('ignores where a compound name is broken', () => {
    expect(normalizeArabicName('عبد العزيز')).toBe(normalizeArabicName('عبدالعزيز'));
  });

  it('ignores harakat and an honorific', () => {
    expect(normalizeArabicName('الأستاذ مُحَمَّد')).toBe(normalizeArabicName('محمد'));
  });
});

describe('deciding whether two names are one person', () => {
  it('accepts the register spelling against the SMS spelling', () => {
    // The real case: this is what the student registered, and that is what
    // Vodafone printed.
    expect(namesAgree('أحمد عبد العزيز هريدي', 'احمد عبدالعزيز هريدى')).toBe(true);
  });

  it('accepts a name the bank truncated', () => {
    // CIB printed five parts and cut the last one short.
    expect(namesAgree('ادهم محمد اشرف يسري ابوزيد', 'ادهم محمد اشرف يسري ابو')).toBe(true);
  });

  it('accepts a shorter registration against a fuller printed name', () => {
    expect(namesAgree('احمد هريدى', 'احمد عبدالعزيز هريدى')).toBe(true);
  });

  /**
   * The refusals matter more than the acceptances. Egyptian names repeat
   * heavily, so a similarity score with a threshold passes two different
   * people far too often — and what it would be passing is one student's money
   * onto another student's course.
   */
  it('refuses two different people who share a given name', () => {
    expect(namesAgree('محمد أحمد علي', 'محمد إبراهيم سعيد')).toBe(false);
  });

  it('refuses a different given name even with the family name in common', () => {
    expect(namesAgree('احمد عبدالعزيز هريدى', 'محمود عبدالعزيز هريدى')).toBe(false);
  });

  it('keeps the preposition that follows a bank name out of the name', () => {
    // «من احمد عبدالعزيز هريدى على برقم مرجعي …» — the greedy capture used to
    // take «على» as a fourth part of the name, and namesAgree then refused the
    // payer's own account.
    const name = parsePayerName(
      'تم تنفيذ تحويل لحظي بمبلغ 5.00 جم إلى حسابك المنتهي بـ **7717 من احمد عبدالعزيز هريدى على برقم مرجعي 3979e788 بتاريخ 16-09-2026 16:57',
    );
    expect(name).toBe('احمد عبدالعزيز هريدى');
    expect(namesAgree(name!, 'أحمد عبد العزيز هريدي')).toBe(true);
  });

  it('treats a single-word name as no evidence rather than a match', () => {
    expect(namesAgree('احمد', 'احمد عبدالعزيز هريدى')).toBe(false);
    expect(namesAgree('', 'احمد عبدالعزيز هريدى')).toBe(false);
  });
});
