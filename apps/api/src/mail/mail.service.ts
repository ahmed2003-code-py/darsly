import { Injectable, Logger } from '@nestjs/common';
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EmailContent } from './templates';

export interface SendMailInput extends EmailContent {
  to: string;
  /** Where a human reply should land (support inbox), if different from the sender. */
  replyTo?: string;
  /**
   * TEMPORARY TEST ROUTING — added for one call site (the Center owner/admin
   * activation email in AdminCentersService) while the real provider can't be
   * verified end-to-end on Railway. Opt-in per call: when set AND
   * TEMP_CENTER_OWNER_EMAIL_REDIRECT_TO is configured, delivery is redirected
   * to that address instead of `to`. `to` (the real Center owner/admin) is
   * never mutated — only where THIS message is delivered — and the message
   * body says so explicitly. No other call site is affected.
   *
   * To remove: delete this flag, the `tempCenterOwnerRedirectTo` getter and
   * the redirect block in `send()` below, the `centerOwnerTestRedirect: true`
   * at its one call site, and unset TEMP_CENTER_OWNER_EMAIL_REDIRECT_TO.
   */
  centerOwnerTestRedirect?: boolean;
}

/** Escapes a value before it lands inside the temporary test-routing HTML notice. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export type SendResult =
  | { delivered: true; id: string; transport: 'resend' | 'capture' }
  | { delivered: false; reason: 'no-provider' | 'provider-error' };

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Where the capture transport writes outbound mail. Test/dev only — see
 * `captureDir` below; it is never honoured when NODE_ENV=production.
 */
const DEFAULT_CAPTURE_DIR = join(tmpdir(), 'darsly-mail-outbox');

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

  /** TEMPORARY TEST ROUTING — see SendMailInput.centerOwnerTestRedirect. */
  private get tempCenterOwnerRedirectTo(): string | undefined {
    return process.env.TEMP_CENTER_OWNER_EMAIL_REDIRECT_TO?.trim() || undefined;
  }

  /** True once a provider key is configured — callers can branch on it if needed. */
  get isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * Capture transport (test/dev only): with MAIL_TRANSPORT=capture every
   * outbound message is written as JSON to MAIL_CAPTURE_DIR instead of being
   * sent, so an E2E run can read the activation/invitation URL it would have
   * emailed — without depending on Resend, and without any HTTP endpoint that
   * hands tokens out. Refused outright in production: NODE_ENV=production
   * ignores the variable and falls through to the real provider.
   */
  private get captureDir(): string | undefined {
    if (process.env.NODE_ENV === 'production') return undefined;
    if (process.env.MAIL_TRANSPORT?.trim() !== 'capture') return undefined;
    return process.env.MAIL_CAPTURE_DIR?.trim() || DEFAULT_CAPTURE_DIR;
  }

  async send(input: SendMailInput): Promise<SendResult> {
    const key = this.apiKey;

    // TEMPORARY TEST ROUTING (see SendMailInput.centerOwnerTestRedirect above).
    // Opt-in per call and a no-op unless the env var is also set, so this
    // never touches any other email flow. `input.to` — the real recipient —
    // is read but never written anywhere.
    const redirectTo = input.centerOwnerTestRedirect ? this.tempCenterOwnerRedirectTo : undefined;
    const to = redirectTo ?? input.to;
    const subject = redirectTo ? `[TEST ROUTED — real recipient: ${input.to}] ${input.subject}` : input.subject;
    const noticeHtml = redirectTo
      ? `<p style="margin:0 0 16px;padding:12px;background:#FEF3C7;border:1px solid #F59E0B;border-radius:8px;font-size:13px;color:#92400E;"><strong>TEMPORARY TEST ROUTING</strong> — this message was really meant for <strong>${escapeHtml(input.to)}</strong>. It was redirected here only for testing; nothing about the real recipient changed.</p>`
      : '';
    const html = redirectTo ? `${noticeHtml}${input.html}` : input.html;
    const text = redirectTo ? `[TEMPORARY TEST ROUTING — real recipient: ${input.to}]\n\n${input.text}` : input.text;

    const captureDir = this.captureDir;
    if (captureDir) {
      try {
        mkdirSync(captureDir, { recursive: true });
        const file = join(captureDir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
        writeFileSync(file, JSON.stringify({ capturedAt: new Date().toISOString(), to, realRecipient: input.to, subject, text, html }, null, 2));
        this.logger.log(`[MAIL:CAPTURED] to=${to} subject="${subject}" → ${file}`);
        return { delivered: true, id: file, transport: 'capture' };
      } catch (error) {
        this.logger.error(`Mail capture failed: ${error instanceof Error ? error.message : String(error)}`);
        return { delivered: false, reason: 'provider-error' };
      }
    }

    if (!key) {
      // Dev seam: no provider configured, so the mail is logged instead of sent.
      // Reset links stay usable locally without an account anywhere. The body
      // (which carries the activation/reset link) is logged OUTSIDE production
      // only — a production log must never contain a live token.
      const body = process.env.NODE_ENV === 'production' ? '' : `\n${text}`;
      this.logger.warn(`[MAIL:NOT-SENT] to=${to} subject="${subject}" — RESEND_API_KEY is unset${body}`);
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
          to: [to],
          subject,
          html,
          text,
          ...(input.replyTo ?? this.replyTo ? { reply_to: input.replyTo ?? this.replyTo } : {}),
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        this.logger.error(
          `Resend rejected the message to ${to} (${response.status}): ${body.slice(0, 400)}`,
        );
        return { delivered: false, reason: 'provider-error' };
      }

      const payload = (await response.json().catch(() => ({}))) as { id?: string };
      this.logger.log(`Sent "${subject}" to ${to} (id=${payload.id ?? 'n/a'})${redirectTo ? ` [TEST ROUTED, real recipient ${input.to}]` : ''}`);
      return { delivered: true, id: payload.id ?? '', transport: 'resend' };
    } catch (error) {
      this.logger.error(
        `Mail delivery to ${to} failed: ${error instanceof Error ? error.message : String(error)}`,
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
