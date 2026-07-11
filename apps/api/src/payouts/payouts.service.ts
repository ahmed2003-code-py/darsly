import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
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

  private async minimumCents(): Promise<number> {
    const s = await this.prisma.platformSetting.findUnique({ where: { key: 'payout.minimumCents' } });
    return Number((s?.value as number) ?? 50000);
  }

  // ── Teacher: payout methods ───────────────────────────────────────────────

  listMethods(tenantId: string) {
    return this.prisma.payoutMethodSaved.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async addMethod(tenantId: string, method: PayoutMethod, details: Record<string, unknown>, isDefault: boolean) {
    if (isDefault) {
      await this.prisma.payoutMethodSaved.updateMany({ where: { tenantId }, data: { isDefault: false } });
    }
    const count = await this.prisma.payoutMethodSaved.count({ where: { tenantId } });
    return this.prisma.payoutMethodSaved.create({
      data: { tenantId, method, details: details as any, isDefault: isDefault || count === 0 },
    });
  }

  async removeMethod(tenantId: string, id: string) {
    const m = await this.prisma.payoutMethodSaved.findFirst({ where: { id, tenantId } });
    if (!m) throw new NotFoundException('Method not found');
    await this.prisma.payoutMethodSaved.delete({ where: { id } });
    return { id, deleted: true };
  }

  // ── Teacher: request a payout ─────────────────────────────────────────────

  async request(tenantId: string, amountCents: number, methodId: string) {
    const method = await this.prisma.payoutMethodSaved.findFirst({ where: { id: methodId, tenantId } });
    if (!method) throw new NotFoundException('Payout method not found');

    const min = await this.minimumCents();
    if (amountCents < min) {
      throw new BadRequestException(`Minimum payout is ${min / 100} EGP`);
    }
    const balance = await this.ledger.teacherBalance(tenantId);
    if (amountCents > balance) {
      throw new BadRequestException('Amount exceeds your withdrawable balance');
    }
    // Block a second pending request that would overdraw the balance.
    const pending = await this.prisma.payoutRequest.aggregate({
      where: { tenantId, status: { in: ['REQUESTED', 'APPROVED', 'PROCESSING'] } },
      _sum: { amountCents: true },
    });
    if ((pending._sum.amountCents ?? 0) + amountCents > balance) {
      throw new BadRequestException('You already have pending payouts covering this balance');
    }

    return this.prisma.payoutRequest.create({
      data: {
        tenantId,
        amountCents,
        method: method.method,
        destination: method.details as any,
        status: 'REQUESTED',
      },
    });
  }

  teacherList(tenantId: string) {
    return this.prisma.payoutRequest.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } });
  }

  // ── Admin: process payouts ────────────────────────────────────────────────

  adminList(status?: PayoutStatus) {
    return this.prisma.payoutRequest.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'asc' },
      include: { teacher: { include: { user: { select: { fullName: true } } } } },
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
      include: { teacher: { select: { userId: true } } },
    });
    if (!payout) throw new NotFoundException('Payout not found');
    if (['COMPLETED', 'REJECTED'].includes(payout.status)) {
      throw new BadRequestException('Payout is already finalized');
    }

    const updated = await this.prisma.payoutRequest.update({
      where: { id },
      data: { status, adminNote: note, processedBy: adminUserId, processedAt: new Date() },
    });

    if (status === 'COMPLETED') {
      await this.ledger.recordPayout(id);
      await this.notifications.create({
        userId: payout.teacher.userId,
        type: 'PAYOUT_STATUS',
        title: 'تم تحويل مستحقاتك',
        body: `تم إتمام سحب بقيمة ${(payout.amountCents / 100).toFixed(0)} ج.م`,
        meta: { payoutId: id },
      });
    } else if (status === 'REJECTED') {
      await this.notifications.create({
        userId: payout.teacher.userId,
        type: 'PAYOUT_STATUS',
        title: 'رُفض طلب السحب',
        body: note ?? 'تم رفض طلب السحب من الإدارة.',
        meta: { payoutId: id },
      });
    }
    return updated;
  }
}
