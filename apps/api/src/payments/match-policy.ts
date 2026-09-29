import { nameParts, namesAgree } from '../device/sms-parser';
import { receiptMatchesTransfer } from './proof-check';
import { ProofReading } from './proof-reader.service';
import { EventEvidence, typedIdentity } from './transfer-evidence';

/**
 * When may a real incoming transfer be credited to a pending payment WITHOUT a
 * person looking at it?
 *
 * One policy, for every kind of candidate (course payment, Live seat, wallet
 * top-up) and both directions (the SMS arrives after the payment, or before
 * it). Evidence is sorted into three kinds:
 *
 *   STRONG — observed by the SERVER in the provider's own message, and linking
 *   it to exactly one buyer: the sending wallet's number the provider printed
 *   equal to the number the buyer declared, or a provider-side transaction
 *   reference the buyer quoted exactly.
 *
 *   SUPPORTING — the amount, the time, the payer's name, the receiving
 *   account, and the buyer's uploaded receipt. A receipt is an image the buyer
 *   controls: it is never authority, only corroboration.
 *
 *   CONTRADICTORY — the provider printed a sender number and the buyer
 *   declared a different one; the buyer declared a payer name the provider's
 *   name clearly is not; another buyer's receipt claims the same transfer.
 *
 * The rules, in order:
 *   1. amount alone, a receipt alone, and amount + receipt NEVER verify;
 *   2. contradictory evidence NEVER verifies — it goes to a person;
 *   3. a strong link to exactly one candidate verifies;
 *   4. with no strong link, only one narrow case verifies: the provider printed
 *      a transaction reference (the transfer is uniquely identified) and a
 *      full payer name, that name agrees part-for-part (three parts or more)
 *      with the one candidate of this amount in the window, and no other
 *      unclaimed transfer of this amount is waiting. That is a bank → wallet
 *      transfer by the account holder themselves, and nothing in it is
 *      buyer-controlled;
 *   5. everything else — several candidates, one candidate on amount alone, a
 *      receipt that "fits" — is AMBIGUOUS/UNMATCHED and waits for a person.
 */

export type CandidateKind = 'payment' | 'topup';

export interface MatchCandidate {
  kind: CandidateKind;
  id: string;
  /** For a payment: PENDING, or PAID-but-unsettled (a teacher's self-verify). */
  status?: string;
  /** What the buyer declared: a sending wallet number or a transaction reference. */
  reference: string | null;
  /** The name the buyer declared for the account they paid FROM, if asked. */
  declaredPayerName: string | null;
  /** The name on the Darsly account that owes the money (student, or a guest's given name). */
  ownerName: string;
  /** The buyer's receipt as read from their image. Corroboration only. */
  receipt: ProofReading | null;
}

export type MatchBasis = 'SENDER_NUMBER' | 'PROVIDER_REFERENCE' | 'PAYER_NAME_UNIQUE';

export type MatchDecision =
  | { status: 'MATCHED'; candidate: MatchCandidate; basis: MatchBasis; note?: string }
  | { status: 'UNMATCHED' | 'AMBIGUOUS'; note: string };

export interface MatchContext {
  amountCents: number;
  occurredAt: Date;
  /** Darsly's own receiving identifiers — never a payer identity. */
  receiving: string[];
  /** Other unclaimed transfers of this amount and rail near this one. */
  otherOpenEvents: number;
}

// The notes are what an admin reads; the first three keep the wording the
// admin UI already translates.
export const NOTE = {
  noCandidate:
    'no pending/unsettled payment or wallet top-up with this amount/method in the time window',
  sharedReference: 'multiple payments share this reference',
  severalMatches: 'several amount matches, none by reference',
  amountOnly: 'one amount match, but neither the reference nor a payer name confirms it',
  senderConflict:
    'the sender number in the SMS is not the number the buyer declared — not verified automatically',
  nameConflict:
    'the payer name in the SMS is not the name the buyer declared — not verified automatically',
  receiptOnly:
    'a receipt fits this transfer, but a receipt is only supporting evidence — needs review',
  receiptConflict: 'another buyer’s receipt also claims this transfer — needs review',
  otherTransfers: 'another unclaimed transfer of the same amount is waiting — needs review',
} as const;

/** Names that agree part-for-part, both with at least three parts. */
export function namesAgreeStrongly(a: string, b: string): boolean {
  if (nameParts(a).length < 3 || nameParts(b).length < 3) return false;
  return namesAgree(a, b);
}

interface Assessed {
  c: MatchCandidate;
  /** The provider-printed sender number equals the declared one. */
  senderLink: boolean;
  /** The declared reference equals a provider-side reference exactly. */
  referenceLink: boolean;
  /** The provider printed a sender number and it is not the declared one. */
  senderConflict: boolean;
  /** The buyer declared a payer name and the provider's name is not it. */
  nameConflict: boolean;
  receiptFits: boolean;
}

