import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PayoutMethod } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { methodsFor } from './payment-matching.service';

/** «…1234»: enough to tell two references apart, not enough to copy one. */
export function maskTail(value: string | null | undefined, keep = 4): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  return v.length <= keep ? '•'.repeat(v.length) : `…${v.slice(-keep)}`;
}

const OPEN_EVENT = ['UNMATCHED', 'AMBIGUOUS'] as const;

/**
 * Money Darsly received that the matcher could not (or should not) tie to a
 * payment, and what finance does about it.
 *
 * Reading is masked: an admin sees when, how much, on which rail, into which
 * of our accounts, the payer's name and the tail of the reference — never the
 * raw SMS. Acting is limited to three things, each of which claims the
 * transfer with a compare-and-swap on its status, so any two of them racing
 * (two admins, an admin and the automatic matcher) leave exactly one winner:
 *
 *   match   → an existing PENDING payment (PaymentMatchingService.manualMatch)
 *   attach  → a Live purchase that never got a payment (LiveCommerceService)
 *   return  → a tracked manual transfer back (here)
 */
@Injectable()
export class UnmatchedTransfersService {
  constructor(private readonly prisma: PrismaService) {}

  private async accountFor(
    provider: string,
    raw: string,
    handles: { method: string; label: string; handle: string }[],
  ) {
    const digits = raw.replace(/\D/g, '');
    const byNumber = handles.find((a) => {
      const d = a.handle.replace(/\D/g, '');
      return d.length >= 10 && digits.includes(d.slice(-10));
    });
    const hit = byNumber ?? handles.find((a) => a.method === provider);
    return hit ? { label: hit.label, method: hit.method, handle: maskTail(hit.handle) } : null;
  }

