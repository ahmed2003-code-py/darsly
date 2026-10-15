import type { ProviderFailureKind } from './provider-failure';

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
    /**
     * What the provider reported having billed, when a response arrived and
     * was then rejected — a truncated or malformed answer costs the same as a
     * good one. Absent when no response came back at all.
     */
    readonly usage?: { inputTokens: number; outputTokens: number },
    /**
     * Wait this long before the queue tries again (delayed backoff). Absent:
     * the retry is claimable at once, which is what every existing caller gets.
     */
    readonly retryAfterMs?: number,
    /**
     * What kind of provider failure this was (provider-failure.ts), when it
     * came from a provider: lets a caller say "the AI service is unavailable"
     * instead of showing the provider's own words, and stop instead of retrying
     * an account that cannot be served.
     */
    readonly providerKind?: ProviderFailureKind,
  ) {
    super(message);
    this.name = 'AiJobError';
  }
}
