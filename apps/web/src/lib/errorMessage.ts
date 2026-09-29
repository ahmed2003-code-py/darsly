import i18n from '../i18n';

/**
 * The one place the web decides what a failure means and how to say it.
 *
 * Read docs/ERRORS.md for the whole contract. The rule this module exists to
 * enforce: **the server's own English sentence is never shown to a reader.**
 * The API sends a stable `code`; this module turns it into a sentence in the
 * reader's language. Components never interpret HTTP statuses themselves.
 *
 * Resolution order, first hit wins:
 *
 *  1. not an HTTP answer at all → cancelled (silent), timeout, offline, network,
 *                                  or a bug in our own code
 *  2. `code`                    → its own copy (explicit map, else derived key)
 *  3. a validation failure      → "check the fields" + the count
 *  4. an Arabic `message`       → the API wrote this one for a person; trust it
 *  5. 429                       → "too many attempts", with the wait if known
 *  6. the HTTP status           → a per-status floor sentence
 *  7. nothing recognisable      → the generic apology
 *
 * An unexpected failure (a 5xx the API did not name) ends with a short
 * reference — the first 8 characters of the request id — so support can find
 * the exact server log line. Ordinary refusals never carry one.
 */

/** Shape of what the API puts in a 4xx/5xx body (see apps/api/src/common/errors/api-error.ts). */
interface ApiErrorBody {
  message?: unknown;
  code?: unknown;
  field?: unknown;
  fields?: unknown;
  retryable?: unknown;
  requestId?: unknown;
  retryAfterSeconds?: unknown;
  /** Extra detail some refusals carry, used by the copy that asks for a count. */
  mediaIds?: unknown;
  invalid?: unknown;
  /** Values the sentence needs ("«exam.pdf» is 62 MB; the maximum is 40"). */
  params?: unknown;
}

/**
 * What kind of failure this was — the axis presentation decides on.
 *
 *  - `canceled`: we aborted it ourselves; say nothing.
 *  - `offline` / `network` / `timeout`: the request never got an answer —
 *    the work may or may not have happened; retrying is the user's call.
 *  - `unauthenticated`: the session is gone; the sign-in screen is the message.
 *  - `forbidden` / `notFound`: a page-level state, usually.
 *  - `rateLimited`: slow down; `retryAfterSeconds` says for how long.
 *  - `validation`: something in the form; `fieldErrors()` says what.
 *  - `refused`: a business rule said no; the code says which.
 *  - `server`: our fault; `requestId` finds it.
 *  - `client`: an exception in our own code, not a response at all.
 */
export type ErrorKind =
  | 'canceled'
  | 'offline'
  | 'network'
  | 'timeout'
  | 'unauthenticated'
  | 'forbidden'
  | 'notFound'
  | 'rateLimited'
  | 'validation'
  | 'refused'
  | 'server'
  | 'client';

export interface ResolvedError {
  /** What to show. Always localized, always written for a reader. Empty = show nothing. */
  message: string;
  /** Present only when the API named the refusal — useful for `data-*` hooks and tests. */
  code: string | null;
  status: number | null;
  /** True when the sentence came from a floor rather than from copy written for this refusal. */
  generic: boolean;
  kind: ErrorKind;
  /** Whether trying the same thing again, unchanged, can work. Drives Retry buttons. */
  retryable: boolean;
  /** The server's id for this request, when it answered. */
  requestId: string | null;
  /** The single input this refusal is about, when the API named one. */
  field: string | null;
  /** 429 only. */
  retryAfterSeconds: number | null;
}

/**
 * The handful of codes whose wording predates the derived-key convention
 * below and cannot be produced from the code alone.
 */
const EXPLICIT: Record<string, string> = {
  MEDIA_NOT_READY: 'err.mediaNotReady',
  HTML_LOCKED: 'err.htmlLocked',
  NO_HAND_AUTHORED_HTML: 'err.noHandAuthored',
  ENROLLMENT_ACTIVE: 'err.enrollmentActive',
  MESSAGING_CLOSED: 'err.messagingClosed',
  COURSE_OTHER_YEAR: 'err.courseOtherYear',
};

/**
 * Codes that only restate the HTTP status (the API's GENERIC_CODE). They have
 * no copy of their own on purpose: the per-status sentence is the answer.
 */
const GENERIC = new Set([
  'BAD_REQUEST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'CONFLICT',
  'GONE',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'UNPROCESSABLE',
  'RATE_LIMITED',
  'UPSTREAM_ERROR',
  'SERVICE_UNAVAILABLE',
  'UPSTREAM_TIMEOUT',
  'VALIDATION_FAILED',
]);

/** `BAD_REMEDIAL_LESSON` → `err.eBadRemedialLesson`. A new code is translated
 *  by adding one string, never by also remembering to edit a map. */
function keyForCode(code: string): string {
  return `err.e${code
    .toLowerCase()
    .replace(/_(.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^(.)/, (_, c: string) => c.toUpperCase())}`;
}

