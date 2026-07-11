import type { TFunction } from 'i18next';

/**
 * Map a backend auth error into a localized message. The API returns either a
 * structured `{ message, code }` payload or class-validator's `message: string[]`.
 * We key off `code` where present, else fall back to the raw server message.
 */
const CODE_KEYS: Record<string, string> = {
  ACCOUNT_PENDING_APPROVAL: 'auth.err.pending',
  ACCOUNT_LOCKED: 'auth.err.locked',
  ACCOUNT_SUSPENDED: 'auth.err.suspended',
  ACCOUNT_REJECTED: 'auth.err.rejected',
  EMAIL_TAKEN: 'auth.err.emailTaken',
  PHONE_TAKEN: 'auth.err.phoneTaken',
  INVALID_TOKEN: 'auth.err.invalidToken',
  TOKEN_EXPIRED: 'auth.err.tokenExpired',
};

export function authErrorText(err: any, t: TFunction): string {
  const data = err?.response?.data;
  const status = err?.response?.status;
  const code = data?.code ?? data?.message?.code;
  if (code && CODE_KEYS[code]) return t(CODE_KEYS[code]);
  if (status === 401) return t('auth.err.invalidCredentials');
  if (status === 429) return t('auth.err.rateLimited');
  const msg = data?.message;
  if (Array.isArray(msg)) return String(msg[0]);
  if (typeof msg === 'string') return msg;
  return t('auth.err.generic');
}
