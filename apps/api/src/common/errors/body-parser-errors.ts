import type { NextFunction, Request, Response } from 'express';
import { currentRequestId } from '../request-context';
import { genericCode } from './api-error';

/**
 * The body parsers run before Nest's router, so their failures never reach
 * `ApiExceptionFilter` — Express's default handler answered them with an HTML
 * page ("PayloadTooLargeError: request entity too large" and a stack in
 * development). A receipt photo just over the limit was the realistic case.
 * This gives them the same envelope as every other error.
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