function assess(c: MatchCandidate, e: EventEvidence, ctx: MatchContext): Assessed {
  const typed = typedIdentity(c.reference, ctx.receiving);
  const senderLink = typed?.kind === 'MOBILE' && e.senderNumbers.includes(typed.value);
  const referenceLink = typed?.kind === 'REFERENCE' && e.providerRefs.includes(typed.value);
  // The provider named the sending wallet, and what this buyer declared is not
  // it — whatever shape their answer took (a mistyped number, a reference).
  const senderConflict = !!typed && e.senderNumbers.length > 0 && !senderLink && !referenceLink;
  const nameConflict =
    !!e.payerName &&
    !!c.declaredPayerName?.trim() &&
    nameParts(c.declaredPayerName).length >= 2 &&
    nameParts(e.payerName).length >= 2 &&
    !namesAgree(e.payerName, c.declaredPayerName);
  const receiptFits = receiptMatchesTransfer(c.receipt, {
    amountCents: ctx.amountCents,
    occurredAt: ctx.occurredAt,
  });
  return { c, senderLink, referenceLink, senderConflict, nameConflict, receiptFits };
}

/**
 * Decide one transfer against every candidate of its amount, rail and window.
 * `candidates` must be ALL of them — the policy's uniqueness rules are only
 * as good as the pool it is shown.
 */
export function decideMatch(
  e: EventEvidence,
  candidates: MatchCandidate[],
  ctx: MatchContext,
): MatchDecision {
  if (candidates.length === 0) return { status: 'UNMATCHED', note: NOTE.noCandidate };
  const all = candidates.map((c) => assess(c, e, ctx));

  // Rule 3: a strong link — but only to one candidate, and never over a
  // contradiction or a competing claim.
  const linked = all.filter((a) => a.senderLink || a.referenceLink);
  if (linked.length > 1) return { status: 'AMBIGUOUS', note: NOTE.sharedReference };
  if (linked.length === 1) {
    const a = linked[0];
    if (a.nameConflict) return { status: 'AMBIGUOUS', note: NOTE.nameConflict };
    if (all.some((o) => o !== a && o.receiptFits))
      return { status: 'AMBIGUOUS', note: NOTE.receiptConflict };
    const basis: MatchBasis = a.senderLink ? 'SENDER_NUMBER' : 'PROVIDER_REFERENCE';
    // The account that owes the money in another name is ordinary (a parent
    // paying) and is credited — but written down.
    const note =
      e.payerName && a.c.ownerName && !namesAgree(e.payerName, a.c.ownerName)
        ? `matched by reference, but the transfer is in the name of "${e.payerName}" and the account is "${a.c.ownerName}" — worth a look`
        : undefined;
    return { status: 'MATCHED', candidate: a.c, basis, note };
  }

  // No strong link. Contradictions are reported as such.
  if (all.length === 1 && all[0].senderConflict)
    return { status: 'AMBIGUOUS', note: NOTE.senderConflict };
  if (all.length === 1 && all[0].nameConflict)
    return { status: 'AMBIGUOUS', note: NOTE.nameConflict };

  // Rule 4: the one narrow name-based case — only for a transfer that carries
  // no sender number at all (bank / InstaPay → wallet). When the provider did
  // print the sending wallet, that number is the identity, and nothing
  // weaker substitutes for it.
  if (all.length === 1 && e.senderNumbers.length === 0) {
    const a = all[0];
    const name = a.c.declaredPayerName?.trim() || a.c.ownerName;
    const nameFits = !!e.payerName && !!name && namesAgreeStrongly(e.payerName, name);
    if (nameFits && e.providerRefs.length > 0) {
      if (ctx.otherOpenEvents > 0) return { status: 'AMBIGUOUS', note: NOTE.otherTransfers };
      return {
        status: 'MATCHED',
        candidate: a.c,
        basis: 'PAYER_NAME_UNIQUE',
        note: `matched by the payer's full name ("${e.payerName}") on the only pending payment of this amount; no other transfer of this amount is waiting`,
      };
    }
  }

  // Rule 5: a person decides. Say what was seen.
  if (all.some((a) => a.receiptFits)) return { status: 'AMBIGUOUS', note: NOTE.receiptOnly };
  if (all.length === 1) {
    const a = all[0];
    if (e.payerName && a.c.ownerName && !namesAgree(e.payerName, a.c.ownerName)) {
      return {
        status: 'AMBIGUOUS',
        note: `one amount match, but the transfer is in the name of "${e.payerName}" and the account is "${a.c.ownerName}" — reference did not match either`,
      };
    }
    return { status: 'AMBIGUOUS', note: NOTE.amountOnly };
  }
  return { status: 'AMBIGUOUS', note: NOTE.severalMatches };
}
