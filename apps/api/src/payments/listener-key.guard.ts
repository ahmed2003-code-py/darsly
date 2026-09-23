import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'crypto';

/**
 * The legacy shared key for `POST /payment-events`, checked before anything
 * else touches the request.
 *
 * It used to be checked inside the handler, which put it *after* the global
 * ValidationPipe — so an unauthenticated caller with a malformed body was
 * answered with the endpoint's full DTO schema ("provider must be one of
 * INSTAPAY, VODAFONE_CASH, …") and never reached the key check at all. Small
 * disclosure, but on a money endpoint the order is wrong on principle: a
 * caller who cannot authenticate should not be able to make the server parse
 * and describe its input. Nest runs guards before pipes, so moving the check
 * here fixes the ordering without changing what it checks.
 *
 * ── On the shared key itself ──────────────────────────────────────────────
 *
 * This endpoint is the *legacy* ingest path, and `.env.example` has said so
 * for a while: "legacy shared secret for POST /payment-events (simulator /
 * back-compat)". The current path is `POST /device/sms-events`, which
 * authenticates a per-device JWT through `DeviceAuthGuard`, checks the
 * `ListenerDevice` row is still registered, and can be revoked for one device
 * without touching any other. That is the per-device credential model, and it
 * already exists and is deployed.
 *
 * `PAYMENT_LISTENER_KEY` is **not set in production** (verified 2026-09-23), so
 * this route answers 503 to everyone and the shared-key risk is not live. The
 * guard keeps that property explicit rather than incidental, and logs loudly
 * whenever the legacy key *is* accepted — so if the variable is ever set, there
 * is evidence of who is still using it and therefore of when it can be deleted.
 */
@Injectable()
export class ListenerKeyGuard implements CanActivate {
  private readonly logger = new Logger(ListenerKeyGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const expected = process.env.PAYMENT_LISTENER_KEY;

    // Unset means "this path is closed", not "let everyone in".
    if (!expected) {
      throw new ServiceUnavailableException({
        message: 'Listener not configured',
        code: 'LISTENER_UNSET',
      });
    }

    // Compared as bytes, because that is what timingSafeEqual measures. An
    // earlier version compared string lengths, and a header of the same
    // character length but a different UTF-8 byte length ("…é") got past that
    // and made timingSafeEqual throw RangeError — a 500 where the answer is
    // 401. It failed closed either way, but an unauthenticated caller could
    // put noise in the error monitoring of a money endpoint at will.
    const raw = req.headers['x-listener-key'];
    const given = Buffer.from(typeof raw === 'string' ? raw : '', 'utf8');
    const want = Buffer.from(expected, 'utf8');
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      throw new UnauthorizedException('Invalid listener key');
    }

    // Every acceptance is recorded. This route is meant to be retired, and the
    // only honest way to know it is safe to delete is to see nothing arriving
    // on it.
    this.logger.warn(
      'legacy shared-key ingest accepted on /payment-events — device should migrate to POST /device/sms-events',
    );
    return true;
  }
}
