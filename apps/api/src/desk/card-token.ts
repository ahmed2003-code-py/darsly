import { createHash, randomInt } from 'crypto';
import { toLatinDigits } from '../center-students/student-code';

/**
 * A QR card's token: 48 random decimal digits (log2(10^48) ≈ 159 bits), and
 * nothing else — no name, no code, no id, no academy. Decimal on purpose: a
 * USB scanner "types" what it reads through the desk computer's keyboard
 * layout, and an Arabic layout turns letters into Arabic characters but
 * leaves the digit row alone; QR numeric mode also keeps the code small.
 *
 * Only SHA-256(token) is stored (AcademyStudentCard.tokenHash). The token is
 * shown once, to print the card, and is never logged, audited or persisted —
 * so the database alone cannot reproduce a card, and a lost card is replaced
 * by a new token rather than reprinted.
 *
 * A token is not authentication and never becomes one: it identifies a card
 * to signed-in staff of the card's academy who hold desk.checkin.
 */
export const CARD_TOKEN_DIGITS = 48;
const TOKEN_RE = new RegExp(`^\\d{${CARD_TOKEN_DIGITS}}$`);

/** A fresh token from the CSPRNG, one uniform digit at a time. */
export function generateCardToken(): string {
  let t = '';
  for (let i = 0; i < CARD_TOKEN_DIGITS; i++) t += String(randomInt(0, 10));
  return t;
}

/** The stored form: lowercase hex SHA-256. */
export function hashCardToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * What a scanner or a person sent, reduced to plain digits: Arabic-Indic and
 * Persian digits become 0-9 and spaces or dashes a reader may insert go.
 */
export function normalizeDeskInput(raw: string): string {
  return toLatinDigits(raw).replace(/[\s-]/g, '');
}

export function isCardToken(s: string): boolean {
  return TOKEN_RE.test(s);
}