  async list(status?: string) {
    const statuses = ['MATCHED', 'UNMATCHED', 'AMBIGUOUS', 'DUPLICATE', 'RETURNED'];
    const where =
      status === 'OPEN'
        ? { status: { in: [...OPEN_EVENT] as any[] } }
        : status && statuses.includes(status)
          ? { status: status as any }
          : {};
    const [rows, accounts] = await Promise.all([
      this.prisma.paymentEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: { transferReturn: true },
      }),
      this.prisma.platformPaymentAccount.findMany({
        select: { method: true, label: true, handle: true },
      }),
    ]);
    const paymentIds = rows.map((r) => r.matchedPaymentId).filter((x): x is string => !!x);
    const payments = paymentIds.length
      ? await this.prisma.payment.findMany({
          where: { id: { in: paymentIds } },
          select: {
            id: true,
            status: true,
            course: { select: { title: true } },
            livePurchase: { select: { session: { select: { title: true } } } },
          },
        })
      : [];
    const byId = new Map(payments.map((p) => [p.id, p]));
    return Promise.all(
      rows.map(async (e) => {
        const p = e.matchedPaymentId ? byId.get(e.matchedPaymentId) : undefined;
        return {
          id: e.id,
          provider: e.provider,
          amountCents: e.amountCents,
          occurredAt: e.occurredAt,
          createdAt: e.createdAt,
          status: e.status,
          note: e.note,
          payerName: e.payerName,
          referenceMasked: maskTail(e.reference),
          receivingAccount: await this.accountFor(e.provider, e.rawMessage ?? '', accounts),
          matchedPayment: p
            ? {
                id: p.id,
                status: p.status,
                title: p.course?.title ?? p.livePurchase?.session.title ?? null,
              }
            : null,
          matchedTopupId: e.matchedTopupId,
          transferReturn: e.transferReturn
            ? {
                id: e.transferReturn.id,
                status: e.transferReturn.status,
                amountCents: e.transferReturn.amountCents,
                destinationMethod: e.transferReturn.destinationMethod,
                destinationDetails: e.transferReturn.destinationDetails,
                reason: e.transferReturn.reason,
                transferReference: e.transferReturn.transferReference,
                createdAt: e.transferReturn.createdAt,
                completedAt: e.transferReturn.completedAt,
              }
            : null,
        };
      }),
    );
  }

  /**
   * The PENDING payments this transfer could be matched to by hand: same rail,
   * waiting on exactly this amount, and not already paid for by another
   * transfer. Shown with what an admin needs to judge — never a guess made
   * for them.
   */
  async paymentCandidates(eventId: string) {
    const e = await this.event(eventId);
    const rows = await this.prisma.payment.findMany({
      where: {
        gateway: 'manual',
        method: { in: methodsFor(e.provider) as any[] },
        OR: [{ status: 'PENDING' }, { status: 'PAID', settledAt: null }],
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        student: { select: { user: { select: { fullName: true } } } },
        course: { select: { title: true } },
        livePurchase: {
          select: {
            status: true,
            session: { select: { title: true, startsAt: true } },
            guestBuyer: { select: { displayName: true } },
          },
        },
      },
    });
    const due = rows.filter((p) => p.amountCents - (p.walletCents ?? 0) === e.amountCents);
    const taken = new Set(
      (
        await this.prisma.paymentEvent.findMany({
          where: { matchedPaymentId: { in: due.map((p) => p.id) } },
          select: { matchedPaymentId: true },
        })
      ).map((x) => x.matchedPaymentId),
    );
    return due
      .filter((p) => !taken.has(p.id))
      .map((p) => ({
        paymentId: p.id,
        kind: p.livePurchaseId ? ('live' as const) : ('course' as const),
        title: p.course?.title ?? p.livePurchase?.session.title ?? null,
        sessionStartsAt: p.livePurchase?.session.startsAt ?? null,
        buyerName: p.student?.user.fullName ?? p.livePurchase?.guestBuyer?.displayName ?? null,
        expectedCents: p.amountCents - (p.walletCents ?? 0),
        status: p.status,
        livePurchaseStatus: p.livePurchase?.status ?? null,
        method: p.method,
        transferSource: p.transferSource,
        payerName: p.payerName,
        referenceMasked: maskTail(p.reference),
        claimed: !!p.claimedAt,
        hasProof: !!p.proofImageUrl,
        createdAt: p.createdAt,
      }));
  }

  /**
   * Payments an admin already confirmed by hand for exactly this amount, that
   * no transfer is tied to yet — so the transfer that paid for one can be
   * linked to it (no money moves) instead of sitting in the queue looking
   * like money to return. Any rail, within a week of the transfer.
   */
  async verifiedCandidates(eventId: string) {
    const e = await this.event(eventId);
    const week = 7 * 86_400_000;
    const rows = await this.prisma.payment.findMany({
      where: {
        gateway: 'manual',
        status: 'PAID',
        method: { in: ['INSTAPAY', 'VODAFONE_CASH', 'BANK_TRANSFER', 'OTHER'] as any[] },
        createdAt: {
          gte: new Date(e.occurredAt.getTime() - week),
          lte: new Date(e.occurredAt.getTime() + week),
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        student: { select: { user: { select: { fullName: true } } } },
        course: { select: { title: true } },
        livePurchase: {
          select: {
            status: true,
            session: { select: { title: true } },
            guestBuyer: { select: { displayName: true } },
          },
        },
      },
    });
    const due = rows.filter((p) => p.amountCents - (p.walletCents ?? 0) === e.amountCents);
    const taken = new Set(
      (
        await this.prisma.paymentEvent.findMany({
          where: { matchedPaymentId: { in: due.map((p) => p.id) } },
          select: { matchedPaymentId: true },
        })
      ).map((x) => x.matchedPaymentId),
    );
    return due
      .filter((p) => !taken.has(p.id))
      .map((p) => ({
        paymentId: p.id,
        title: p.course?.title ?? p.livePurchase?.session.title ?? null,
        buyerName: p.student?.user.fullName ?? p.livePurchase?.guestBuyer?.displayName ?? null,
        amountCents: p.amountCents - (p.walletCents ?? 0),
        method: p.method,
        paidAt: p.paidAt,
        livePurchaseStatus: p.livePurchase?.status ?? null,
      }));
  }

  /**
   * Pending wallet top-ups this transfer could be: same rail, exactly this
   * amount, no transfer tied to them yet — shown as WALLET_TOPUP targets
   * beside the Live and course payments, in the one queue.
   */
  async topupCandidates(eventId: string) {
    const e = await this.event(eventId);
    const rows = await this.prisma.walletTopup.findMany({
      where: {
        status: 'PENDING',
        amountCents: e.amountCents,
        method: { in: methodsFor(e.provider) as any[] },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { student: { select: { user: { select: { fullName: true } } } } },
    });
    const taken = new Set(
      (
        await this.prisma.paymentEvent.findMany({
          where: { matchedTopupId: { in: rows.map((t) => t.id) } },
          select: { matchedTopupId: true },
        })
      ).map((x) => x.matchedTopupId),
    );
    return rows
      .filter((t) => !taken.has(t.id))
      .map((t) => ({
        topupId: t.id,
        kind: 'topup' as const,
        buyerName: t.student?.user.fullName ?? null,
        expectedCents: t.amountCents,
        method: t.method,
        transferSource: t.transferSource,
        payerName: t.payerName,
        referenceMasked: maskTail(t.reference),
        claimed: !!t.claimedAt,
        hasProof: !!t.proofImageUrl,
        createdAt: t.createdAt,
      }));
  }

  async event(eventId: string) {
    const e = await this.prisma.paymentEvent.findUnique({ where: { id: eventId } });
    if (!e) throw new NotFoundException('Event not found');
    return e;
  }

  private async audit(
    actorUserId: string,
    action: string,
    entityId: string,
    meta: Record<string, unknown>,
  ) {
    await this.prisma.auditLog
      .create({
        data: { actorUserId, action, entity: 'PaymentEvent', entityId, meta: meta as never },
      })
      .catch(() => undefined);
  }

  private destination(dto: { method?: string; holderName?: string; handle?: string }) {
    const method = dto.method as PayoutMethod;
    if (!['INSTAPAY', 'VODAFONE_CASH', 'BANK_TRANSFER'].includes(method))
      throw new BadRequestException({
        message: 'Choose how the money goes back',
        code: 'RETURN_METHOD_INVALID',
      });
    const holderName = (dto.holderName ?? '').trim().slice(0, 80);
    const handle = (dto.handle ?? '').replace(/\s+/g, '').slice(0, 64);
    if (holderName.length < 2 || handle.length < 4)
      throw new BadRequestException({
        message: 'Enter the account name and number',
        code: 'RETURN_DESTINATION_INVALID',
      });
    if (method === 'VODAFONE_CASH' && !/^01[0125]\d{8}$/.test(handle.replace(/^\+?20/, '0')))
      throw new BadRequestException({
        message: 'Enter the wallet number (01xxxxxxxxx)',
        code: 'RETURN_DESTINATION_INVALID',
      });
    return { method, details: { holderName, handle } };
  }

  /**
   * Open a return for a transfer nobody's purchase can take. The transfer is
   * claimed (RETURNED) in the same transaction, by compare-and-swap, so it can
   * no longer be matched or attached; the amount is the transfer's, never
   * typed. Nothing is booked in the ledger: the money never entered it.
   */
  async requestReturn(
    eventId: string,
    adminId: string,
    dto: { method?: string; holderName?: string; handle?: string; reason?: string },
  ) {
    const reason = (dto.reason ?? '').trim().slice(0, 500);
    if (reason.length < 3)
      throw new BadRequestException({ message: 'Say why', code: 'REASON_REQUIRED' });
    const d = this.destination(dto);
    const e = await this.event(eventId);
    const row = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.paymentEvent.updateMany({
        where: {
          id: eventId,
          status: { in: [...OPEN_EVENT] as any[] },
          matchedPaymentId: null,
          matchedTopupId: null,
        },
        data: { status: 'RETURNED' },
      });
      if (claim.count === 0) {
        throw new ConflictException({
          message: 'This transfer is already claimed',
          code: 'EVENT_ALREADY_CLAIMED',
        });
      }
      const prior = await tx.transferReturn.findUnique({ where: { paymentEventId: eventId } });
      const data = {
        amountCents: e.amountCents,
        destinationMethod: d.method,
        destinationDetails: d.details as never,
        reason,
        status: 'REQUESTED' as const,
        requestedById: adminId,
        approvedById: null,
        approvedAt: null,
        completedById: null,
        completedAt: null,
        transferReference: null,
        cancelledById: null,
        cancelledAt: null,
        cancelReason: null,
      };
      // A return cancelled earlier is reopened (one row per transfer).
      if (prior) {
        if (prior.status !== 'CANCELLED') {
          throw new ConflictException({
            message: 'A return is already open',
            code: 'RETURN_ALREADY_OPEN',
          });
        }
        return tx.transferReturn.update({ where: { id: prior.id }, data });
      }
      return tx.transferReturn.create({ data: { paymentEventId: eventId, ...data } });
    });
    await this.audit(adminId, 'transfer.return.request', eventId, {
      returnId: row.id,
      amountCents: row.amountCents,
      reason,
    });
    return row;
  }

  async approveReturn(returnId: string, adminId: string) {
    const r = await this.prisma.transferReturn.updateMany({
      where: { id: returnId, status: 'REQUESTED' },
      data: { status: 'APPROVED', approvedById: adminId, approvedAt: new Date() },
    });
    const row = await this.prisma.transferReturn.findUnique({ where: { id: returnId } });
    if (!row) throw new NotFoundException('Return not found');
    if (r.count === 0 && row.status !== 'APPROVED') {
      throw new ConflictException({
        message: 'This return is not waiting for approval',
        code: 'RETURN_STATE_CONFLICT',
      });
    }
    if (r.count)
      await this.audit(adminId, 'transfer.return.approve', row.paymentEventId, { returnId });
    return row;
  }

  /** Finance sent the money back. Once: a second press finds it COMPLETED. */
  async completeReturn(returnId: string, adminId: string, transferReference: string) {
    const ref = (transferReference ?? '').trim().slice(0, 120);
    if (ref.length < 3)
      throw new BadRequestException({
        message: 'Enter the transfer reference',
        code: 'TRANSFER_REFERENCE_REQUIRED',
      });
    const r = await this.prisma.transferReturn.updateMany({
      where: { id: returnId, status: 'APPROVED' },
      data: {
        status: 'COMPLETED',
        completedById: adminId,
        completedAt: new Date(),
        transferReference: ref,
      },
    });
    const row = await this.prisma.transferReturn.findUnique({ where: { id: returnId } });
    if (!row) throw new NotFoundException('Return not found');
    if (r.count === 0 && row.status !== 'COMPLETED') {
      throw new ConflictException({
        message: 'Approve the return first',
        code: 'RETURN_STATE_CONFLICT',
      });
    }
    if (r.count)
      await this.audit(adminId, 'transfer.return.complete', row.paymentEventId, {
        returnId,
        transferReference: ref,
      });
    return row;
  }

  /** Called off before the money left: the transfer is open again (match / attach / a new return). */
  async cancelReturn(returnId: string, adminId: string, reason: string) {
    const why = (reason ?? '').trim().slice(0, 500);
    if (why.length < 3)
      throw new BadRequestException({ message: 'Say why', code: 'REASON_REQUIRED' });
    const row = await this.prisma.$transaction(async (tx) => {
      const r = await tx.transferReturn.updateMany({
        where: { id: returnId, status: { in: ['REQUESTED', 'APPROVED'] } },
        data: {
          status: 'CANCELLED',
          cancelledById: adminId,
          cancelledAt: new Date(),
          cancelReason: why,
        },
      });
      const cur = await tx.transferReturn.findUnique({ where: { id: returnId } });
      if (!cur) throw new NotFoundException('Return not found');
      if (r.count === 0) {
        throw new ConflictException({
          message: 'Only an open return can be cancelled',
          code: 'RETURN_STATE_CONFLICT',
        });
      }
      await tx.paymentEvent.updateMany({
        where: { id: cur.paymentEventId, status: 'RETURNED' },
        data: { status: 'UNMATCHED' },
      });
      return cur;
    });
    await this.audit(adminId, 'transfer.return.cancel', row.paymentEventId, {
      returnId,
      reason: why,
    });
    return row;
  }
}
