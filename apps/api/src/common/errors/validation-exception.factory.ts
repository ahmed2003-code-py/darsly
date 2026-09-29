import { BadRequestException } from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import type { ErrorInput, FieldIssue } from './api-error';

/**
 * class-validator's output, turned into something a form can use.
 *
 * Nest's default answer to a bad DTO is `message: string[]` — English sentences
 * written for a developer ("name must be longer than or equal to 2
 * characters"). The web could only count them, and could only guess the field
 * from the first word. This answers with the same 400, but as
 *
 *   { code: 'VALIDATION_FAILED', fields: [{ field: 'phone', code: 'INVALID_PHONE' }] }
 *
 * so each field gets its own localized sentence under the right input. The
 * raw constraint text is never sent: it is internal vocabulary, and custom
 * `@Matches` messages sometimes spell out the regex being enforced.
 */

/** constraint name → field code. Anything unlisted is `INVALID`. */
const CONSTRAINT_CODE: Record<string, string> = {
  isNotEmpty: 'REQUIRED',
  isDefined: 'REQUIRED',
  arrayNotEmpty: 'REQUIRED',
  maxLength: 'TOO_LONG',
  minLength: 'TOO_SHORT',
  isEmail: 'INVALID_EMAIL',
  isPhoneNumber: 'INVALID_PHONE',
  isMobilePhone: 'INVALID_PHONE',
  min: 'TOO_SMALL',
  max: 'TOO_LARGE',
  isInt: 'NOT_A_NUMBER',
  isNumber: 'NOT_A_NUMBER',
  isNumberString: 'NOT_A_NUMBER',
  isPositive: 'TOO_SMALL',
  isEnum: 'INVALID_CHOICE',
  isIn: 'INVALID_CHOICE',
  isDateString: 'INVALID_DATE',
  isDate: 'INVALID_DATE',
  isISO8601: 'INVALID_DATE',
  isUrl: 'INVALID_URL',
  arrayMaxSize: 'TOO_MANY',
  arrayMinSize: 'TOO_FEW',
  whitelistValidation: 'UNKNOWN_FIELD',
};

/** Which constraints carry a number the sentence should repeat, and under what name. */
const LIMIT_PARAM: Record<string, string> = {
  maxLength: 'max',
  minLength: 'min',
  min: 'min',
  max: 'max',
  arrayMaxSize: 'max',
  arrayMinSize: 'min',
};

/** A field whose free-form `@Matches` is, in practice, a phone format check. */
const PHONE_FIELD = /phone|mobile|wallet(number)?$/i;
/** A password's `@Matches` is the strength rule. */
const PASSWORD_FIELD = /password$/i;

function issuesOf(errors: ValidationError[], prefix = ''): FieldIssue[] {
  const out: FieldIssue[] = [];
  for (const e of errors) {
    const field = prefix ? `${prefix}.${e.property}` : e.property;
    const constraints = e.constraints ?? {};
    // Most useful first: "required" beats "too short" for an empty value.
    const names = Object.keys(constraints).sort(
      (a, b) =>
        Number(CONSTRAINT_CODE[b] === 'REQUIRED') - Number(CONSTRAINT_CODE[a] === 'REQUIRED'),
    );
    const name = names[0];
    if (name) {
      let code = CONSTRAINT_CODE[name] ?? 'INVALID';
      if (code === 'INVALID' && name === 'matches' && PHONE_FIELD.test(e.property)) {
        code = 'INVALID_PHONE';
      } else if (code === 'INVALID' && name === 'matches' && PASSWORD_FIELD.test(e.property)) {
        // Every password @Matches is the strength rule (PASSWORD_REGEX).
        code = 'WEAK_PASSWORD';
      }
      const issue: FieldIssue = { field, code };
      const param = LIMIT_PARAM[name];
      const n = param ? Number(/(-?\d+(?:\.\d+)?)/.exec(constraints[name])?.[1]) : NaN;
      if (param && Number.isFinite(n)) issue.params = { [param]: n };
      out.push(issue);
    }
    if (e.children?.length) out.push(...issuesOf(e.children, field));
  }
  return out;
}

export function validationExceptionFactory(errors: ValidationError[]): BadRequestException {
  const fields = issuesOf(errors);
  const body: ErrorInput & { fields: FieldIssue[] } = {
    code: 'VALIDATION_FAILED',
    message: `Invalid input: ${fields.map((f) => `${f.field} (${f.code})`).join(', ')}`,
    fields,
  };
  return new BadRequestException(body);
}

/** The pipe options every entry point uses — main.ts and the e2e harness alike. */
export const VALIDATION_PIPE_OPTIONS = {
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  exceptionFactory: validationExceptionFactory,
} as const;
