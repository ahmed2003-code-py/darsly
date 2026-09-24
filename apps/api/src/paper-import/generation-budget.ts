import { AiPrice } from '../academy-site/ai/ai.client';

/**
 * What writing one exam may still spend, with room held for calls in flight.
 *
 * Millicents throughout, the unit AiClient meters in. A call reserves its
 * worst case before it starts and settles to what it actually cost when it
 * returns, so calls running side by side cannot each see the same remaining
 * budget and overrun it together.
 *
 * This is the application's own accounting. It bounds what we choose to
 * start; it is not a statement about the provider's invoice.
 */
export class GenerationBudget {
  private spent = 0;
  private held = 0;

  constructor(readonly limitMillicents: number) {}

  get spentMillicents(): number {
    return this.spent;
  }

  /** What is left once everything in flight is assumed to cost its worst. */
  get remainingMillicents(): number {
    return Math.max(0, this.limitMillicents - this.spent - this.held);
  }

  /** Room for one call, or null when it could take the run past the limit. */
  reserve(worstMillicents: number): { amount: number } | null {
    const amount = Math.max(0, Math.ceil(worstMillicents));
    if (this.spent + this.held + amount > this.limitMillicents) return null;
    this.held += amount;
    return { amount };
  }

  /** The call came back: release what it held, count what it cost. */
  settle(reservation: { amount: number }, actualMillicents: number): void {
    this.held = Math.max(0, this.held - reservation.amount);
    this.spent += Math.max(0, actualMillicents);
  }
}

/** The most one call can cost: its input estimate and its entire output
 *  ceiling (reasoning tokens are billed inside it). */
export function worstCaseMillicents(
  inputTokens: number,
  maxOutputTokens: number,
  price: AiPrice,
): number {
  return Math.ceil(
    ((inputTokens / 1_000_000) * price.inPerMToken +
      (maxOutputTokens / 1_000_000) * price.outPerMToken) *
      1000,
  );
}
