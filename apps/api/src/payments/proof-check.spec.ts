import { cairoWallTimeToInstant, checkProofAgainstClaim, receiptMatchesTransfer } from './proof-check';
import { ProofReading } from './proof-reader.service';

/** The receipt in the report, field for field. */
const RECEIPT: ProofReading = {
  isReceipt: true,
  amountCents: 200000,
  sentAtText: '16 Sep 2026 07:55 AM',
  sentAtLocal: '2026-09-16T07:55',
  recipientHandle: 'ahmedelsayed2003@instapay',
  recipientName: 'AHMED E****** A**** E****** M*',
  senderHandle: 'mohtahati@instapay',
  senderName: 'MOHAMED TAHA ATIEA MASOOD',
  reference: '770916345902',
  issuer: 'InstaPay',
  concerns: [],
};
const OURS = ['ahmedelsayed2003@instapay', '01002589923'];

describe('the receipt against what the student typed', () => {
  it('agrees when the amount and the destination are right', () => {
    expect(checkProofAgainstClaim(RECEIPT, { amountCents: 200000 }, OURS)).toMatchObject({
      verdict: 'AGREES',
      problems: [],
    });
  });

  it('catches an amount that does not match the receipt', () => {
    const r = checkProofAgainstClaim(RECEIPT, { amountCents: 50000 }, OURS);
    expect(r.verdict).toBe('DISAGREES');
    expect(r.problems[0]).toContain('2,000');
    expect(r.problems[0]).toContain('500');
  });

  it('catches a receipt for a transfer to somebody else', () => {
    const elsewhere = { ...RECEIPT, recipientHandle: 'someoneelse@instapay' };
    const r = checkProofAgainstClaim(elsewhere, { amountCents: 200000 }, OURS);
    expect(r.verdict).toBe('DISAGREES');
    expect(r.problems[0]).toContain('someoneelse@instapay');
  });

  it('accepts our wallet number written with a country code', () => {
    const vf = { ...RECEIPT, recipientHandle: '+20 100 258 9923' };
    expect(checkProofAgainstClaim(vf, { amountCents: 200000 }, OURS).verdict).toBe('AGREES');
  });

  it('refuses an image that is not a receipt', () => {
    const notOne = { ...RECEIPT, isReceipt: false };
    expect(checkProofAgainstClaim(notOne, { amountCents: 200000 }, OURS).verdict).toBe('DISAGREES');
  });

  it('does not refuse on what it could not read', () => {
    const partial = { ...RECEIPT, amountCents: null, recipientHandle: null };
    const r = checkProofAgainstClaim(partial, { amountCents: 200000 }, OURS);
    expect(r.verdict).toBe('AGREES');
    expect(r.notes.length).toBe(2);
  });

  it('passes an unreadable image through as unreadable, not as a refusal', () => {
    expect(checkProofAgainstClaim(null, { amountCents: 200000 }, OURS).verdict).toBe('UNREADABLE');
  });

  it('carries a tampering concern to the admin without refusing on it', () => {
    const odd = { ...RECEIPT, concerns: ['the amount uses a different font from the rest'] };
    const r = checkProofAgainstClaim(odd, { amountCents: 200000 }, OURS);
    expect(r.verdict).toBe('AGREES');
    expect(r.notes.join()).toContain('different font');
  });
});

describe('the receipt against the bank SMS', () => {
  // 07:55 Cairo in September is 04:55 UTC (summer time, +3).
  const at = (iso: string) => new Date(iso);

  it('links them by the amount and the minute', () => {
    expect(receiptMatchesTransfer(RECEIPT, { amountCents: 200000, occurredAt: at('2026-09-16T04:55:00Z') })).toBe(true);
  });

  it('tolerates the few minutes between sending and booking', () => {
    expect(receiptMatchesTransfer(RECEIPT, { amountCents: 200000, occurredAt: at('2026-09-16T05:05:00Z') })).toBe(true);
  });

  it('refuses a transfer an hour away', () => {
    expect(receiptMatchesTransfer(RECEIPT, { amountCents: 200000, occurredAt: at('2026-09-16T05:55:00Z') })).toBe(false);
  });

  it('refuses a different amount however close in time', () => {
    expect(receiptMatchesTransfer(RECEIPT, { amountCents: 199900, occurredAt: at('2026-09-16T04:55:00Z') })).toBe(false);
  });

  it('claims nothing when the receipt had no readable time', () => {
    const noTime = { ...RECEIPT, sentAtLocal: null };
    expect(receiptMatchesTransfer(noTime, { amountCents: 200000, occurredAt: at('2026-09-16T04:55:00Z') })).toBe(false);
  });
});

describe('Cairo wall time', () => {
  it('is UTC+3 in summer and UTC+2 in winter', () => {
    // Egypt reinstated summer time: getting this wrong by an hour puts a real
    // transfer outside the tolerance and sends it to a human for nothing.
    expect(cairoWallTimeToInstant('2026-09-16T07:55')!.toISOString()).toBe('2026-09-16T04:55:00.000Z');
    expect(cairoWallTimeToInstant('2026-01-16T07:55')!.toISOString()).toBe('2026-01-16T05:55:00.000Z');
  });

  it('returns null rather than a guess for something it cannot parse', () => {
    expect(cairoWallTimeToInstant('yesterday evening')).toBeNull();
    expect(cairoWallTimeToInstant(null)).toBeNull();
  });
});
