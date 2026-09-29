import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { currentRequestId } from '../request-context';
import { ApiErrorBody, FieldIssue, categoryOf, defaultRetryable, genericCode } from './api-error';

/**
 * Every error this API answers with passes through here, exactly once.
 *
 * Before this filter there were two answers to a failure: Nest's default
 * (`{ statusCode, message, error }`, a bare 500 for anything unexpected, no id
 * to find it by) and `PrismaExceptionFilter` for constraint violations. Around
 * 500 throw sites carried a `code` and ~400 carried only an English sentence,
 * so the web had to guess from the HTTP status — which is how a teacher adding
 * a guardian read "there is a conflict with existing data" for what was, in
 * fact, a phone number already registered to a student.
 *
 * What it guarantees, for every HTTP error:
 *
 *  - a stable `code` (the thrower's own, else the generic one for the status);
 *  - a safe English `message` — never a stack, driver text or table name;
 *  - `retryable`, so a client can decide whether a Retry button is honest;
 *  - `requestId`, which is also the id on the server's log line.
 *
 * What it deliberately does NOT change: the status of any HttpException, or
 * any key a thrower put in its body (`params`, `field`, `mediaIds`,
 * `balanceCents` …). A 404 thrown to hide that a resource exists stays a 404
 * with the same neutral words — see docs/ERRORS.md § Security.
 *
 * Logging follows the same line between expected and unexpected: a refusal is
 * one compact info line (status, code, route template, user) and a failure is
 * an error with its stack. Route templates are logged, not raw paths, so a
 * token or id in a URL never lands in a log.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpError');

  /**
   * Database constraint violations that escaped their service, and what each
   * honestly means to a caller. Anything absent stays a 500 — dressing an
   * unknown Prisma failure as a 4xx would hide a real defect.
   *
   * These are last-resort codes. A service that knows what a duplicate MEANS
   * (a guardian already linked, a slug taken) should catch P2002 itself and
   * throw its own code; "that already exists" is only true, never useful.
   */
  static readonly PRISMA: Record<string, { status: number; code: string; message: string }> = {
    // Unique constraint: the row already exists — a conflict, not bad input.
    P2002: { status: HttpStatus.CONFLICT, code: 'ALREADY_EXISTS', message: 'That already exists' },
    // Foreign key: a parent that is gone, or a delete something still points at.
    P2003: {
      status: HttpStatus.CONFLICT,
      code: 'RELATED_RECORD_CONFLICT',
      message: 'That is still linked to something else',
    },
    // Update/delete of a row that is not there: an ordinary 404.
    P2025: { status: HttpStatus.NOT_FOUND, code: 'NOT_FOUND', message: 'Not found' },
    // Serialization failure / deadlock: two writes collided; retrying is right.
    P2034: {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'WRITE_CONFLICT',
      message: 'The request collided with another; please try again',
    },
  };

  catch(exception: unknown, host: ArgumentsHost): void {
    // Gateways have their own filter (realtime/ws-exception.filter.ts); Nest
    // never routes a WebSocket error to a global filter. Nothing else here is
    // non-HTTP, so anything that does arrive is only logged.
    if (host.getType() !== 'http') {
      this.logger.error(`non-HTTP error reached the HTTP filter: ${String(exception)}`);
      return;
    }
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const body = this.bodyFor(exception, res);
    this.log(exception, body, req);
    if (res.headersSent) return;
    res.status(body.statusCode).json(body);
  }

  /** The response body for any thrown value. Exposed for tests. */
  bodyFor(exception: unknown, res?: Response): ApiErrorBody {
    const requestId = currentRequestId() ?? undefined;

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = ApiExceptionFilter.PRISMA[exception.code];
      if (mapped) {
        return {
          statusCode: mapped.status,
          code: mapped.code,
          message: mapped.message,
          retryable: defaultRetryable(mapped.status),
          requestId,
        };
      }
      return this.internal(requestId);
    }

    if (exception instanceof ThrottlerException) {
      const retryAfter = Number(res?.getHeader?.('Retry-After'));
      return {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: 'RATE_LIMITED',
        message: 'Too many requests — slow down and try again shortly',
        retryable: true,
        requestId,
        ...(Number.isFinite(retryAfter) && retryAfter > 0
          ? { retryAfterSeconds: Math.ceil(retryAfter) }
          : {}),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      const obj: Record<string, unknown> =
        typeof raw === 'string' ? { message: raw } : { ...(raw as Record<string, unknown>) };

      // Nest's own additions for string-argument exceptions: the reason phrase
      // ("Conflict") duplicates the status, and statusCode is re-set below.
      delete obj.error;
      delete obj.statusCode;

      // Another pipe's validation list (ParseIntPipe, a hand-built array) —
      // keep the fact that it was about input, drop the internal sentences.
      let fields = obj.fields as FieldIssue[] | undefined;
      if (Array.isArray(obj.message)) {
        fields ??= (obj.message as unknown[])
          .filter((m): m is string => typeof m === 'string')
          .map((m) => ({ field: m.split(/\s/)[0] ?? '', code: 'INVALID' }))
          .filter((f) => f.field);
        obj.message = 'Invalid input';
        obj.code ??= 'VALIDATION_FAILED';
      }

      const code = typeof obj.code === 'string' && obj.code ? obj.code : genericCode(status);
      const message =
        typeof obj.message === 'string' && obj.message ? obj.message : defaultMessage(status);

      return {
        ...obj,
        statusCode: status,
        code,
        message,
        retryable: typeof obj.retryable === 'boolean' ? obj.retryable : defaultRetryable(status),
        requestId,
        ...(fields && fields.length ? { fields } : {}),
      };
    }

    // Express/body-parser style errors that reached Nest (they carry a status
    // and a type, not an HttpException). Only the status is trusted.
    const statusLike = (exception as { status?: unknown; statusCode?: unknown }) ?? {};
    const s = Number(statusLike.status ?? statusLike.statusCode);
    if (Number.isInteger(s) && s >= 400 && s < 500) {
      return {
        statusCode: s,
        code: genericCode(s),
        message: defaultMessage(s),
        retryable: false,
        requestId,
      };
    }

    return this.internal(requestId);
  }

  private internal(requestId: string | undefined): ApiErrorBody {
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      retryable: true,
      requestId,
    };
  }

  private log(exception: unknown, body: ApiErrorBody, req: Request): void {
    const status = body.statusCode;
    // 401 is the everyday expiry of a 15-minute token; the client refreshes
    // and retries. Logging each one would drown the lines that matter.
    if (status === 401) return;
    // A 404 on a path no route matched is a scanner, not a user. A 404 from a
    // real route (a resource that is not there, or is hidden) is kept.
    const route = (req as Request & { route?: { path?: string } }).route?.path;
    if (status === 404 && !route) return;

    const user = (req as Request & { user?: { sub?: string } }).user?.sub;
    const academy = req.headers?.['x-academy-id'];
    const where =
      `${req.method} ${route ? `${req.baseUrl ?? ''}${route}` : redactPath(req.path ?? '')}` +
      (user ? ` user=${user}` : '') +
      (typeof academy === 'string' && /^[\w-]{1,40}$/.test(academy) ? ` academy=${academy}` : '');
    const line = `${status} ${body.code} [${categoryOf(status, body.code)}] ${where}`;

    if (status >= 500) {
      const err = exception as { name?: string; message?: string; stack?: string; code?: string };
      const detail =
        exception instanceof Prisma.PrismaClientKnownRequestError
          ? ` prisma=${exception.code} meta=${safeJson(exception.meta)}`
          : '';
      this.logger.error(
        `${line} — ${err?.name ?? 'Error'}: ${String(err?.message ?? exception).slice(0, 2000)}${detail}`,
        err?.stack,
      );
      return;
    }
    const prisma =
      exception instanceof Prisma.PrismaClientKnownRequestError
        ? ` prisma=${exception.code} meta=${safeJson(exception.meta)}`
        : '';
    if (status === 429) this.logger.warn(line);
    else this.logger.log(`${line}${prisma}`);
  }
}

function defaultMessage(status: number): string {
  if (status >= 500) return 'Internal server error';
  return (
    {
      400: 'Bad request',
      403: 'Forbidden',
      404: 'Not found',
      409: 'Conflict',
      413: 'Payload too large',
      415: 'Unsupported media type',
    }[status] ?? 'Request refused'
  );
}

/** An unmatched path, with anything that looks like an id or token shortened. */
function redactPath(path: string): string {
  return path
    .split('/')
    .map((seg) => (seg.length > 20 || /\d{4,}/.test(seg) ? ':x' : seg))
    .join('/')
    .slice(0, 200);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v ?? null).slice(0, 500);
  } catch {
    return 'unserializable';
  }
}
