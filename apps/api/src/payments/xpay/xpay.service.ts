import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { ManualPaymentsService } from '../manual-payments.service';
import { XPayClient } from './xpay.client';
import { XPayConfig } from './xpay.config';

/**
 * Card payments through XPay.
 *
 * It deliberately does not settle anything itself. A verified online payment
 * ends up in exactly the same place a verified bank transfer does —
 * `ManualPaymentsService.systemVerify()` — which activates the enrolment and
 * writes the double-entry ledger inside one transaction. Two payment routes
 * that settle money differently is how a ledger stops balancing.
 */
@Injectable()
export class XPayService {
  private readonly logger = new Logger(XPayService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: XPayClient,
    private readonly config: XPayConfig,
    private readonly payments: ManualPaymentsService,
  ) {}

  /**
   * Begin a card payment for a course.
   *
   * A PENDING payment row is created first and its id is handed to XPay as the
   * reference, so the webhook that arrives later can only ever be about a
   * payment we already know we started.
   */
  async startCheckout(userId: string, courseId: string, couponCode?: string) {
    const student = await this.prisma.studentProfile.findFirst({
      where: { userId },
      include: { user: { select: { fullName: true, email: true } } },
    });
    if (!student) throw new NotFoundException('Student profile not found');

    const course = await this.prisma.course.findFirst({
      where: { id: courseId, status: 'PUBLISHED', deletedAt: null },
    });
    if (!course) throw new NotFoundException('Course not found');

    const existing = await this.prisma.enrollment.findUnique({
      where: { studentId_courseId: { studentId: student.id, courseId } },
    });
    if (existing?.status === 'ACTIVE' && (!existing.expiresAt || existing.expiresAt > new Date())) {
      throw new ConflictException('You are already enrolled in this course');
    }

    // Priced through the same method the bank-transfer route uses, coupon and
    // all. Two routes that price differently would credit a teacher different
    // amounts for the same course depending on how the student happened to pay.
    const quote = await this.payments.quote(course, couponCode);

    const payment = await this.prisma.$transaction(async (tx) => {
      const enrollment = existing
        ? await tx.enrollment.update({
            where: { id: existing.id },
            data: { status: 'PENDING_APPROVAL' },
          })
        : await tx.enrollment.create({
            data: {
              studentId: student.id,
              courseId,
              tenantId: course.tenantId,
              status: 'PENDING_APPROVAL',
            },
          });

      return tx.payment.create({
        data: {
          studentId: student.id,
          courseId,
          enrollmentId: enrollment.id,
          tenantId: course.tenantId,
          amountCents: quote.totalCents,
          feeCents: quote.feeCents,
          netCents: quote.netCents,
          currency: course.currency,
          status: 'PENDING',
          gateway: 'xpay',
          ...(quote.couponId ? { couponId: quote.couponId } : {}),
        },
      });
    });

    // The payment row has to exist before the call, because its id is the
    // reference XPay sends back. That means a provider failure leaves a pending
    // payment and a pending enrolment behind for a student who never reached a
    // payment page — a teacher would see an approval request for money nobody
    // was asked for. So the rows are unwound if the call does not produce a
    // usable checkout link.
    let session: Awaited<ReturnType<XPayClient['createCheckoutSession']>>;
    try {
      session = await this.client.createCheckoutSession({
        amountCents: payment.amountCents,
        currency: payment.currency,
        reference: payment.id,
        description: course.title,
        customer: { name: student.user.fullName, email: student.user.email ?? undefined },
      });
      if (!session.url) throw new BadRequestException('The payment provider did not return a checkout link');
    } catch (e) {
      await this.unwind(payment.id, existing ? { id: existing.id, status: existing.status } : null);
      throw e;
    }

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { gatewayRef: session.id },
    });
    return { paymentId: payment.id, checkoutUrl: session.url, testMode: this.config.testMode };
  }

  /**
   * Undo a checkout that never reached a payment page.
   *
   * Best-effort and never rethrows: the caller is already failing, and a
   * cleanup error would replace a clear "provider unreachable" with something
   * meaningless to the student.
   */
  private async unwind(paymentId: string, previous: { id: string; status: string } | null) {
    try {
      await this.prisma.$transaction(async (tx) => {
        const payment = await tx.payment.delete({ where: { id: paymentId } });
        if (!payment.enrollmentId) return;
        if (previous) {
          // It existed before this attempt; put it back as it was.
          await tx.enrollment.update({
            where: { id: previous.id },
            data: { status: previous.status as never },
          });
        } else {
          await tx.enrollment.delete({ where: { id: payment.enrollmentId } });
        }
      });
    } catch (e) {
      this.logger.error(`Could not unwind checkout ${paymentId}: ${String(e)}`);
    }
  }

  /**
   * Verify a webhook signature.
   *
   * Fails closed: with no signing secret configured nothing is accepted at all.
   * A webhook that is believed without proof is an unauthenticated request that
   * grants course access and moves money.
   */
  verifySignature(rawBody: Buffer | string, signature: string | undefined): boolean {
    if (!this.config.webhookSecret || !signature) return false;
    const expected = createHmac(this.config.signatureAlgorithm, this.config.webhookSecret)
      .update(rawBody)
      .digest('hex');
    // Some providers send `sha256=<hex>` or a comma-separated list; compare
    // against every candidate rather than assuming one shape.
    const candidates = signature.split(',').map((p) => p.trim().split('=').pop()!.trim().toLowerCase());
    return candidates.some((c) => equals(c, expected));
  }

  /**
   * Act on a webhook.
   *
   * Idempotent by construction: settlement runs through `systemVerify`, which
   * already refuses to act twice on the same payment, so a provider retrying a
   * delivery cannot enrol a student twice or double-credit a teacher.
   */
  async handleEvent(event: { type?: string; data?: Record<string, unknown> }) {
    const type = String(event.type ?? '');
    const object = (event.data?.object ?? event.data ?? {}) as Record<string, unknown>;
    const paymentId =
      (object.reference as string) ??
      ((object.metadata as Record<string, string> | undefined)?.paymentId ?? '');

    if (!paymentId) {
      this.logger.warn(`XPay event ${type} carried no reference; ignored`);
      return { handled: false, reason: 'no-reference' };
    }

    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.gateway !== 'xpay') {
      this.logger.warn(`XPay event ${type} referenced unknown payment ${paymentId}`);
      return { handled: false, reason: 'unknown-payment' };
    }
    if (payment.status === 'PAID') return { handled: true, alreadySettled: true };

    if (SUCCESS_EVENTS.some((e) => type.includes(e))) {
      // Never settle on the word of the request body alone. The session is read
      // back from XPay, so a forged webhook that somehow passed the signature
      // still cannot grant access to a payment that was not actually made.
      if (payment.gatewayRef) {
        const session = await this.client.getCheckoutSession(payment.gatewayRef);
        const paid = String(session.status ?? '').trim().toLowerCase();
        // Exact match, never substring: "unpaid".includes("paid") is true, and
        // a substring test here would settle a session the provider had just
        // told us was not paid.
        if (!PAID_STATUSES.has(paid)) {
          this.logger.warn(`XPay says ${payment.gatewayRef} is "${paid}"; not settling ${paymentId}`);
          return { handled: false, reason: 'not-paid-at-provider' };
        }
      }
      await this.payments.systemVerify(paymentId);
      this.logger.log(`XPay settled payment ${paymentId}`);
      return { handled: true, settled: true };
    }

    if (FAILURE_EVENTS.some((e) => type.includes(e))) {
      await this.prisma.payment.update({
        where: { id: paymentId },
        data: { status: 'REJECTED', rejectedReason: `xpay:${type}` },
      });
      return { handled: true, failed: true };
    }

    return { handled: false, reason: `unhandled:${type}` };
  }
}

/** VERIFY these against the dashboard's event list; matching is by substring. */
const SUCCESS_EVENTS = ['checkout_session.completed', 'checkout.completed', 'payment.succeeded', 'charge.succeeded'];
const FAILURE_EVENTS = ['payment.failed', 'charge.failed', 'checkout_session.expired', 'checkout.expired'];
const PAID_STATUSES = new Set(['paid', 'completed', 'complete', 'succeeded', 'success', 'captured']);

/** Constant-time compare that tolerates length differences. */
function equals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
