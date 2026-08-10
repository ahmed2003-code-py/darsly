import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { XPayConfig } from './xpay.config';

/**
 * The HTTP surface of XPay, kept to the endpoints their API reference actually
 * documents: checkout sessions and refunds.
 *
 * Everything the platform does goes through here, so when the request shape is
 * confirmed against the dashboard there is one file to correct rather than a
 * call site in every service.
 *
 * The secret key is read from config, used only to build a header, and never
 * logged: `redact()` strips anything key-shaped out of provider errors before
 * they reach a log line or an API response.
 */

export interface CheckoutSession {
  id: string;
  /** Where the student is sent to pay. */
  url?: string;
  status?: string;
  [k: string]: unknown;
}

@Injectable()
export class XPayClient {
  private readonly logger = new Logger(XPayClient.name);

  constructor(private readonly config: XPayConfig) {}

  /**
   * Create a hosted checkout session.
   *
   * `reference` is our own Payment id. It comes back on the webhook, and it is
   * what ties an XPay event to a row in our database — matching on amount or
   * on a customer would be ambiguous the moment two students buy the same
   * course in the same minute.
   */
  createCheckoutSession(input: {
    amountCents: number;
    currency: string;
    reference: string;
    description: string;
    customer: { name?: string; email?: string };
  }): Promise<CheckoutSession> {
    return this.post<CheckoutSession>('/checkout-sessions', {
      amount: input.amountCents,
      currency: input.currency,
      reference: input.reference,
      description: input.description,
      customer: input.customer,
      success_url: this.config.returnUrl,
      cancel_url: this.config.cancelUrl,
      // Carried back on the webhook, so a forged reference alone is not enough
      // to be believed — the session is re-read from XPay before we act.
      metadata: { paymentId: input.reference },
    });
  }

  getCheckoutSession(id: string): Promise<CheckoutSession> {
    return this.request<CheckoutSession>('GET', `/checkout-sessions/${encodeURIComponent(id)}`);
  }

  refund(input: { chargeId: string; amountCents?: number; reason?: string }): Promise<unknown> {
    return this.post('/refunds', {
      charge: input.chargeId,
      ...(input.amountCents != null ? { amount: input.amountCents } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    if (!this.config.enabled) {
      throw new ServiceUnavailableException('Online payments are not configured');
    }
    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl}${path}`, {
        method,
        headers: {
          [this.config.authHeader]: this.config.authorizationValue(),
          'Content-Type': 'application/json',
          Accept: 'application/json',
          // XPay sits behind a WAF that answers anonymous-looking clients with
          // an HTML block page. Identifying ourselves is both good manners and
          // the thing support will ask for when whitelisting us.
          'User-Agent': 'Darsly/1.0 (+https://darsly.app)',
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      // A network failure must not read as a declined card.
      throw new ServiceUnavailableException(`Could not reach the payment provider: ${this.redact(String(e))}`);
    }

    const text = await res.text();
    if (!res.ok) {
      this.logger.warn(`XPay ${method} ${path} → ${res.status}: ${this.redact(text).slice(0, 400)}`);
      throw new ServiceUnavailableException(`Payment provider rejected the request (${res.status})`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      // A WAF block returns an HTML page with a 2xx-looking shape. Saying so
      // plainly saves an afternoon of debugging a "malformed JSON" that was
      // never JSON in the first place.
      const blocked = /CloudWAF|<!DOCTYPE html/i.test(text);
      throw new ServiceUnavailableException(
        blocked
          ? 'The payment provider blocked this request at its firewall — the server may need whitelisting'
          : 'Payment provider returned a response we could not read',
      );
    }
  }

  /** Keep the secret key out of every log line, error and API response. */
  private redact(text: string): string {
    let out = text;
    if (this.config.secretKey) out = out.split(this.config.secretKey).join('***');
    return out.replace(/\b([sp]k_(?:test|live)_[A-Za-z0-9_-]{6,})/g, '***');
  }
}
