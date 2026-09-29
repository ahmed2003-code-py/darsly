import { HttpStatus } from '@nestjs/common';

/**
 * The one shape every refusal and failure leaves this API in.
 *
 * Read docs/ERRORS.md before adding an error. The short version:
 *
 *   throw new ConflictException({
 *     code: 'PHONE_IN_USE',             // stable, SCREAMING_SNAKE, never renamed
 *     message: 'This phone number …',   // English fallback for logs/tools — never the UI copy
 *     field: 'phone',                   // optional: which input it is about
 *     params: { max: 10 },              // optional: numbers the sentence needs
 *   } satisfies ErrorInput);
 *
 * `ApiExceptionFilter` completes it on the way out — `statusCode`, `requestId`,
 * `retryable`, and a generic `code` for the refusals that were thrown without
 * one — so a caller can always rely on `code` and `message` being there.
 *
 * The envelope is flat (`{ code, message, … }`), not nested under `error`.
 * That is deliberate: ~500 throw sites, the web resolver and the Android
 * payment listener all already read `message`/`code` at the top level, and a
 * nested envelope would have broken every one of them to gain nothing.
 */
export interface ErrorInput {
  /** Stable machine-readable reason. The frontend keys its copy off this, never off `message`. */
  code: string;
  /** Safe English fallback: what a log reader or an API client sees. */
  message: string;
  /** The single input this refusal is about, when there is exactly one. */
  field?: string;
  /** Values the localized sentence needs (limits, sizes, names). Never internal ids or secrets. */
  params?: Record<string, string | number | boolean | null>;
  /**
   * Whether trying the same request again, unchanged, can succeed. Only set it
   * to override the default (5xx and 429 are retryable, everything else is not).
   */
  retryable?: boolean;
}

/** One field's complaint, in a validation failure. */
export interface FieldIssue {
  field: string;
  code: string;
  params?: Record<string, string | number>;
}

/** What actually goes over the wire. */
export interface ApiErrorBody {
  statusCode: number;
  code: string;
  message: string;
  retryable: boolean;
  /** Correlates with the server log line. Present on every error response. */
  requestId?: string;
  field?: string;
  fields?: FieldIssue[];
  params?: Record<string, unknown>;
  /** 429 only: seconds until the same request would be accepted. */
  retryAfterSeconds?: number;
  /** Legacy structured extras some refusals carry (mediaIds, balanceCents, …). */
  [extra: string]: unknown;
}

/**
 * The code a refusal gets when its thrower did not name one.
 *
 * These are the taxonomy's category codes. The frontend treats them as
 * "generic": it shows the per-status sentence for them rather than looking
 * for copy of their own. A refusal that deserves its own sentence must be
 * thrown with its own code — that is the whole point of the contract.
 */
export const GENERIC_CODE: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'BAD_REQUEST',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHENTICATED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.METHOD_NOT_ALLOWED]: 'METHOD_NOT_ALLOWED',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.GONE]: 'GONE',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'PAYLOAD_TOO_LARGE',
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: 'UNSUPPORTED_MEDIA_TYPE',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'UNPROCESSABLE',
  [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMITED',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'INTERNAL_ERROR',
  [HttpStatus.BAD_GATEWAY]: 'UPSTREAM_ERROR',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'SERVICE_UNAVAILABLE',
  [HttpStatus.GATEWAY_TIMEOUT]: 'UPSTREAM_TIMEOUT',
};

export function genericCode(status: number): string {
  return GENERIC_CODE[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
}

/**
 * The taxonomy, for logs and dashboards. Deliberately coarse: a category says
 * who has to act (the user, an admin, engineering), the code says what exactly.
 */
export type ErrorCategory =
  | 'VALIDATION'
  | 'AUTHENTICATION'
  | 'AUTHORIZATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMIT'
  | 'BUSINESS_RULE'
  | 'TEMPORARY_FAILURE'
  | 'INTERNAL';

export function categoryOf(status: number, code: string): ErrorCategory {
  if (code === 'VALIDATION_FAILED') return 'VALIDATION';
  if (status === 401) return 'AUTHENTICATION';
  if (status === 403) return 'AUTHORIZATION';
  if (status === 404 || status === 410) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 502 || status === 503 || status === 504) return 'TEMPORARY_FAILURE';
  if (status >= 500) return 'INTERNAL';
  return 'BUSINESS_RULE';
}

/** Retrying the same request can only help when the failure was not about the request. */
export function defaultRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}
