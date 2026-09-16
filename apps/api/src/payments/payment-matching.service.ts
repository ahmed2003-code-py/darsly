import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { namesAgree, parseIdentities, parsePayerName } from '../device/sms-parser';
import { ManualPaymentsService } from './manual-payments.service';
import { WalletService } from '../wallet/wallet.service';

export interface PaymentEventDto {
  provider: 'INSTAPAY' | 'VODAFONE_CASH' | 'BANK_TRANSFER' | 'OTHER';
  amountCents: number;
  reference?: string;
  occurredAt?: string;
  rawMessage?: string;
  deviceId?: string;
  /**
   * A globally unique id for the *transfer event itself* — the SMS message hash
   * from the listener device.
   *
   * Needed because a wallet SMS carries no transaction id: the identity we match
   * on is the sender's mobile number, which is NOT unique per transfer. Keying
   * idempotency on provider+reference+amount would then treat a student's second
   * transfer of the same amount (a monthly subscription, or a second course at
   * the same price) as a duplicate and silently never credit it. When this is
   * supplied it becomes the dedupe identity instead.
   */
  externalId?: string;
  /**
   * Every identifier the raw message could be matched on — the sending wallet's
   * mobile number, a labelled transaction reference, and so on. The student typed
   * exactly one of them at checkout, and which one is not ours to guess, so a hit
   * on any counts. Falls back to [reference] when not supplied.
   */
  identities?: string[];
}

// How far back a pending payment may have been created relative to the transfer.
const WINDOW_BEFORE_MS = 72 * 3600_000;
const WINDOW_AFTER_MS = 30 * 60_000;

/**
 * Which payment methods one provider's message may settle.
 *
 * InstaPay is a rail between bank accounts, not a wallet: the money lands in a
 * bank account and it is the *bank* that sends the SMS («تم تنفيذ تحويل لحظي …
 * إلى حسابك المنتهي بـ **7717»). Meanwhile the student, reading a card labelled
 * «إنستاباي درسلي», picks INSTAPAY. Neither side is wrong, and an exact equality
 * on method meant the two never met — every InstaPay transfer went to an admin.
 *
 * Only the bank family is pooled. A wallet is a different rail with a different
 * SMS and must stay separate. Pooling widens the *candidate set* and nothing
 * else: a match still needs an exact reference, and two candidates sharing one
 * reference are still refused as ambiguous.
 */
function methodsFor(provider: string): string[] {
  return provider === 'INSTAPAY' || provider === 'BANK_TRANSFER'
    ? ['INSTAPAY', 'BANK_TRANSFER']
    : [provider];
}

function normRef(r?: string | null): string {
  return (r ?? '').replace(/[^0-9a-z]/gi, '').toLowerCase();
}
/**
 * Exact normalized-reference equality. Auto-verification must never rely on
 * fuzzy/substring matching — "1234" and "12345" are DIFFERENT transfers, and
 * treating them as the same either drops a real payment or credits the wrong one.
 */
function refExact(a: string, b: string): boolean {
  return !!a && !!b && a === b;
}

