import { Injectable } from '@nestjs/common';

/**
 * What happens to a payment that buys a Live seat once it is verified or
 * rejected. The Live commerce module implements it and registers itself at
 * start-up, so the one payment pipeline (proof → listener match / admin →
 * verification) can hand a Live payment over without the payments module
 * depending on Live — and without a second pipeline beside it.
 */
export interface LivePaymentHandler {
  /** A trusted source verified the payment: settle it and give (or refuse and refund) the seat. */
  verify(paymentId: string, verifierId: string): Promise<{ ok: true; alreadyHandled?: boolean }>;
  /** The payment was refused: release the seat, keep the record. */
  reject(paymentId: string, actorId: string, reason?: string): Promise<{ ok: true }>;
}

@Injectable()
export class PaymentTargets {
  private live: LivePaymentHandler | null = null;

  registerLive(handler: LivePaymentHandler) {
    this.live = handler;
  }

  /** Throws rather than guessing: a Live payment must never fall into the course path. */
  liveHandler(): LivePaymentHandler {
    if (!this.live) throw new Error('Live payment handler is not registered');
    return this.live;
  }
}
