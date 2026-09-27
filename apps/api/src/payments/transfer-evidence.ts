import { parseIdentities, parsePayerName } from '../device/sms-parser';
import { isReceivingIdentifier } from './receiving-accounts';

/**
 * What an incoming transfer notification itself proves, as the SERVER reads
 * it — never as a caller or a buyer says it.
 *
 * Two kinds of identifier can appear in a provider's SMS:
 *
 *  - the sending wallet's mobile number (a Vodafone Cash wallet-to-wallet
 *    transfer prints it: «تم استلام مبلغ … من 01284120292»);
 *  - a provider-side reference: a transaction number («رقم العملية
 *    023683598446»), a bank's «برقم مرجعي 3979e788».
 *
 * A bank or InstaPay transfer INTO a wallet prints no sender number at all —
 * only the amount, the payer's name and the transaction number. Nothing here
 * invents one.
 *
 * Darsly's own receiving identifiers are removed from both lists: they appear
 * in every message and identify nobody.
 */

/** Egyptian mobile, the four live prefixes, with or without a country code. */
export const EG_MOBILE = /^(?:\+?20|0)?1[0125]\d{8}$/;

/** A mobile number in its one canonical spelling (01xxxxxxxxx), or null. */
export function localMobile(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/\D/g, '');
  if (!EG_MOBILE.test(digits)) return null;
  return `0${digits.slice(-10)}`;
}

/** A reference compared on its letters and digits only, case-folded. */
export function normRef(value: string | null | undefined): string {
  return (value ?? '').replace(/[^0-9a-z]/gi, '').toLowerCase();
}

export interface EventEvidence {
  /** Sending wallet numbers the provider printed, canonical 01xxxxxxxxx. */
  senderNumbers: string[];
  /** Provider-side references (transaction numbers), normalized. */
  providerRefs: string[];
  /** The name the provider printed for whoever sent the money. */
  payerName: string | null;
}

/**
 * Read an event's evidence. The raw message is the authority when present —
 * the phone forwards what it received, and the server re-derives everything
 * that decides whether money is credited. Only an event with no message at
 * all (a structured caller) falls back to the identifiers it was given.
 */
export function eventEvidence(
  input: { rawMessage?: string | null; reference?: string | null; identities?: string[] | null; payerName?: string | null },
  receiving: string[],
): EventEvidence {
  const raw = (input.rawMessage ?? '').trim();
  const found = raw
    ? [...parseIdentities(raw, receiving), ...(input.reference ? [input.reference] : [])]
    : input.identities?.length
      ? input.identities
      : input.reference
        ? [input.reference]
        : [];
  const senderNumbers = new Set<string>();
  const providerRefs = new Set<string>();
  for (const value of found) {
    if (!value || isReceivingIdentifier(value, receiving)) continue;
    const mobile = localMobile(value);
    if (mobile) senderNumbers.add(mobile);
    else {
      const ref = normRef(value);
      // Below four characters a reference matches by accident.
      if (ref.length >= 4) providerRefs.add(ref);
    }
  }
  const payerName = (input.payerName ?? (raw ? parsePayerName(raw) : null)) || null;
  return { senderNumbers: [...senderNumbers], providerRefs: [...providerRefs], payerName };
}

/** A pending payment's own identifier, in the form the evidence uses. */
export function typedIdentity(
  reference: string | null | undefined,
  receiving: string[],
): { kind: 'MOBILE' | 'REFERENCE'; value: string } | null {
  if (!reference?.trim() || isReceivingIdentifier(reference, receiving)) return null;
  const mobile = localMobile(reference);
  if (mobile) return { kind: 'MOBILE', value: mobile };
  const ref = normRef(reference);
  return ref.length >= 4 ? { kind: 'REFERENCE', value: ref } : null;
}
