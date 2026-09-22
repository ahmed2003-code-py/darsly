import { ConsoleLogger, LogLevel } from '@nestjs/common';
import { currentRequestId } from './request-context';

/**
 * Nest's logger, with the request id attached and — in production — a shape a
 * log tool can read.
 *
 * Two different readers, two different formats, and pretending otherwise
 * serves neither. In development a person is watching a terminal, so the
 * coloured single line Nest already prints is the right answer and is kept
 * exactly. In production a machine is ingesting it, and a JSON object with a
 * `requestId` field is the difference between grepping and querying.
 *
 * Extending `ConsoleLogger` rather than adding pino or winston: the only thing
 * missing was the id and the shape, and both are a few lines. A logging
 * framework would also mean routing every existing `Logger` call in 37 files
 * through something new.
 */
export class AppLogger extends ConsoleLogger {
  private readonly asJson = process.env.NODE_ENV === 'production';

  protected printMessages(
    messages: unknown[],
    context = '',
    logLevel: LogLevel = 'log',
    writeStreamType?: 'stdout' | 'stderr',
  ): void {
    if (!this.asJson) {
      // Development: Nest's own format, with the id appended so a local
      // reproduction can be followed too. Absent outside a request (a worker
      // tick, boot) rather than faked.
      const id = currentRequestId();
      super.printMessages(id ? messages.map((m) => `${String(m)} [req:${id}]`) : messages, context, logLevel, writeStreamType);
      return;
    }

    for (const message of messages) {
      const line = JSON.stringify({
        level: logLevel,
        time: new Date().toISOString(),
        context: context || undefined,
        requestId: currentRequestId() ?? undefined,
        message: typeof message === 'string' ? message : safeSerialize(message),
      });
      process[logLevel === 'error' || logLevel === 'fatal' ? 'stderr' : 'stdout'].write(`${line}\n`);
    }
  }
}

/** A log line must never be the thing that throws. */
function safeSerialize(value: unknown): string {
  try {
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  } catch {
    return String(value);
  }
}
