import { ProofReading } from './proof-reader.service';

/**
 * What a receipt is worth as evidence, decided in one place.
 *
 * Two questions, asked at two different moments:
 *
 *  1. At upload — does this receipt agree with what the student typed, and was
 *     the money sent to *us*? A student who transferred 2,000 and typed 500, or
 *     who uploaded a receipt made out to somebody else's InstaPay address, finds
 *     out immediately instead of waiting a day for an admin to notice.
 *
 *  2. When the bank's SMS arrives — is this receipt *that* transfer? The two
 *     sides share no reference (they are issued by different systems), so the
 *     link is the amount and the minute it was sent. Same piastre amount, same
 *     minute, and it is the same transfer; anything less is not claimed.
 *
 * Everything here is pure: given a reading it returns the same verdict forever,
 * and the reasons are the strings an admin reads.
 */

export type ProofVerdict = 'AGREES' | 'DISAGREES' | 'UNREADABLE';

export interface ProofCheck {
  verdict: ProofVerdict;
  /** Human-readable, Arabic, shown to the student and stored for the admin. */
  problems: string[];
  /** Noted but not disqualifying — an admin should still see them. */
  notes: string[];
}

/** Two handles are the same account, ignoring case and decoration. */
function sameHandle(a: string, b: string): boolean {
  const fold = (v: string) => v.trim().toLowerCase().replace(/\s+/g, '');
  const A = fold(a);
  const B = fold(b);
  if (!A || !B) return false;
  if (A === B) return true;
  // A phone number may be printed with or without a country code.
  const da = A.replace(/\D/g, '');
  const db = B.replace(/\D/g, '');
  if (da.length >= 10 && db.length >= 10) return da.slice(-10) === db.slice(-10);
  return false;
}

/**
 * Does the receipt support the top-up the student is filing?
 *
 * `receivingHandles` are the platform's own accounts. A receipt that names none
 * of them is a receipt for somebody else's transfer, whatever else it says.
 */
export function checkProofAgainstClaim(
  reading: ProofReading | null,
  claim: { amountCents: number },
  receivingHandles: string[],
): ProofCheck {
  if (!reading) return { verdict: 'UNREADABLE', problems: [], notes: [] };
  const problems: string[] = [];
  const notes: string[] = [];

  if (!reading.isReceipt) {
    return {
      verdict: 'DISAGREES',
      problems: ['الصورة دي مش صورة إيصال تحويل — ارفع صورة عملية التحويل نفسها.'],
      notes: [],
    };
  }

  if (reading.amountCents != null && reading.amountCents !== claim.amountCents) {
    problems.push(
      `الإيصال مكتوب فيه ${egp(reading.amountCents)} وإنت كاتب ${egp(claim.amountCents)} — لازم يكونوا نفس المبلغ.`,
    );
  } else if (reading.amountCents == null) {
    notes.push('مقدرناش نقرا المبلغ من الصورة.');
  }

  // Who it was sent to. Only checked when the receipt prints a recipient at all
  // and we know our own handles — never used to refuse on missing information.
  if (reading.recipientHandle && receivingHandles.length) {
    if (!receivingHandles.some((h) => sameHandle(h, reading.recipientHandle!))) {
      problems.push(
        `الإيصال ده متحوّل لحساب «${reading.recipientHandle}» — ده مش حساب من حساباتنا. راجع إنك حوّلت للحساب الصح.`,
      );
    }
  } else if (!reading.recipientHandle) {
    notes.push('الإيصال مش مبيّن الحساب المحوَّل له.');
  }

  for (const c of reading.concerns ?? []) notes.push(`ملاحظة على الصورة: ${c}`);

  return { verdict: problems.length ? 'DISAGREES' : 'AGREES', problems, notes };
}

/** How far apart the receipt and the SMS may be and still be one transfer. */
export const PROOF_TIME_TOLERANCE_MS = 15 * 60_000;

/**
 * Is the transfer this receipt describes the one the bank just announced?
 *
 * The amount must be exact — it is the same money, printed twice. The time is
 * allowed to drift: the receipt prints the moment the sender pressed send, the
 * SMS the moment the bank booked it, and the two are minutes apart. The receipt
 * carries no timezone (it is Cairo wall time), so the comparison is made against
 * Cairo wall time on the other side too.
 */
export function receiptMatchesTransfer(
  reading: ProofReading | null,
  transfer: { amountCents: number; occurredAt: Date },
  toleranceMs: number = PROOF_TIME_TOLERANCE_MS,
): boolean {
  if (!reading?.isReceipt) return false;
  if (reading.amountCents == null || reading.amountCents !== transfer.amountCents) return false;
  const sent = cairoWallTimeToInstant(reading.sentAtLocal);
  if (!sent) return false;
  return Math.abs(sent.getTime() - transfer.occurredAt.getTime()) <= toleranceMs;
}

/**
 * "2026-09-16T07:55", written on a phone in Cairo, as an instant.
 *
 * Egypt keeps summer time again (UTC+3 from the last Friday in April to the last
 * Thursday in October, UTC+2 otherwise), and a receipt never says which it is —
 * so the offset is derived from the date itself rather than assumed. Getting it
 * wrong by an hour would push a real transfer outside the tolerance.
 */
export function cairoWallTimeToInstant(local: string | null | undefined): Date | null {
  if (!local) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(local.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number) as unknown as number[];
  const naiveUtc = Date.UTC(y, mo - 1, d, h, mi);
  const offsetHours = cairoOffsetHours(new Date(naiveUtc));
  const at = new Date(naiveUtc - offsetHours * 3600_000);
  return Number.isFinite(at.getTime()) ? at : null;
}

/** +3 during Egyptian summer time, +2 otherwise. */
function cairoOffsetHours(at: Date): number {
  const year = at.getUTCFullYear();
  // Last Friday of April, 00:00 → summer time begins.
  const start = lastWeekdayUtc(year, 3, 5);
  // Last Thursday of October, 24:00 → it ends.
  const end = lastWeekdayUtc(year, 9, 4);
  return at >= start && at < end ? 3 : 2;
}

/** The last `weekday` (0=Sun) of `monthIndex`, at 00:00 UTC. */
function lastWeekdayUtc(year: number, monthIndex: number, weekday: number): Date {
  const d = new Date(Date.UTC(year, monthIndex + 1, 0));
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

function egp(cents: number): string {
  return `${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })} ج.م`;
}
