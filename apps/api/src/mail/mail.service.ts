import { Injectable, Logger } from '@nestjs/common';
import { EmailContent } from './templates';

export interface SendMailInput extends EmailContent {
  to: string;
  /** Where a human reply should land (support inbox), if different from the sender. */
  replyTo?: string;
}

export type SendResult =
  | { delivered: true; id: string }
  | { delivered: false; reason: 'no-provider' | 'provider-error' };

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * The single outbound-email seam for the whole API — one place that knows the
 * provider, so swapping Resend for SMTP later touches this file only.
 *
 * Delivery NEVER throws into the caller. A signup or a password reset must not
 * fail because a mail provider had a bad minute: the account is created, the
 * reset token is issued, and the mail failure is logged for follow-up.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  private get apiKey(): string | undefined {
    return process.env.RESEND_API_KEY?.trim() || undefined;
  }

  /**
   * Resend refuses any From address whose domain isn't verified on the account.
   * Until the domain is verified, `onboarding@resend.dev` is the one sender that
   * always works (and it may only deliver to the account owner's own address).
   */
  private get from(): string {
    return process.env.MAIL_FROM?.trim() || 'Darsly <onboarding@resend.dev>';
  }

  private get replyTo(): string | undefined {
    return process.env.MAIL_REPLY_TO?.trim() || undefined;
  }

  /** True once a provider key is configured — callers can branch on it if needed. */
  get isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async send(input: SendMailInput): Promise<SendResult> {
    const key = this.apiKey;
    if (!key) {
      // Dev seam: no provider configured, so the mail is logged instead of sent.
      // Reset links stay usable locally without an account anywhere.
      this.logger.warn(
        `[MAIL:NOT-SENT] to=${input.to} subject="${input.subject}" — RESEND_API_KEY is unset\n${input.text}`,
      );
      return { delivered: false, reason: 'no-provider' };
    }

    try {
      const response = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.from,
          to: [input.to],
          subject: input.subject,
          html: input.html,
          text: input.text,
          ...(input.replyTo ?? this.replyTo ? { reply_to: input.replyTo ?? this.replyTo } : {}),
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        this.logger.error(
          `Resend rejected the message to ${input.to} (${response.status}): ${body.slice(0, 400)}`,
        );
        return { delivered: false, reason: 'provider-error' };
      }

      const payload = (await response.json().catch(() => ({}))) as { id?: string };
      this.logger.log(`Sent "${input.subject}" to ${input.to} (id=${payload.id ?? 'n/a'})`);
      return { delivered: true, id: payload.id ?? '' };
    } catch (error) {
      this.logger.error(
        `Mail delivery to ${input.to} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { delivered: false, reason: 'provider-error' };
    }
  }

  /**
   * Fire-and-forget: for flows where the HTTP response shouldn't wait on an
   * outbound SMTP round-trip (welcome mail, status-change notice). Failures are
   * already logged inside `send`.
   */
  sendInBackground(input: SendMailInput): void {
    void this.send(input);
  }

  /** Absolute URL into the web app — templates need links, not paths. */
  webUrl(path = ''): string {
    const base = (process.env.WEB_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
    return path ? `${base}/${path.replace(/^\/+/, '')}` : base;
  }
}
