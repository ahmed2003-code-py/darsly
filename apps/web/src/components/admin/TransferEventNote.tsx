import { useTranslation } from 'react-i18next';

/**
 * Why the matcher decided what it decided.
 *
 * The engine emits a fixed set of English diagnostics. Translated here rather
 * than at the source because they are also read from logs and tests, and an
 * unrecognised one still renders — left-to-right and wrapped, so a new string
 * reads as an English sentence instead of a clipped fragment of one.
 */
const NOTE_KEY: Record<string, string> = {
  // Current wording…
  'no pending/unsettled payment or wallet top-up with this amount/method in the time window':
    'noMatch',
  'no sender reference — auto-verify disabled without a transfer identity; needs manual review':
    'noReference',
  'multiple payments share this reference': 'sharedReference',
  'matched by amount+time (reference differed)': 'matchedByAmount',
  'several amount matches, none by reference': 'severalMatches',
  'reconciled when the payment was submitted (transfer arrived first)': 'reconciledPayment',
  'reconciled when the top-up was submitted (transfer arrived first)': 'reconciledTopup',
  'one amount match, but neither the reference nor a payer name confirms it': 'amountOnly',
  'the sender number in the SMS is not the number the buyer declared — not verified automatically':
    'senderConflict',
  'the payer name in the SMS is not the name the buyer declared — not verified automatically':
    'nameConflict',
  'a receipt fits this transfer, but a receipt is only supporting evidence — needs review':
    'receiptOnly',
  'another buyer’s receipt also claims this transfer — needs review': 'receiptConflict',
  'another unclaimed transfer of the same amount is waiting — needs review': 'otherTransfers',
  'the message describes money leaving the account, not arriving — never auto-verified': 'outgoing',
  // …and every wording the matcher has used before. A note is written into the
  // row when the transfer arrives and stays there for ever, so rows outlive the
  // sentence that produced them.
  'no pending/unsettled payment with this amount/method in the time window': 'noMatch',
  'no pending payment with this amount/method in the time window': 'noMatch',
  'matched by amount+time (no reference)': 'matchedByAmount',
  'several amount matches, no reference to disambiguate': 'severalMatches',
};

/** Notes that carry a name or an id after a fixed opening. */
const NOTE_PREFIX: [string, string][] = [
  ["matched by the payer's full name", 'matchedByName'],
  ['matched by reference, but the transfer is in the name of', 'matchedOtherName'],
  ['one amount match, but the transfer is in the name of', 'oneMatchOtherName'],
  ['manual match by', 'manualMatch'],
  ['attached by admin', 'attachedByAdmin'],
  ['linked by admin', 'linkedToVerified'],
];

export default function TransferEventNote({ note }: { note: string }) {
  const { t } = useTranslation();
  const trimmed = note.trim();
  const key = NOTE_KEY[trimmed] ?? NOTE_PREFIX.find(([p]) => trimmed.startsWith(p))?.[1];
  if (key) {
    return (
      <p className="mt-0.5 text-xs leading-relaxed text-outline">{t(`apay.eventNote.${key}`)}</p>
    );
  }
  return (
    <p
      className="mt-0.5 text-xs leading-relaxed text-outline"
      dir="ltr"
      style={{ textAlign: 'start' }}
    >
      {note}
    </p>
  );
}