@Injectable()
export class PaymentMatchingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly manual: ManualPaymentsService,
    private readonly wallet: WalletService,
  ) {}

  /**
   * Ingest a transfer notification from the Android listener, match it against a
   * pending payment (amount + method + time window, disambiguated by reference),
   * and auto-verify on a confident single match.
   */
  async ingest(dto: PaymentEventDto) {
    const occurredAt = dto.occurredAt ? new Date(dto.occurredAt) : new Date();
    const ref = normRef(dto.reference);

    // Idempotency identity, enforced by a DB unique index.
    //
    // Preferred: the caller's own unique event id (the listener's SMS hash) — one
    // real SMS, one event, no matter how often it is retried, and repeat
    // transfers of the same amount by the same sender stay distinct.
    //
    // Legacy fallback (the X-Listener-Key path, which has no event id): a real
    // transaction reference makes provider+ref+amount unique per transfer.
    const externalId = (dto.externalId ?? '').trim();
    const dedupeKey = externalId
      ? `${dto.provider}:evt:${externalId}`
      : ref
        ? `${dto.provider}:${ref}:${dto.amountCents}`
        : null;

    // Hard idempotency: a re-delivered notification collides on dedupeKey and is
    // reported as an already-processed duplicate — it can never match a second,
    // unrelated payment.
    if (dedupeKey) {
      const prior = await this.prisma.paymentEvent.findUnique({ where: { dedupeKey } });
      if (prior) {
        return { eventId: prior.id, status: 'DUPLICATE' as const, matchedPaymentId: prior.matchedPaymentId };
      }
    }

    // No sender identity ⇒ NEVER auto-verify, even when the event itself is
    // uniquely identified. Amount + time window alone cannot tell two students'
    // identical transfers apart, and crediting the wrong enrollment is worse than
    // asking a human. Recorded (with whatever dedupe identity we have) for review.
    if (!ref) {
      const r = await this.record(dto, occurredAt, dedupeKey, 'UNMATCHED', null,
        'no sender reference — auto-verify disabled without a transfer identity; needs manual review');
      return { eventId: r.eventId, status: r.status, matchedPaymentId: r.matchedPaymentId };
    }

    // Candidates: PENDING payments to verify, OR self-verified (PAID + not yet
    // settled) payments to reconcile — both within the method/time window. Not
    // filtered by amount here: a payment with a wallet contribution is only
    // waiting on (amountCents - walletCents), not the course's full price, and
    // that subtraction can't be expressed in a plain equality filter — so it's
    // applied just below instead, in JS, against this already narrow set.
    const payments = (
      await this.prisma.payment.findMany({
        where: {
          gateway: 'manual',
          method: { in: methodsFor(dto.provider) as any[] },
          createdAt: { gte: new Date(occurredAt.getTime() - WINDOW_BEFORE_MS), lte: new Date(occurredAt.getTime() + WINDOW_AFTER_MS) },
          OR: [{ status: 'PENDING' }, { status: 'PAID', settledAt: null }],
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, reference: true, status: true, amountCents: true, walletCents: true,
          // Who the platform thinks is paying, to weigh against who the provider
          // says actually sent the money.
          student: { select: { user: { select: { fullName: true } } } },
        },
      })
    ).filter((p) => p.amountCents - p.walletCents === dto.amountCents);

    // A wallet top-up is the same transfer with no course attached, so it
    // competes for the same SMS on identical evidence. Pooling the two is what
    // makes a top-up settle by itself instead of waiting on an admin — and
    // pooling them is also what keeps a transfer that could be either from
    // being credited twice.
    const topups = await this.prisma.walletTopup.findMany({
      where: {
        status: 'PENDING',
        amountCents: dto.amountCents,
        method: { in: methodsFor(dto.provider) as any[] },
        createdAt: { gte: new Date(occurredAt.getTime() - WINDOW_BEFORE_MS), lte: new Date(occurredAt.getTime() + WINDOW_AFTER_MS) },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, reference: true,
        student: { select: { user: { select: { fullName: true } } } },
      },
    });

    type Candidate = {
      kind: 'payment' | 'topup';
      id: string;
      reference: string | null;
      status?: string;
      /** The name on the account that owes this money. */
      owner: string;
    };
    const candidates: Candidate[] = [
      ...payments.map((p) => ({
        kind: 'payment' as const, id: p.id, reference: p.reference, status: p.status,
        owner: p.student?.user?.fullName ?? '',
      })),
      ...topups.map((t) => ({
        kind: 'topup' as const, id: t.id, reference: t.reference,
        owner: t.student?.user?.fullName ?? '',
      })),
    ];

    let chosen: Candidate | null = null;
    let status: 'MATCHED' | 'UNMATCHED' | 'AMBIGUOUS' = 'UNMATCHED';
    let note: string | undefined;

    const identities = (dto.identities?.length ? dto.identities : [dto.reference ?? ''])
      .map(normRef)
      .filter(Boolean);

    // Who the provider says sent the money. Read from the raw message rather
    // than taken from the caller: the phone forwards what it received, and the
    // server re-derives anything that decides whether money is credited.
    const payerName = parsePayerName(dto.rawMessage ?? '');

    if (candidates.length === 0) {
      status = 'UNMATCHED';
      note = 'no pending/unsettled payment or wallet top-up with this amount/method in the time window';
    } else {
      const refMatches = candidates.filter((c) =>
        identities.some((identity) => refExact(normRef(c.reference), identity)),
      );
      if (refMatches.length === 1) {
        chosen = refMatches[0];
        status = 'MATCHED';
        // The reference is the strong evidence and stands on its own. The name
        // is recorded either way, because a transfer whose reference matches one
        // student while the wallet belongs to somebody else is worth an admin's
        // attention even though it is credited.
        if (payerName && chosen.owner && !namesAgree(payerName, chosen.owner)) {
          note = `matched by reference, but the transfer is in the name of "${payerName}" and the account is "${chosen.owner}" — worth a look`;
        }
      } else if (refMatches.length > 1) {
        status = 'AMBIGUOUS';
        note = 'multiple payments share this reference';
      } else if (candidates.length === 1) {
        /**
         * One payment of this size, in this window, and the reference the
         * student typed does not match the transfer.
         *
         * This used to be credited anyway, on amount and timing alone. That is
         * the weakest evidence there is — two students buying the same course
         * within three days transfer identical amounts, and whichever one the
         * window happened to hold got the other's money. The name closes it: a
         * transfer is credited here only when the person who sent it is the
         * person who owes it.
         *
         * Where there is no name to check (a provider that does not print one),
         * it goes to a human rather than through on the old evidence.
         */
        const owner = candidates[0].owner;
        if (payerName && owner && namesAgree(payerName, owner)) {
          chosen = candidates[0];
          status = 'MATCHED';
          note = `matched by amount+time and the payer's name ("${payerName}"); the reference differed`;
        } else if (payerName && owner) {
          status = 'AMBIGUOUS';
          note = `one amount match, but the transfer is in the name of "${payerName}" and the account is "${owner}" — reference did not match either`;
        } else {
          status = 'AMBIGUOUS';
          note = 'one amount match, but neither the reference nor a payer name confirms it';
        }
      } else {
        status = 'AMBIGUOUS';
        note = 'several amount matches, none by reference';
      }
    }

    const r = await this.record(
      dto, occurredAt, dedupeKey, status,
      chosen?.kind === 'payment' ? chosen.id : null,
      note,
      chosen?.kind === 'topup' ? chosen.id : null,
      payerName,
    );
    // Only act if we actually recorded a fresh MATCHED event (a concurrent replay
    // that lost the unique-index race returns created=false and does nothing).
    if (r.created && chosen && r.status === 'MATCHED') {
      if (chosen.kind === 'topup') await this.wallet.approveTopup(null, chosen.id);
      else if (chosen.status === 'PENDING') await this.manual.systemVerify(chosen.id);
      else await this.manual.settle(chosen.id, 'system'); // PAID+unsettled → settle
    }
    return { eventId: r.eventId, status: r.status, matchedPaymentId: r.matchedPaymentId };
  }

  /**
   * The other direction: a payment was just submitted — is a transfer already
   * sitting here waiting for it?
   *
   * Matching used to look only backwards, from a transfer to an existing payment.
   * But students transfer *first* and fill the form afterwards, so the SMS almost
   * always lands before the payment row exists — a few seconds is enough. Every
   * one of those events was filed UNMATCHED and nothing ever revisited it, which
   * is why auto-verification looked broken while each half worked perfectly.
   *
   * Same evidence, same confidence rules as [ingest]: same provider, same amount,
   * inside the same window, and exactly one identity match. Ambiguity still goes
   * to a human.
   */
  async reconcilePayment(paymentId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: { id: true, status: true, method: true, amountCents: true, walletCents: true, reference: true, createdAt: true },
    });
    if (!payment || payment.status !== 'PENDING') return { status: 'SKIPPED' as const };

    const ref = normRef(payment.reference);
    // Without an identity the student gave us, amount+time alone cannot tell two
    // students' identical transfers apart. Same rule as the forward path.
    if (!ref) return { status: 'NO_REFERENCE' as const };

    // A wallet contribution means the transfer this payment is actually
    // waiting on is only the remainder, not the course's full price.
    const cashDueCents = payment.amountCents - payment.walletCents;
    const events = await this.prisma.paymentEvent.findMany({
      where: {
        status: 'UNMATCHED',
        matchedPaymentId: null,
        provider: payment.method as any,
        amountCents: cashDueCents,
        occurredAt: {
          gte: new Date(payment.createdAt.getTime() - WINDOW_BEFORE_MS),
          lte: new Date(payment.createdAt.getTime() + WINDOW_AFTER_MS),
        },
      },
      orderBy: { occurredAt: 'desc' },
      take: 50,
    });

    const hits = events.filter((event) => {
      const derived = parseIdentities(event.rawMessage ?? '').map(normRef).filter(Boolean);
      const identities = derived.length ? derived : [normRef(event.reference)];
      return identities.some((identity) => refExact(identity, ref));
    });

    if (hits.length === 0) return { status: 'UNMATCHED' as const };
    if (hits.length > 1) return { status: 'AMBIGUOUS' as const };

    const event = hits[0];
    await this.prisma.paymentEvent.update({
      where: { id: event.id },
      data: {
        status: 'MATCHED',
        matchedPaymentId: payment.id,
        note: 'reconciled when the payment was submitted (transfer arrived first)',
      },
    });
    await this.manual.systemVerify(payment.id);
    return { status: 'MATCHED' as const, eventId: event.id };
  }

  /**
   * The top-up counterpart of [reconcilePayment]: a student almost always
   * transfers first and fills the form after, so the SMS is already filed
   * UNMATCHED by the time the top-up row exists. Without this the transfer sits
   * there and the top-up waits on an admin — which is exactly how a paid 35 EGP
   * top-up stayed pending.
   *
   * Same evidence and the same confidence bar as every other match: provider,
   * amount, window, exactly one identity hit.
   */
  async reconcileTopup(topupId: string) {
    const topup = await this.prisma.walletTopup.findUnique({
      where: { id: topupId },
      select: { id: true, status: true, method: true, amountCents: true, reference: true, createdAt: true },
    });
    if (!topup || topup.status !== 'PENDING') return { status: 'SKIPPED' as const };

    const ref = normRef(topup.reference);
    if (!ref) return { status: 'NO_REFERENCE' as const };

    const events = await this.prisma.paymentEvent.findMany({
      where: {
        status: 'UNMATCHED',
        matchedPaymentId: null,
        matchedTopupId: null,
        provider: topup.method as any,
        amountCents: topup.amountCents,
        occurredAt: {
          gte: new Date(topup.createdAt.getTime() - WINDOW_BEFORE_MS),
          lte: new Date(topup.createdAt.getTime() + WINDOW_AFTER_MS),
        },
      },
      orderBy: { occurredAt: 'desc' },
      take: 50,
    });

    const hits = events.filter((event) => {
      const derived = parseIdentities(event.rawMessage ?? '').map(normRef).filter(Boolean);
      const identities = derived.length ? derived : [normRef(event.reference)];
      return identities.some((identity) => refExact(identity, ref));
    });

    if (hits.length === 0) return { status: 'UNMATCHED' as const };
    if (hits.length > 1) return { status: 'AMBIGUOUS' as const };

    const event = hits[0];
    await this.prisma.paymentEvent.update({
      where: { id: event.id },
      data: {
        status: 'MATCHED',
        matchedTopupId: topup.id,
        note: 'reconciled when the top-up was submitted (transfer arrived first)',
      },
    });
    await this.wallet.approveTopup(null, topup.id);
    return { status: 'MATCHED' as const, eventId: event.id };
  }

  private async record(
    dto: PaymentEventDto, occurredAt: Date, dedupeKey: string | null,
    status: 'MATCHED' | 'UNMATCHED' | 'AMBIGUOUS' | 'DUPLICATE',
    matchedPaymentId: string | null, note?: string, matchedTopupId?: string | null,
    payerName?: string | null,
  ) {
    try {
      const event = await this.prisma.paymentEvent.create({
        data: {
          provider: dto.provider as any,
          amountCents: dto.amountCents,
          reference: dto.reference?.trim() || null,
          occurredAt,
          rawMessage: dto.rawMessage ?? '',
          // Re-derived from the raw message when the caller did not pass it, so
          // an event recorded on any path carries who sent the money.
          payerName: payerName ?? parsePayerName(dto.rawMessage ?? ''),
          deviceId: dto.deviceId ?? null,
          status,
          matchedPaymentId,
          matchedTopupId: matchedTopupId ?? null,
          dedupeKey,
          note,
        },
      });
      return { eventId: event.id, status, matchedPaymentId, created: true };
    } catch (e) {
      // Lost the unique-index race with a concurrent identical event → duplicate.
      if (dedupeKey && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const prior = await this.prisma.paymentEvent.findUnique({ where: { dedupeKey } });
        return {
          eventId: prior?.id ?? null,
          status: 'DUPLICATE' as const,
          matchedPaymentId: prior?.matchedPaymentId ?? null,
          created: false,
        };
      }
      throw e;
    }
  }

  // ── Admin ────────────────────────────────────────────────────────────────

  listEvents(status?: string) {
    return this.prisma.paymentEvent.findMany({
      where: status ? { status: status as any } : {},
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  /** Admin resolves an unmatched/ambiguous event by pointing it at a payment. */
  async manualMatch(eventId: string, paymentId: string, actorId: string) {
    const event = await this.prisma.paymentEvent.findUnique({ where: { id: eventId } });
    if (!event) throw new NotFoundException('Event not found');
    if (event.status === 'MATCHED') throw new BadRequestException('Event already matched');
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found');
    // A transfer is proof of exactly the amount it carried, not of any payment
    // an admin points it at.
    if (event.amountCents !== payment.amountCents) {
      throw new BadRequestException({
        message: `Transfer is ${event.amountCents} but the payment is ${payment.amountCents}`,
        code: 'AMOUNT_MISMATCH',
      });
    }
    // Same as an automatic match: a pending payment is verified and settled;
    // one a teacher already self-verified is settled — that is the whole point
    // of a real transfer turning up for it.
    if (payment.status === 'PENDING') await this.manual.systemVerify(paymentId);
    else if (payment.status === 'PAID' && !payment.settledAt) await this.manual.settle(paymentId, actorId);
    else throw new BadRequestException({ message: 'Payment is neither pending nor awaiting settlement', code: 'NOT_MATCHABLE' });
    await this.prisma.paymentEvent.update({
      where: { id: eventId },
      data: { status: 'MATCHED', matchedPaymentId: paymentId, note: `manual match by ${actorId}` },
    });
    return { ok: true };
  }
}
