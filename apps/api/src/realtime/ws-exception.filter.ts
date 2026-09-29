import { ArgumentsHost, Catch, HttpException, Logger } from '@nestjs/common';
import { BaseWsExceptionFilter, WsException } from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { defaultRetryable, genericCode } from '../common/errors/api-error';

/**
 * The gateway's version of ApiExceptionFilter — Nest never applies global
 * filters to WebSocket handlers.
 *
 * Without it, a refusal thrown by ChatService from a socket event (messaging
 * closed, message too long) reached the client as `{ status: 'error',
 * message: 'Internal server error' }` and was logged as an error with a stack,
 * so an ordinary "you can't write here" looked like a crash on both ends.
 *
 * Emits the same `exception` event Nest does, with the same `code` / `message`
 * / `retryable` an HTTP caller gets. Only unexpected failures are logged as
 * errors; refusals are the caller's business.
 */
@Catch()
export class WsExceptionFilter extends BaseWsExceptionFilter {
  private readonly logger = new Logger('WsError');

  catch(exception: unknown, host: ArgumentsHost): void {
    const client = host.switchToWs().getClient<Socket>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      const obj = typeof raw === 'string' ? { message: raw } : (raw as Record<string, unknown>);
      client.emit('exception', {
        status: 'error',
        code: typeof obj.code === 'string' ? obj.code : genericCode(status),
        message: typeof obj.message === 'string' ? obj.message : 'Request refused',
        retryable: defaultRetryable(status),
      });
      if (status >= 500) this.logger.error(`ws ${status}: ${exception.message}`, exception.stack);
      return;
    }
    if (exception instanceof WsException) return super.catch(exception, host);
    const err = exception as Error;
    this.logger.error(`ws unexpected: ${err?.message ?? String(exception)}`, err?.stack);
    client.emit('exception', {
      status: 'error',
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      retryable: true,
    });
  }
}
