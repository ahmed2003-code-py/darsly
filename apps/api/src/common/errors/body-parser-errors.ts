import type { NextFunction, Request, Response } from 'express';
import { currentRequestId } from '../request-context';
import { genericCode } from './api-error';

/**
 * The body parsers run before Nest's router. Their failures are answered by
 * Nest's default handler, not ApiExceptionFilter — production answered a
 * malformed body with the parser's own text ("Unexpected end of JSON input")
 * and no code. Registered right after the parsers, this gives them the same
 * envelope as every other error. (ApiExceptionFilter maps the same errors too,
 * for any path where Nest does route them to it.)
 */
export function bodyParserErrors(
  err: { status?: number; statusCode?: number; type?: string } | undefined,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!err) return next();
  const status = Number(err.status ?? err.statusCode);
  if (!Number.isInteger(status) || status < 400 || status >= 500) return next(err);
  const code =
    err.type === 'entity.too.large'
      ? 'PAYLOAD_TOO_LARGE'
      : err.type === 'entity.parse.failed'
        ? 'MALFORMED_BODY'
        : genericCode(status);
  res.status(status).json({
    statusCode: status,
    code,
    message: code === 'PAYLOAD_TOO_LARGE' ? 'Request body too large' : 'Malformed request body',
    retryable: false,
    requestId: currentRequestId() ?? undefined,
  });
}
