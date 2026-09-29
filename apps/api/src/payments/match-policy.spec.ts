import { decideMatch, MatchCandidate, namesAgreeStrongly } from './match-policy';
import { eventEvidence, typedIdentity } from './transfer-evidence';
import { normalizeDeclaration, normalizePayerReference } from './payer-reference';

/**
 * The automatic matching policy, case by case.
 *
 * Every case is decided by the pure policy against the evidence the server
 * itself reads from the SMS — the same function ingest (SMS after payment)
 * and reconcile (SMS before payment) both call.
 */
const OURS = '01002589923';
const RECEIVING = [OURS, 'darsly@instapay'];
const AT = new Date('2026-09-27T03:46:59Z');

/** Vodafone Cash, wallet → wallet: the sender's number is printed. */
const walletSms = (sender: string, payer = 'احمد عبدالعزيز هريدى') =>
  [
    `تم استلام مبلغ 24.00 جنيه من ${sender}؛`,
    `المسجل بإسم ${payer} على`,
    `على رقم محفظتك ${OURS} بتاريخ 27-09-26 06:46.`,
    'رقم العملية: 023683598446',
  ].join('\n');

/** Vodafone Cash, bank / InstaPay → wallet: no sender number, a name and a transaction number. */
const bankToWalletSms = (payer = 'احمد عبدالعزيز هريدى') =>
  [
    'تم استلام مبلغ 24.00 جنيه',
    `من ${payer} على`,
    `رقم محفظتك ${OURS} عن طريق انستاباي.`,
    'رقم العملية: 023683598382',
  ].join('\n');

const ev = (raw: string) => eventEvidence({ rawMessage: raw }, RECEIVING);
const ctx = (over: Partial<{ otherOpenEvents: number }> = {}) => ({
  amountCents: 2400,
  occurredAt: AT,
  receiving: RECEIVING,
  otherOpenEvents: 0,
  ...over,
});
const cand = (over: Partial<MatchCandidate> = {}): MatchCandidate => ({
  kind: 'payment',
  id: 'p1',
  status: 'PENDING',
  reference: null,
  declaredPayerName: null,
  ownerName: 'Student One',
  receipt: null,
  ...over,
});
/** A receipt that "fits" the transfer: same amount, same minute (Cairo time). */
const RECEIPT = {
  isReceipt: true,
  amountCents: 2400,
  sentAtText: '27 Sep 2026 06:46',
  sentAtLocal: '2026-09-27T06:46',
  recipientHandle: OURS,
  recipientName: null,
  senderHandle: null,
  senderName: null,
  reference: null,
  issuer: 'Vodafone Cash',
  concerns: [],
} as any;

describe('the evidence the server reads from an SMS', () => {
  it('reads the sender number of a wallet transfer, never our own number', () => {
    const e = ev(walletSms('01284120292'));
    expect(e.senderNumbers).toEqual(['01284120292']);
    expect(e.senderNumbers).not.toContain(OURS);
    expect(e.providerRefs).toContain('023683598446');
  });

  it('invents no sender number for a bank → wallet transfer', () => {
    const e = ev(bankToWalletSms());
    expect(e.senderNumbers).toEqual([]);
    expect(e.providerRefs).toEqual(['023683598382']);
    expect(e.payerName).toBeTruthy();
  });

  it('(12) our receiving number in an SMS is never a payer — even with a country code', () => {
    const e = ev(`تم استلام مبلغ 24 جنيه من 2${OURS}`);
    expect(e.senderNumbers).toEqual([]);
    expect(
      eventEvidence({ reference: OURS, identities: [OURS, `+2${OURS}`] }, RECEIVING).senderNumbers,
    ).toEqual([]);
  });

  it('(12) a buyer reference equal to our number is no identity at all', () => {
    expect(typedIdentity(OURS, RECEIVING)).toBeNull();
    expect(typedIdentity('darsly@instapay', RECEIVING)).toBeNull();
  });

  it('spells a sender number one way, whatever the SMS printed', () => {
    expect(ev(walletSms('+201284120292')).senderNumbers).toEqual(['01284120292']);
  });
});

