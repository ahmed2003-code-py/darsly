import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { WalletService } from '../wallet/wallet.service';
import { ManualPaymentsService } from './manual-payments.service';

/**
 * How long a declared transfer waits for its money. The matcher's own window
 * is 72 hours: after it no SMS could be tied to the declaration anyway, so it
 * is closed rather than left pending for ever. Configurable, never shorter
 * than a day.
 */
export function declarationTtlMs(): number {
  const h = Number(process.env.PAYMENT_DECLARATION_TTL_HOURS ?? 72);
  return (Number.isFinite(h) ? Math.max(24, h) : 72) * 3600_000;
}

/**
 * Closes course payments and wallet top-ups that were declared and never paid
 * — open, never claimed, no proof, no transfer tied to them. Declaring before
 * transferring means abandoned checkouts now leave PENDING rows; this is what
 * keeps them from piling up. Nothing claimed, matched or confirmed is ever
 * touched, and a course payment is closed through the ordinary reject path
 * (coupon use, wallet reservation and pending enrolment released). Live seats
 * keep their own hold/expiry rules and are not handled here.
 *
 * `PAYMENT_EXPIRY_WORKER_ENABLED=false` opts a replica out.
 */
@Injectable()
export class PaymentExpiryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentExpiryWorker.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly payments: ManualPaymentsService,
    private readonly wallet: WalletService,
  ) {}

  onModuleInit(): void {
    if ((process.env.PAYMENT_EXPIRY_WORKER_ENABLED ?? 'true') !== 'true') return;
    this.timer = setInterval(() => void this.sweep(), 10 * 60_000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(): Promise<{ payments: number; topups: number }> {
    const out = { payments: 0, topups: 0 };
    if (this.running) return out;
    this.running = true;
    try {
      const ttl = declarationTtlMs();
      out.payments = await this.payments.expireDeclared(ttl);
      out.topups = await this.wallet.expireDeclaredTopups(ttl);
      if (out.payments || out.topups) {
        this.logger.log(`declared transfers expired: ${out.payments} course payments, ${out.topups} top-ups`);
      }
    } catch (e) {
      this.logger.error(`payment expiry sweep error: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
    return out;
  }
}