const STATUS_KEY: Record<number, string> = {
  400: 'err.status.badRequest',
  401: 'err.status.unauthorized',
  403: 'err.status.forbidden',
  404: 'err.status.notFound',
  409: 'err.status.conflict',
  410: 'err.status.notFound',
  413: 'err.status.tooLarge',
  415: 'err.status.unsupportedType',
  422: 'err.status.unprocessable',
  429: 'err.status.tooMany',
};

function statusKey(status: number): string {
  return STATUS_KEY[status] ?? (status >= 500 ? 'err.status.server' : 'err.unknown');
}

function kindOf(status: number, code: string | null): ErrorKind {
  if (code === 'VALIDATION_FAILED') return 'validation';
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404 || status === 410) return code && !GENERIC.has(code) ? 'refused' : 'notFound';
  if (status === 429) return 'rateLimited';
  if (status >= 500) return 'server';
  return 'refused';
}

/**
 * Does this sentence already belong to the reader's language?
 *
 * Some refusals are written in Arabic in the API already ("الرابط مستخدم
 * بالفعل"). Those are real copy and showing them is better than falling back to
 * a status sentence, so they are detected by script rather than by maintaining a
 * second list of which messages happen to be translated.
 */
function isArabic(text: string): boolean {
  return /[؀-ۿ]/.test(text);
}

function translate(
  key: string,
  count: number,
  params: Record<string, unknown> = {},
): string | null {
  const out = i18n.t(key, { count, ...params, defaultValue: '' });
  return typeof out === 'string' && out ? out : null;
}

/** First 8 characters of the request id, upper-cased: short enough to read out. */
export function referenceOf(requestId: string | null): string | null {
  if (!requestId) return null;
  const compact = requestId.replace(/[^A-Za-z0-9]/g, '');
  return compact ? compact.slice(0, 8).toUpperCase() : null;
}

function withReference(message: string, requestId: string | null): string {
  const ref = referenceOf(requestId);
  const line = ref ? translate('err.reference', 0, { ref }) : null;
  return line ? `${message} ${line}` : message;
}

function rateLimitSentence(seconds: number | null): string | null {
  if (!seconds || seconds <= 0) return translate('err.status.tooMany', 0);
  if (seconds <= 90) return translate('err.rateLimitedSeconds', 0, { seconds });
  return translate('err.rateLimitedMinutes', 0, { minutes: Math.ceil(seconds / 60) });
}

function headerOf(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null;
  const h = headers as Record<string, unknown> & { get?: (n: string) => unknown };
  const v = typeof h.get === 'function' ? h.get(name) : (h[name] ?? h[name.toLowerCase()]);
  return typeof v === 'string' && v ? v : null;
}

export function resolveError(error: unknown): ResolvedError {
  const base: ResolvedError = {
    message: '',
    code: null,
    status: null,
    generic: true,
    kind: 'client',
    retryable: false,
    requestId: null,
    field: null,
    retryAfterSeconds: null,
  };
  if (!error) return base;

  const err = error as {
    response?: { status?: number; data?: ApiErrorBody; headers?: unknown };
    message?: string;
    code?: string;
    name?: string;
    isAxiosError?: boolean;
    __CANCEL__?: boolean;
  };

  // 1. Not an HTTP answer.
  if (!err.response) {
    // We aborted it (navigated away, replaced the upload). Nothing to say.
    if (err.code === 'ERR_CANCELED' || err.name === 'CanceledError' || err.__CANCEL__) {
      return { ...base, kind: 'canceled' };
    }
    if (err.isAxiosError || err.code === 'ERR_NETWORK') {
      if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
        return {
          ...base,
          kind: 'timeout',
          retryable: true,
          message: translate('err.timeout', 0) ?? '',
        };
      }
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      return {
        ...base,
        kind: offline ? 'offline' : 'network',
        retryable: true,
        message: translate(offline ? 'err.offline' : 'err.network', 0) ?? '',
      };
    }
    // An exception thrown by our own code (a mutationFn that failed before
    // any request). Never "check your connection" — that would be a lie.
    return { ...base, kind: 'client', message: translate('err.unknown', 0) ?? '' };
  }

  const status = typeof err.response.status === 'number' ? err.response.status : 0;
  const data: ApiErrorBody = err.response.data ?? {};
  const rawCode = typeof data.code === 'string' ? data.code : null;
  const requestId =
    (typeof data.requestId === 'string' && data.requestId) ||
    headerOf(err.response.headers, 'x-request-id');
  const retryAfter =
    typeof data.retryAfterSeconds === 'number'
      ? data.retryAfterSeconds
      : Number(headerOf(err.response.headers, 'retry-after')) || null;
  const resolved: ResolvedError = {
    ...base,
    code: rawCode,
    status,
    kind: kindOf(status, rawCode),
    retryable:
      typeof data.retryable === 'boolean' ? data.retryable : status === 429 || status >= 500,
    requestId: requestId || null,
    field: typeof data.field === 'string' ? data.field : null,
    retryAfterSeconds: status === 429 ? retryAfter : null,
  };

  // 2. The API named the refusal.
  const detail = Array.isArray(data.mediaIds)
    ? data.mediaIds.length
    : Array.isArray(data.invalid)
      ? data.invalid.length
      : 0;
  if (rawCode && !GENERIC.has(rawCode)) {
    const params =
      data.params && typeof data.params === 'object'
        ? (data.params as Record<string, unknown>)
        : {};
    const named = translate(EXPLICIT[rawCode] ?? keyForCode(rawCode), detail, params);
    if (named) {
      const message =
        rawCode === 'INTERNAL_ERROR' ? withReference(named, resolved.requestId) : named;
      return { ...resolved, message, generic: false };
    }
  }

  // 3. A validation failure: the count here, the fields from fieldErrors().
  const fieldList = Array.isArray(data.fields)
    ? data.fields
    : Array.isArray(data.message)
      ? data.message
      : null;
  if (fieldList && (rawCode === 'VALIDATION_FAILED' || Array.isArray(data.message))) {
    const fields = translate('err.validation', fieldList.length);
    if (fields) return { ...resolved, kind: 'validation', message: fields, generic: false };
  }

  // 4. Copy the API already wrote for a person, in their language.
  const raw = typeof data.message === 'string' ? data.message.trim() : '';
  if (raw && isArabic(raw)) return { ...resolved, message: raw, generic: false };

  // 5. Too many requests, with the wait when the API said.
  if (status === 429) {
    const wait = rateLimitSentence(resolved.retryAfterSeconds);
    if (wait) return { ...resolved, message: wait };
  }

  // 6. The floor: every status says something true and useful.
  if (status) {
    const byStatus = translate(statusKey(status), detail);
    if (byStatus) {
      const unexpected = status >= 500 && (!rawCode || rawCode === 'INTERNAL_ERROR');
      return {
        ...resolved,
        message: unexpected ? withReference(byStatus, resolved.requestId) : byStatus,
      };
    }
  }

  // 7.
  return { ...resolved, message: translate('err.unknown', 0) ?? '' };
}

