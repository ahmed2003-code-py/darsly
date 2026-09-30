import { BadRequestException } from '@nestjs/common';
import { EGY_PHONE_REGEX, normalizeEgyptianPhone } from '../auth/dto/auth.dto';
import { toLatinDigits } from './student-code';

/**
 * Contact numbers on the register go through the same normaliser as every
 * account's phone (normalizeEgyptianPhone → +201XXXXXXXXX), after Arabic
 * digits are read as digits. They are contact details only: nothing here is
 * ever compared against User.phone or used to find an account.
 */

/** Blank → null; otherwise the E.164 number, or null when it is not one. */
export function parsePhone(raw: string | null | undefined): string | null | 'INVALID' {
  if (raw == null) return null;
  const s = toLatinDigits(raw).replace(/[\s\-.() ]/g, '');
  if (!s) return null;
  if (!EGY_PHONE_REGEX.test(s)) return 'INVALID';
  return normalizeEgyptianPhone(s);
}

/** As parsePhone, but a bad number is a 400 naming the field it came from. */
export function phoneField(raw: string | null | undefined, field: string): string | null {
  const p = parsePhone(raw);
  if (p === 'INVALID') {
    throw new BadRequestException({
      message: 'phone must be a valid Egyptian mobile number',
      code: 'INVALID_PHONE',
      field,
    });
  }
  return p;
}

/** "+201012345678" → "010 1234 5678": how a person reads and dials it. */
export function displayPhone(e164: string | null): string {
  if (!e164) return '';
  const local = `0${e164.slice(3)}`;
  return `${local.slice(0, 3)} ${local.slice(3, 7)} ${local.slice(7)}`;
}