describe('the matching policy', () => {
  it('(1) one pending payment of the amount and no identity → never verified', () => {
    const d = decideMatch(ev(walletSms('01284120292')), [cand()], ctx());
    expect(d.status).toBe('AMBIGUOUS');
  });

  it('(2) two pending payments of the amount → never guessed', () => {
    const d = decideMatch(ev(bankToWalletSms()), [cand(), cand({ id: 'p2' })], ctx());
    expect(d.status).toBe('AMBIGUOUS');
  });

  it('(3) a receipt copied from another buyer, different payer → never verified', () => {
    const fake = cand({
      receipt: RECEIPT,
      ownerName: 'محمود ابراهيم سعيد',
      declaredPayerName: 'محمود ابراهيم سعيد',
    });
    const d = decideMatch(ev(bankToWalletSms('احمد عبدالعزيز هريدى')), [fake], ctx());
    expect(d.status).not.toBe('MATCHED');
  });

  it('(3) a fabricated receipt cannot win even when its owner is the only candidate', () => {
    const fake = cand({ receipt: RECEIPT, ownerName: 'X Y' });
    const d = decideMatch(ev(bankToWalletSms('احمد عبدالعزيز هريدى')), [fake], ctx());
    expect(d.status).toBe('AMBIGUOUS');
  });

  it('(4) wrong (valid-looking) sender number, right amount, matching receipt, same name → never verified', () => {
    const c = cand({
      reference: '01099999999',
      receipt: RECEIPT,
      ownerName: 'احمد عبد العزيز هريدي',
    });
    const d = decideMatch(ev(walletSms('01284120292')), [c], ctx());
    expect(d.status).toBe('AMBIGUOUS');
  });

  it('(4) wrong typed sender number, right amount, matching receipt → never verified', () => {
    const c = cand({
      reference: '01999999999',
      receipt: RECEIPT,
      ownerName: 'احمد عبد العزيز هريدي',
    });
    const d = decideMatch(ev(walletSms('01284120292')), [c], ctx());
    expect(d.status).toBe('AMBIGUOUS');
    if (d.status !== 'MATCHED') expect(d.note).toMatch(/sender number/);
  });

  it('(5) the provider-printed sender number equals the declared one → matched (strong)', () => {
    const c = cand({ reference: '01284120292' });
    const d = decideMatch(
      ev(walletSms('01284120292')),
      [c, cand({ id: 'p2', reference: '01111111111' })],
      ctx(),
    );
    expect(d).toMatchObject({ status: 'MATCHED', basis: 'SENDER_NUMBER' });
    if (d.status === 'MATCHED') expect(d.candidate.id).toBe('p1');
  });

  it('(6) bank → wallet: transaction number + full declared name, sole candidate, nothing else waiting → matched', () => {
    const c = cand({ declaredPayerName: 'أحمد عبد العزيز هريدي', ownerName: 'زائر' });
    const d = decideMatch(ev(bankToWalletSms('احمد عبدالعزيز هريدى')), [c], ctx());
    expect(d).toMatchObject({ status: 'MATCHED', basis: 'PAYER_NAME_UNIQUE' });
  });

  it('(6) bank → wallet: another unclaimed transfer of the amount is waiting → a person decides', () => {
    const c = cand({ declaredPayerName: 'أحمد عبد العزيز هريدي' });
    const d = decideMatch(
      ev(bankToWalletSms('احمد عبدالعزيز هريدى')),
      [c],
      ctx({ otherOpenEvents: 1 }),
    );
    expect(d.status).toBe('AMBIGUOUS');
  });

  it('(6) bank → wallet: two candidates of the amount → a person decides, even if one name fits', () => {
    const c = cand({ declaredPayerName: 'أحمد عبد العزيز هريدي' });
    const d = decideMatch(
      ev(bankToWalletSms('احمد عبدالعزيز هريدى')),
      [c, cand({ id: 'p2' })],
      ctx(),
    );
    expect(d.status).toBe('AMBIGUOUS');
  });

  it('(7) payer name + amount, no provider reference → not verified', () => {
    const e = { ...ev(bankToWalletSms('احمد عبدالعزيز هريدى')), providerRefs: [] };
    const d = decideMatch(e, [cand({ declaredPayerName: 'أحمد عبد العزيز هريدي' })], ctx());
    expect(d.status).toBe('AMBIGUOUS');
  });

  it('(7) a two-part name is not enough to prove who paid', () => {
    expect(namesAgreeStrongly('احمد هريدي', 'احمد هريدي')).toBe(false);
    const d = decideMatch(
      ev(bankToWalletSms('احمد هريدي')),
      [cand({ declaredPayerName: 'احمد هريدي' })],
      ctx(),
    );
    expect(d.status).toBe('AMBIGUOUS');
  });

  it('(13) a receipt-only candidate → review, never verified', () => {
    const d = decideMatch(ev(bankToWalletSms('')), [cand({ receipt: RECEIPT })], ctx());
    expect(d.status).toBe('AMBIGUOUS');
  });

  it('(14) a strong link over a contradicting declared name → review', () => {
    const c = cand({ reference: '01284120292', declaredPayerName: 'محمود ابراهيم سعيد' });
    const d = decideMatch(ev(walletSms('01284120292', 'احمد عبدالعزيز هريدى')), [c], ctx());
    expect(d.status).toBe('AMBIGUOUS');
  });

  it('(14) a strong link while another buyer’s receipt claims the same transfer → review', () => {
    const byRef = cand({ reference: '01284120292' });
    const byReceipt = cand({ id: 'p2', receipt: RECEIPT });
    const d = decideMatch(ev(walletSms('01284120292')), [byRef, byReceipt], ctx());
    expect(d.status).toBe('AMBIGUOUS');
  });

  it('(14) a wallet-declared buyer whose number the SMS contradicts is not saved by the name path', () => {
    const c = cand({ reference: '01999999999', declaredPayerName: 'احمد عبد العزيز هريدي' });
    const d = decideMatch(ev(walletSms('01284120292', 'احمد عبدالعزيز هريدى')), [c], ctx());
    expect(d.status).toBe('AMBIGUOUS');
  });

  it('two candidates declaring the same sender number → never guessed', () => {
    const d = decideMatch(
      ev(walletSms('01284120292')),
      [cand({ reference: '01284120292' }), cand({ id: 'p2', reference: '01284120292' })],
      ctx(),
    );
    expect(d.status).toBe('AMBIGUOUS');
  });

  it('a parent paying for a student: strong link, other name → credited, and written down', () => {
    const c = cand({ reference: '01284120292', ownerName: 'Student One' });
    const d = decideMatch(ev(walletSms('01284120292', 'احمد عبدالعزيز هريدى')), [c], ctx());
    expect(d.status).toBe('MATCHED');
    if (d.status === 'MATCHED') expect(d.note).toContain('worth a look');
  });

  it('no candidates → unmatched', () => {
    expect(decideMatch(ev(walletSms('01284120292')), [], ctx()).status).toBe('UNMATCHED');
  });
});

