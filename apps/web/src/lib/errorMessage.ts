import i18n from '../i18n';

/**
 * One sentence a person can act on, for any failure the app can produce.
 *
 * The rule this module exists to enforce: **the server's own English sentence
 * is never shown to a reader.** Those sentences are written for a log — "You
 * are not assigned to this group", "Some students are not enrolled in this
 * academy" — and they were surfacing verbatim, in English, under a page that
 * is Arabic throughout. Three hundred of the API's refusals carry no `code` at
 * all, so a map of codes could never have covered them; what closes the gap is
 * a floor: every status has a sentence, so an untranslated refusal degrades to
 * "you don't have permission to do this" rather than to backend vocabulary.
 *
 * Resolution order, first hit wins:
 *
 *  1. no response at all        → a connection problem, not a refusal
 *  2. `code`                    → its own copy (explicit map, else derived key)
 *  3. a validation list         → "check the fields" + the count
 *  4. an Arabic `message`       → the API wrote this one for a person; trust it
 *  5. the HTTP status           → the floor described above
 *  6. nothing recognisable      → the generic apology
 */

/** Shape of what the API puts in a 4xx/5xx body. */
interface ApiErrorBody {
  message?: unknown;
  code?: unknown;
  /** Extra detail some refusals carry, used by the copy that asks for a count. */
  mediaIds?: unknown;
  invalid?: unknown;
}

export interface ResolvedError {
  /** What to show. Always localized, always written for a reader. */
  message: string;
  /** Present only when the API named the refusal — useful for `data-*` hooks and tests. */
  code: string | null;
  status: number | null;
  /** True when the sentence came from the status floor rather than from copy
   *  written for this particular refusal. Callers may use it to decide whether
   *  a refusal is worth a toast of its own. */
  generic: boolean;
}

/**
 * The handful of codes whose Arabic wording predates the derived-key convention
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
  413: 'err.status.tooLarge',
  415: 'err.status.unsupportedType',
  422: 'err.status.unprocessable',
  429: 'err.status.tooMany',
};

function statusKey(status: number): string {
  return STATUS_KEY[status] ?? (status >= 500 ? 'err.status.server' : 'err.unknown');
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
  return /[\u0600-\u06FF]/.test(text);
}

function translate(key: string, count: number): string | null {
  const out = i18n.t(key, { count, defaultValue: '' });
  return typeof out === 'string' && out ? out : null;
}

export function resolveError(error: unknown): ResolvedError {
  if (!error) return { message: '', code: null, status: null, generic: true };

  const err = error as {
    response?: { status?: number; data?: ApiErrorBody };
    message?: string;
    code?: string;
  };
  const status = typeof err.response?.status === 'number' ? err.response.status : null;
  const data = err.response?.data;
  const code = typeof data?.code === 'string' ? data.code : null;

  // 1. Nothing came back. A refusal has a status; this does not, so it is the
  //    network, a cancelled request or a server that never answered.
  if (!err.response) {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    return {
      message: translate(offline ? 'err.offline' : 'err.network', 0) ?? '',
      code: code ?? null,
      status: null,
      generic: true,
    };
  }

  // 2. The API named the refusal.
  const detail = Array.isArray(data?.mediaIds)
    ? data.mediaIds.length
    : Array.isArray(data?.invalid)
      ? data.invalid.length
      : 0;
  if (code) {
    const named = translate(EXPLICIT[code] ?? keyForCode(code), detail);
    if (named) return { message: named, code, status, generic: false };
  }

  // 3. class-validator hands back a list of field complaints, one per rule.
  //    Their wording is English and internal ("name must be longer than or
  //    equal to 2 characters"), so the count is used and the list is not.
  if (Array.isArray(data?.message)) {
    const fields = translate('err.validation', data.message.length);
    if (fields) return { message: fields, code, status, generic: false };
  }

  // 4. Copy the API already wrote for a person, in their language.
  const raw = typeof data?.message === 'string' ? data.message.trim() : '';
  if (raw && isArabic(raw)) return { message: raw, code, status, generic: false };

  // 5. The floor: every status says something true and useful.
  if (status) {
    const byStatus = translate(statusKey(status), detail);
    if (byStatus) return { message: byStatus, code, status, generic: true };
  }

  // 6.
  return { message: translate('err.unknown', 0) ?? '', code, status, generic: true };
}

/** The sentence only — for the many call sites that just need a string. */
export function errorMessage(error: unknown): string {
  return resolveError(error).message;
}
