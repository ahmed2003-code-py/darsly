import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PayoutMethod, PayoutStatus } from '@darsly/shared-types';
import { LedgerService } from '../payments/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PayoutsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Phase 7: payouts belong to an ORGANISATION's balance account. For a
   * PERSONAL workspace that is the teacher's (academyId == tenantId, as
   * before); for a Center it is the Center's own — never the teacher's, and
   * never another Center's. The workspace comes from the validated context,
   * so the caller cannot name a scope they are not the owner of.
   */
  private async orgOf(academyId: string) {
    const academy = await this.prisma.academy.findUnique({ where: { id: academyId }, select: { id: true, kind: true, ownerUserId: true } });
    if (!academy) throw new NotFoundException('Academy not found');
    return academy;
  }

  private async minimumCents(): Promise<number> {
    const s = await this.prisma.platformSetting.findUnique({ where: { key: 'payout.minimumCents' } });
    return Number((s?.value as number) ?? 50000);
  }

  // ── Teacher: payout methods ───────────────────────────────────────────────

  listMethods(academyId: string) {
    return this.prisma.payoutMethodSaved.findMany({
      where: { academyId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async addMethod(academyId: string, method: PayoutMethod, details: Record<string, unknown>, isDefault: boolean) {
    const academy = await this.orgOf(academyId);
    if (isDefault) {
      await this.prisma.payoutMethodSaved.updateMany({ where: { academyId }, data: { isDefault: false } });
    }
    const count = await this.prisma.payoutMethodSaved.count({ where: { academyId } });
    return this.prisma.payoutMethodSaved.create({
      // tenantId kept for a PERSONAL workspace (legacy readers); a Center's method has none.
      data: { academyId, tenantId: academy.kind === 'PERSONAL' ? academyId : null, method, details: details as any, isDefault: isDefault || count === 0 },
    });
  }

  async removeMethod(academyId: string, id: string) {
    const m = await this.prisma.payoutMethodSaved.findFirst({ where: { id, academyId } });
    if (!m) throw new NotFoundException('Method not found');
    await this.prisma.payoutMethodSaved.delete({ where: { id } });
    return { id, deleted: true };
  }

  // ── Teacher: request a payout ─────────────────────────────────────────────

  async request(academyId: string, amountCents: number, methodId: string) {
    const academy = await this.orgOf(academyId);
    const method = await this.prisma.payoutMethodSaved.findFirst({ where: { id: methodId, academyId } });
    if (!method) throw new NotFoundException('Payout method not found');

    const min = await this.minimumCents();
    if (amountCents < min) {
      throw new BadRequestException(`Minimum payout is ${min / 100} EGP`);
    }

    // Serializable: the balance/pending read and the insert must be one unit, or
    // two concurrent requests could each see the full balance and both pass,
    // overdrawing the teacher's balance (double-withdrawal). Postgres aborts one
    // of two conflicting serializable txns → surfaced as a retryable conflict.
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const balance = await this.ledger.orgBalance(academy, tx);
          if (amountCents > balance) {
            throw new BadRequestException({ message: 'Amount exceeds your withdrawable balance', code: 'PAYOUT_EXCEEDS_BALANCE' });
          }
          const pending = await tx.payoutRequest.aggregate({
            where: { academyId, status: { in: ['REQUESTED', 'APPROVED', 'PROCESSING'] } },
            _sum: { amountCents: true },
          });
          if ((pending._sum.amountCents ?? 0) + amountCents > balance) {
            throw new BadRequestException({ message: 'You already have pending payouts covering this balance', code: 'PAYOUT_EXCEEDS_BALANCE' });
          }
          return tx.payoutRequest.create({
            data: {
              academyId,
              tenantId: academy.kind === 'PERSONAL' ? academyId : null,
              amountCents,
              method: method.method,
              destination: method.details as any,
              status: 'REQUESTED',
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2034') {
        throw new ConflictException('A concurrent payout request was in progress — please try again');
      }
      throw e;
    }
  }

  teacherList(academyId: string) {
    return this.prisma.payoutRequest.findMany({ where: { academyId }, orderBy: { createdAt: 'desc' } });
  }

  // ── Admin: process payouts ────────────────────────────────────────────────

  adminList(status?: PayoutStatus) {
    return this.prisma.payoutRequest.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'asc' },
      include: {
        teacher: { include: { user: { select: { fullName: true } } } },
        academy: { select: { id: true, name: true, kind: true } },
      },
    });
  }

  /**
   * Move a payout through its lifecycle. On COMPLETED the ledger is booked
   * (debit teacher balance, credit platform cash) and the teacher notified.
   * Valid transitions: REQUESTED→APPROVED→PROCESSING→COMPLETED, or *→REJECTED.
   */
  async process(id: string, status: PayoutStatus, adminUserId: string, note?: string) {
    const payout = await this.prisma.payoutRequest.findUnique({
      where: { id },
      include: { teacher: { select: { userId: true } }, academy: { select: { id: true, kind: true, ownerUserId: true } } },
    });
    if (!payout) throw new NotFoundException('Payout not found');
    // Whose balance this draws on (a legacy row has academyId backfilled == tenantId).
    const org = payout.academy ?? (payout.tenantId ? { id: payout.tenantId, kind: 'PERSONAL' as const, ownerUserId: payout.teacher?.userId ?? '' } : null);
    if (!org) throw new BadRequestException({ message: 'Payout has no organisation', code: 'PAYOUT_UNSCOPED' });
    const notifyUserId = payout.teacher?.userId ?? org.ownerUserId;
    if (['COMPLETED', 'REJECTED'].includes(payout.status)) {
      throw new BadRequestException('Payout is already finalized');
    }

    // The write itself refuses a finalised row. Two admins acting at once used
    // to both get through the check above: one completed it (and debited the
    // teacher), the other then overwrote it as rejected — money gone, payout
    // showing refused.
    const open = { id, status: { notIn: ['COMPLETED', 'REJECTED'] as PayoutStatus[] } };
    const data = { status, adminNote: note, processedBy: adminUserId, processedAt: new Date() };
    let updated;
    if (status === 'COMPLETED') {
      // Re-validate the balance at completion (it may have dropped since the
      // request) and book the debit atomically with the status change.
      updated = await this.prisma.$transaction(
        async (tx) => {
          const balance = await this.ledger.orgBalance(org, tx);
          if (payout.amountCents > balance) {
            throw new BadRequestException({ message: 'Balance no longer covers this payout', code: 'PAYOUT_EXCEEDS_BALANCE' });
          }
          const flip = await tx.payoutRequest.updateMany({ where: open, data });
          if (flip.count === 0) throw new BadRequestException('Payout is already finalized');
          await this.ledger.recordPayout(id, tx);
          return tx.payoutRequest.findUniqueOrThrow({ where: { id } });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } else {
      const flip = await this.prisma.payoutRequest.updateMany({ where: open, data });
      if (flip.count === 0) throw new BadRequestException('Payout is already finalized');
      updated = await this.prisma.payoutRequest.findUniqueOrThrow({ where: { id } });
    }

    if (status === 'COMPLETED') {
      await this.notifications.create({
        userId: notifyUserId,
        type: 'PAYOUT_STATUS',
        title: 'تم تحويل مستحقاتك',
        body: `تم إتمام سحب بقيمة ${(payout.amountCents / 100).toFixed(0)} ج.م`,
        meta: { payoutId: id },
      });
    } else if (status === 'REJECTED') {
      await this.notifications.create({
        userId: notifyUserId,
        type: 'PAYOUT_STATUS',
        title: 'رُفض طلب السحب',
        body: note ?? 'تم رفض طلب السحب من الإدارة.',
        meta: { payoutId: id },
      });
    }
    return updated;
  }
}
