import type { TFunction } from 'i18next';
import { resolveError } from './errorMessage';

/**
 * The sign-in family's wording for an auth refusal.
 *
 * The account-state codes keep their own copy under `auth.err.*` (written for
 * the sign-in screens). Everything else goes through the shared resolver in
 * errorMessage.ts — this used to fall back to the server's raw English
 * sentence, which put backend vocabulary on the most-visited screens.
 */
const CODE_KEYS: Record<string, string> = {
  ACCOUNT_PENDING_APPROVAL: 'auth.err.pending',
  ACCOUNT_LOCKED: 'auth.err.locked',
  ACCOUNT_SUSPENDED: 'auth.err.suspended',
  ACCOUNT_REJECTED: 'auth.err.rejected',
  EMAIL_TAKEN: 'auth.err.emailTaken',
  PHONE_TAKEN: 'auth.err.phoneTaken',
  WRONG_PASSWORD: 'auth.err.wrongPassword',
  INVALID_TOKEN: 'auth.err.invalidToken',
  TOKEN_EXPIRED: 'auth.err.tokenExpired',
  EMAIL_NOT_FOUND: 'auth.err.emailNotFound',
  INVALID_CODE: 'auth.err.invalidCode',
  CODE_EXPIRED: 'auth.err.codeExpired',
  TOO_MANY_ATTEMPTS: 'auth.err.tooManyAttempts',
  MAIL_DELIVERY_FAILED: 'auth.err.mailFailed',
  ACCOUNT_DISABLED: 'auth.err.suspended',
  INVALID_PHONE: 'auth.err.invalidPhone',
  INVALID_CREDENTIALS: 'auth.err.invalidCredentials',
};

export function authErrorText(err: any, t: TFunction): string {
  const data = err?.response?.data;
  const code = data?.code ?? data?.message?.code;
  if (code && CODE_KEYS[code]) return t(CODE_KEYS[code]);
  // A failure the form raised itself, before any request went out. It already
  // carries the sentence meant for the reader, so keep it.
  if (!err?.response && !err?.isAxiosError && typeof err?.message === 'string' && err.message)
    return err.message;
  const resolved = resolveError(err);
  // On these screens an unnamed 401 means the credentials, not an expired session.
  if (resolved.status === 401 && (!code || code === 'UNAUTHENTICATED'))
    return t('auth.err.invalidCredentials');
  return resolved.message || t('auth.err.generic');
}
