export type AiErrorClass = 'RETRYABLE' | 'TERMINAL';

/**
 * Error carrying a retry classification. The worker retries RETRYABLE failures
 * (timeouts, 5xx, transient network) up to a cap and gives up immediately on
 * TERMINAL ones (budget exceeded, invalid input, feature disabled) so we never
 * loop on a spend/validation error.
 */
export class AiJobError extends Error {
  constructor(
    message: string,
    readonly errorClass: AiErrorClass = 'RETRYABLE',
  ) {
    super(message);
    this.name = 'AiJobError';
  }
}
