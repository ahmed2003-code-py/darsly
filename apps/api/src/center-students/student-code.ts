import { randomInt } from 'crypto';

/**
 * An academy's code for one of its learners: six digits, the first never 0
 * (a spreadsheet would eat it), the last a Luhn check digit over the first
 * five. A desk types it; it signs nobody in and authorizes nothing.
 *
 * The database holds the definition of a valid code — a CHECK constraint
 * running academy_student_code_ok() (migration 20261031100000) — so a code
 * made here, by the backfill, or by the Enrollment trigger can only be stored
 * if it passes. This file generates codes for the API and validates what a
 * person typed before it becomes a query.
 */

/** Luhn check digit for a string of digits. */
function checkDigit(body: string): number {
  let sum = 0;
  let double = true; // the check digit will sit to the right of body
  for (let i = body.length - 1; i >= 0; i--) {
    let d = body.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return (10 - (sum % 10)) % 10;
}

/** A fresh random code. Uniqueness is the database's to enforce. */
export function generateStudentCode(): string {
  const body = String(randomInt(10_000, 100_000));
  return body + String(checkDigit(body));
}

/** Six digits, no leading 0, and the check digit agrees. */
export function isValidStudentCode(code: string): boolean {
  if (!/^[1-9][0-9]{5}$/.test(code)) return false;
  return checkDigit(code.slice(0, 5)) === code.charCodeAt(5) - 48;
}

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';

/**
 * Arabic-Indic (٠-٩) and Persian (۰-۹) digits to 0-9. A desk keyboard set to
 * Arabic types the former; nothing downstream should have to care.
 */
export function toLatinDigits(s: string): string {
  let out = '';
  for (const ch of s) {
    const a = ARABIC_INDIC.indexOf(ch);
    if (a >= 0) {
      out += String(a);
      continue;
    }
    const p = PERSIAN.indexOf(ch);
    out += p >= 0 ? String(p) : ch;
  }
  return out;
}

/**
 * The digits a person meant, when what they typed is a number: Latin digits,
 * with spaces, dashes, dots and a leading + removed. Null when anything else
 * is in it (then it is a name, not a number).
 */
export function digitsOnly(raw: string): string | null {
  const s = toLatinDigits(raw)
    .trim()
    .replace(/[\s\-.() ]/g, '');
  if (!s) return null;
  const body = s.startsWith('+') ? s.slice(1) : s;
  return /^[0-9]+$/.test(body) ? body : null;
}