describe('what a buyer may declare', () => {
  it('(11) our receiving number as the sending wallet is refused', () => {
    expect(() =>
      normalizeDeclaration({ source: 'WALLET', senderWallet: OURS }, RECEIVING),
    ).toThrow();
    expect(() => normalizePayerReference('VODAFONE_CASH', `+2${OURS}`, RECEIVING)).toThrow();
  });

  it('(11) our InstaPay address as a bank reference is refused', () => {
    expect(() =>
      normalizeDeclaration(
        { source: 'BANK', payerName: 'احمد محمد علي', reference: 'darsly@instapay' },
        RECEIVING,
      ),
    ).toThrow();
  });

  it('a wallet source needs a real Egyptian wallet number', () => {
    expect(() =>
      normalizeDeclaration({ source: 'WALLET', senderWallet: '12345' }, RECEIVING),
    ).toThrow();
    expect(
      normalizeDeclaration({ source: 'WALLET', senderWallet: '+20 128 412 0292' }, RECEIVING),
    ).toMatchObject({
      source: 'WALLET',
      reference: '01284120292',
    });
  });

  it('a bank source needs no number, only the account holder’s name', () => {
    expect(
      normalizeDeclaration({ source: 'BANK', payerName: '  احمد  محمد علي ' }, RECEIVING),
    ).toEqual({
      source: 'BANK',
      reference: '',
      payerName: 'احمد محمد علي',
    });
    expect(() => normalizeDeclaration({ source: 'BANK', payerName: 'احمد' }, RECEIVING)).toThrow();
  });

  it('no source → refused (nothing is assumed)', () => {
    expect(() => normalizeDeclaration({}, RECEIVING)).toThrow();
  });
});
