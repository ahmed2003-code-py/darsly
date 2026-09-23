import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';

/**
 * Database constraint violations, answered as refusals rather than crashes.
 *
 * A Prisma error that nobody catches is not an `HttpException`, so Nest's
 * default filter answers it with a bare 500. That is wrong in two ways at
 * once: the caller is told the server broke when in fact the server worked —
 * it refused — and a 500 is the one status a client cannot act on.
 *
 * This is not hypothetical here. `payments/manual-payments.service.ts:164-181`
 * records it happening on a payment endpoint: two simultaneous purchases of
 * one course, the unique index doing exactly its job, and the caller that lost
 * the race receiving `500` where the other received `201`. The money was never
 * wrong; the answer was. That call site now catches P2002 itself — and every
 * other place a constraint can fire still does not.
 *
 * ── What this filter deliberately does NOT do ──────────────────────────────
 *
 * It catches `PrismaClientKnownRequestError` and nothing else. That is a
 * structural guarantee, not a convention to remember: an `HttpException`
 * cannot reach this class, so all ~525 existing `throw new XException(...)`
 * sites, every guard rejection and every validation failure keep their exact
 * status and body. Adding this filter cannot change an answer the application
 * already had an opinion about.
 *
 * It also does not pre-empt the fourteen call sites that handle Prisma codes
 * themselves. Several of them treat P2002 as *success* — an idempotency
 * signal meaning "the row you were about to write is already there"
 * (`gamification/gamification.service.ts:150` returns an empty outcome,
 * `gamification/achievements.service.ts:56` moves to the next award). Those
 * catch before anything propagates, so this filter never sees them. It handles
 * only the ones that escape.
 *
 * ── Why the client is told so little ───────────────────────────────────────
 *
 * Prisma's message names the table and the columns it failed on ("Unique
 * constraint failed on the fields: (`studentId`,`courseId`)"). That is a
 * schema disclosure, and the audit's one unqualified compliment about this
 * codebase's error handling was that no driver detail reaches a caller. So the
 * full error — code, meta, stack — goes to the log, and the response carries a
 * neutral sentence plus a stable `code` the frontend can translate.
 *
 * The body shape is `{ message, code }`, matching the 220 refusals already
 * thrown that way. `apps/web/src/lib/errorMessage.ts` resolves `code` first
 * and falls back to a per-status sentence when a code has no copy yet
 * (`translate()` returns null on an empty `defaultValue`), so these codes
 * degrade to the right Arabic sentence without shipping a translation.
 */
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  /**
   * The codes worth translating, and why each lands where it does.
   *
   * Everything absent from this table is left as a 500 on purpose — see
   * `catch` below.
   */
  private static readonly MAPPED: Record<
    string,
    { status: number; code: string; message: string }
  > = {
    // Unique constraint. The row already exists, which is a conflict with the
    // current state of the resource, not a malformed request.
    P2002: {
      status: HttpStatus.CONFLICT,
      code: 'ALREADY_EXISTS',
      message: 'That already exists',
    },

    // Foreign key constraint. Prisma reports one code for two different
    // stories: a create/update naming a parent that does not exist, and a
    // delete of a row something else still points at. The error carries no
    // operation, so the two cannot be told apart here. 409 is the deliberate
    // choice — the delete case is the one that actually escapes uncaught in
    // this codebase, and "conflicts with the current state" is true of both
    // readings, where "malformed request" is only true of one.
    P2003: {
      status: HttpStatus.CONFLICT,
      code: 'RELATED_RECORD_CONFLICT',
      message: 'That is still linked to something else',
    },

    // An update or delete whose target was not found. This is the one that
    // was most obviously a 500 pretending to be a crash: asking to change a
    // row that is not there is an ordinary 404.
    P2025: {
      status: HttpStatus.NOT_FOUND,
      code: 'NOT_FOUND',
      message: 'Not found',
    },

    // Serialization failure / deadlock — Postgres 40001. The request was not
    // wrong and nothing is broken; two transactions touched the same rows and
    // the database aborted one. 503 with a retry is the honest answer, and it
    // matches how the call sites that already handle P2034 behave
    // (`payouts/payouts.service.ts:106` retries rather than failing).
    P2034: {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'WRITE_CONFLICT',
      message: 'The request collided with another; please try again',
    },
  };

  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const mapped = PrismaExceptionFilter.MAPPED[exception.code];

    if (!mapped) {
      // An unmapped code is a genuine surprise, and dressing it as a 4xx would
      // hide a real defect behind a tidy answer. It stays a 500 — but a logged
      // one, with the code and meta that make it diagnosable, which is more
      // than the default filter gave.
      this.logger.error(
        `Unhandled Prisma error ${exception.code}: ${exception.message}`,
        exception.stack,
      );
      response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        message: 'Internal server error',
        code: 'INTERNAL_ERROR',
      });
      return;
    }

    // Warn rather than error: this is a refusal the application understands.
    // The meta is the part worth having — it names the constraint that fired,
    // which is what turns "a 409 happened" into "this index fired".
    this.logger.warn(
      `Prisma ${exception.code} → ${mapped.status} ${mapped.code}` +
        (exception.meta ? ` ${JSON.stringify(exception.meta)}` : ''),
    );

    response.status(mapped.status).json({ message: mapped.message, code: mapped.code });
  }
}
