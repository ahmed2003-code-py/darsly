import { BadRequestException } from '@nestjs/common';

/**
 * What the student has to tell us about their transfer, and why it differs by
 * method.
 *
 * Matching a transfer to a payment needs one identifier that appears on both
 * sides. Which identifier exists is decided by the provider, not by us:
 *
 *   Vodafone Cash sends no transaction id the student can see. What its SMS
 *   carries is the *sending wallet's number* — «تم استلام مبلغ 10.00 جنيه من
 *   01284120292» — so the number they transferred from is the identity, and it
 *   is something they know by heart.
 *
 *   A bank or InstaPay transfer carries a reference and no phone number at all
 *   — «برقم مرجعي 05b6efa4» — so the reference off their own receipt is the
 *   only thing both sides share.
 *
 * Asking for "reference (TXN / 010…)" and accepting anything, or nothing, is
 * why payments sat in manual review: a free-text box that a student could leave
 * empty removed the only link between the money and the person. So the field is
 * required, it is labelled for the method they picked, and its shape is checked
 * here — a wallet number that is not a wallet number cannot match any SMS, and
 * telling the student that now is far better than an admin working it out
 * tomorrow.
 */

/** Egyptian mobile, the four live prefixes, with or without a country code. */
const EG_MOBILE = /^(?:\+?20|0)?1[0125]\d{8}$/;

export type ReferenceKind = 'WALLET_NUMBER' | 'TRANSACTION_REFERENCE';

/**
 * Whether the student can actually be asked for this identifier.
 *
 * Vodafone Cash: yes. The SMS prints the sending wallet's number and the student
 * knows it by heart.
 *
 * InstaPay and bank transfers: **no**, and asking anyway was the bug. The two
 * sides carry different references — the student's receipt says «المرجع
 * 770916345902», the bank's SMS says «برقم مرجعي 3979e788» — issued by different
 * systems, never equal. A required field that cannot match anything sent every
 * transfer to a human and taught students to type whatever got the form to
 * submit, most often our own number off the screen in front of them. Those
 * transfers are identified by the receipt instead: amount and minute sent.
 */
export function referenceRequiredFor(method: string): boolean {
  return method === 'VODAFONE_CASH';
}

/** Which identifier this method's SMS will actually carry. */
export function referenceKindFor(method: string): ReferenceKind {
  return method === 'VODAFONE_CASH' ? 'WALLET_NUMBER' : 'TRANSACTION_REFERENCE';
}

/**
 * Normalize the student's answer to the form matching compares against, or
 * refuse it with the reason.
 *
 * Wallet numbers are stored as the bare local number (01xxxxxxxxx) so that a
 * student who typed +20 and an SMS that printed 0 still meet. References keep
 * their own characters — a bank's reference is not ours to reshape — and only
 * lose surrounding whitespace.
 */
export function normalizePayerReference(
  method: string,
  raw: string | undefined,
  /** The platform's own handles, so a student cannot hand us our own number. */
  receivingHandles: string[] = [],
): string {
  const value = (raw ?? '').trim();
  const kind = referenceKindFor(method);

  if (!value && !referenceRequiredFor(method)) {
    // Nothing to check, and nothing that could have been checked. The receipt
    // carries the identity for this rail.
    return '';
  }

  if (!value) {
    throw new BadRequestException({
      message:
        kind === 'WALLET_NUMBER'
          ? 'Enter the wallet number you transferred from'
          : 'Enter the transfer reference from your receipt',
      code: 'REFERENCE_REQUIRED',
      kind,
    });
  }

  if (kind === 'WALLET_NUMBER') {
    const digits = value.replace(/[^\d]/g, '');
    if (!EG_MOBILE.test(digits)) {
      throw new BadRequestException({
        message: 'That is not an Egyptian wallet number — it should look like 01xxxxxxxxx',
        code: 'BAD_WALLET_NUMBER',
        kind,
      });
    }
    // The last ten digits are the number itself; a leading 0 or +20 is not part
    // of it, and the SMS prints only one of the three spellings.
    const local = `0${digits.slice(-10)}`;
    // The number printed on the screen they are looking at is *ours*, and it is
    // the one people copy. It can never match: the SMS parser drops the
    // receiving number from the identities precisely because it appears in
    // every message. Caught here, while they can still fix it.
    if (receivingHandles.some((h) => h.replace(/[^\d]/g, '').slice(-10) === digits.slice(-10))) {
      throw new BadRequestException({
        message: 'That is our number — enter the wallet number you transferred FROM',
        code: 'OWN_NUMBER',
        kind,
      });
    }
    return local;
  }

  // A reference has to have enough to it to identify one transfer. Four
  // alphanumeric characters is the floor: below that it matches by accident.
  const alnum = value.replace(/[^0-9a-z]/gi, '');
  if (alnum.length < 4) {
    throw new BadRequestException({
      message: 'That reference is too short — copy it from the transfer message',
      code: 'BAD_REFERENCE',
      kind,
    });
  }
  return value;
}
