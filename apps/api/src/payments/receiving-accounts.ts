import { PrismaService } from '../prisma/prisma.service';

/**
 * Darsly's own receiving accounts — the numbers and addresses people are told
 * to transfer TO.
 *
 * One of them appears in every incoming SMS («على رقم محفظتك 01002589923»), and
 * it is also the number printed on the checkout screen, which is exactly the
 * one a buyer is most likely to copy into "the number you transferred from".
 * So a receiving identifier is never an answer to "who paid": not as a typed
 * sender, not as a sender parsed out of an SMS, not as a buyer identity.
 *
 * Every path that reads or writes a payer identity — course payments, wallet
 * top-ups, Live seats, the SMS listener and the matcher — asks here, so there
 * is one list and one rule. Inactive accounts are included on purpose: a
 * number we stopped advertising is still ours, and still in old SMS.
 */
export async function receivingHandles(prisma: Pick<PrismaService, 'platformPaymentAccount'>): Promise<string[]> {
  // An enrichment, never a precondition: if the lookup fails, nothing is
  // excluded, and every decision that depends on identity is still made by
  // the rules that follow (which never auto-verify on weak evidence).
  try {
    const accounts = await prisma.platformPaymentAccount.findMany({ select: { handle: true } });
    return accounts.map((a) => a.handle).filter(Boolean);
  } catch {
    return [];
  }
}

/** The last ten digits of anything that is at least a ten-digit number. */
function tenDigits(value: string): string | null {
  const d = (value ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}

/** Folded for comparing non-numeric handles (an InstaPay address, say). */
function fold(value: string): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, '');
}

/** Is this value one of Darsly's own receiving identifiers? */
export function isReceivingIdentifier(value: string | null | undefined, handles: string[]): boolean {
  if (!value) return false;
  const digits = tenDigits(value);
  return handles.some((h) => {
    const hd = tenDigits(h);
    if (digits && hd) return digits === hd;
    return !!fold(h) && fold(h) === fold(value);
  });
}
