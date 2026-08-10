import { Injectable } from '@nestjs/common';

/**
 * XPay wiring.
 *
 * Three of these could not be taken from XPay's public documentation — the
 * base URL, the shape of the Authorization header, and how a webhook signature
 * is produced are all behind the dashboard login. They are therefore *all*
 * environment values with documented defaults rather than constants buried in
 * a client, so confirming them against the Developer hub is an env change and
 * not a code change.
 *
 * The defaults follow the conventions XPay's own docs imply (a Stripe-shaped
 * API: `POST /checkout-sessions`, bearer secret keys, signed webhook payloads).
 * They are a starting point, not a claim — verify each one before going live.
 */
@Injectable()
export class XPayConfig {
  /** Master switch. Off until a secret key is present, so a missing key is never a live failure. */
  get enabled(): boolean {
    return process.env.XPAY_ENABLED === 'true' && !!this.secretKey;
  }

  /** VERIFY against the dashboard: the API origin, without a trailing slash. */
  readonly baseUrl = (process.env.XPAY_BASE_URL ?? 'https://api.xpay.app/v1').replace(/\/$/, '');

  /** Secret key. Server-side only — never sent to a browser, never logged. */
  readonly secretKey = process.env.XPAY_SECRET_KEY ?? '';

  /**
   * VERIFY: the header the secret key travels in. Written as a template so a
   * scheme like `Token <key>` or `X-API-Key: <key>` needs no code change.
   */
  readonly authHeader = process.env.XPAY_AUTH_HEADER ?? 'Authorization';
  readonly authFormat = process.env.XPAY_AUTH_FORMAT ?? 'Bearer {key}';

  /**
   * Webhook signing secret. With no value set, every webhook is rejected —
   * an unverified webhook is an unauthenticated request that grants course
   * access and moves money, so it fails closed rather than open.
   */
  readonly webhookSecret = process.env.XPAY_WEBHOOK_SECRET ?? '';

  /** VERIFY: the header carrying the signature, and the digest algorithm. */
  readonly signatureHeader = process.env.XPAY_SIGNATURE_HEADER ?? 'x-xpay-signature';
  readonly signatureAlgorithm = process.env.XPAY_SIGNATURE_ALGO ?? 'sha256';

  /** Where XPay sends the student back once the payment is finished. */
  readonly returnUrl = process.env.XPAY_RETURN_URL ?? `${process.env.APP_URL ?? ''}/my-courses`;
  readonly cancelUrl = process.env.XPAY_CANCEL_URL ?? `${process.env.APP_URL ?? ''}/my-courses`;

  /** Test mode is what the dashboard is currently in; keys are what actually decide. */
  get testMode(): boolean {
    return !this.secretKey.includes('live');
  }

  authorizationValue(): string {
    return this.authFormat.replace('{key}', this.secretKey);
  }
}
