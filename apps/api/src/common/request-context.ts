import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Which request is this line about?
 *
 * Across 60 controllers and several Railway replicas fanning out over Redis,
 * a production error could not be tied back to the request that caused it.
 * Every log line stood alone: a stack trace, no way to find the three lines
 * before it, and no way to tell two users' concurrent failures apart.
 *
 * `AsyncLocalStorage` is a Node builtin — no dependency — and it carries the
 * id through `await`s, Prisma calls and Promise.all without a single function
 * signature changing to pass it along. That last part is why it is worth
 * doing: a correlation id threaded by hand reaches the places someone
 * remembered, which are never the places that break.
 *
 * The id is echoed back as `X-Request-Id`, so a user reporting a failure can
 * read it off their network tab and it can be found in the logs directly.
 * An inbound `X-Request-Id` is honoured when it looks sane, which is what lets
 * a trace survive the edge — but it is length-capped and character-filtered
 * first, because it ends up in log lines and a header nobody sanitised is how
 * newline injection gets into a log file.
 */
export interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** The id of the request being handled, or null outside one (a worker tick, boot). */
export function currentRequestId(): string | null {
  return storage.getStore()?.requestId ?? null;
}

/** Ids we are willing to repeat into a log line. */
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.headers['x-request-id'];
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
  const requestId = candidate && SAFE_ID.test(candidate) ? candidate : randomUUID();

  res.setHeader('X-Request-Id', requestId);
  storage.run({ requestId }, () => next());
}