export interface FieldError {
  message: string;
  code: string | null;
  params: Record<string, unknown>;
}

function fieldMessage(code: string, params: Record<string, unknown>): string {
  return (
    translate(`err.field.${code}`, 0, params) ??
    translate(EXPLICIT[code] ?? keyForCode(code), 0, params) ??
    translate('err.fieldInvalid', 0) ??
    ''
  );
}

/**
 * The refusals that belong to one field each, keyed by the field's name.
 *
 * A form that knows which field was wrong can mark it; a sentence at the
 * bottom of the page cannot. Three shapes are read:
 *
 *  - `fields: [{ field, code, params }]` — the validation pipe, or an endpoint
 *    that checked every field (field codes use `err.field.*`, domain codes
 *    their own `err.e*` copy);
 *  - `field` on a single refusal — a business rule about one input
 *    (`PHONE_IN_USE` on `phone`), shown with that refusal's own sentence;
 *  - class-validator's legacy string list, where only the field is taken.
 */
export function fieldErrors(error: unknown): Record<string, FieldError> {
  const data = (error as { response?: { data?: ApiErrorBody } } | null)?.response?.data;
  const out: Record<string, FieldError> = {};
  if (!data) return out;
  if (Array.isArray(data.fields)) {
    for (const f of data.fields as { field?: unknown; code?: unknown; params?: unknown }[]) {
      if (!f || typeof f.field !== 'string' || typeof f.code !== 'string') continue;
      const params =
        f.params && typeof f.params === 'object' ? (f.params as Record<string, unknown>) : {};
      out[f.field] ??= { message: fieldMessage(f.code, params), code: f.code, params };
    }
  } else if (typeof data.field === 'string' && typeof data.code === 'string') {
    const params =
      data.params && typeof data.params === 'object'
        ? (data.params as Record<string, unknown>)
        : {};
    out[data.field] = { message: resolveError(error).message, code: data.code, params };
  } else if (Array.isArray(data.message)) {
    for (const m of data.message) {
      if (typeof m !== 'string') continue;
      const field = m.split(/\s/)[0];
      if (field)
        out[field] ??= { message: translate('err.fieldInvalid', 0) ?? '', code: null, params: {} };
    }
  }
  return out;
}

/**
 * Split an error between a form's own fields and whatever is left over.
 *
 * `fields` are the messages to put under the inputs the form actually has;
 * `rest` is the sentence for the form-level note, or null when every complaint
 * already sits under its field — so the same problem is never said twice.
 */
export function splitFormError(
  error: unknown,
  formFields: readonly string[],
): { fields: Record<string, string>; rest: string | null } {
  if (!error) return { fields: {}, rest: null };
  const all = fieldErrors(error);
  const fields: Record<string, string> = {};
  let unplaced = false;
  for (const [name, fe] of Object.entries(all)) {
    if (formFields.includes(name)) fields[name] = fe.message;
    else unplaced = true;
  }
  const placedSomething = Object.keys(fields).length > 0;
  return { fields, rest: placedSomething && !unplaced ? null : errorMessage(error) || null };
}

/** The sentence only — for the many call sites that just need a string. */
export function errorMessage(error: unknown): string {
  return resolveError(error).message;
}
