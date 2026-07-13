import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AcademyContext, CurrentAcademy } from '../academy/academy-context';
import { AcademyStaff } from '../academy/academy-staff.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from './ledger.service';

/** Academy wallet: withdrawable balance, lifetime earnings, recent revenue. */
@ApiTags('wallet')
@AcademyStaff('wallet.read')
@Controller('teacher/wallet')
export class WalletController {
  constructor(
    private readonly ledger: LedgerService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @ApiOperation({ summary: '[teacher] Wallet: balance, earnings, recent payments + payouts' })
  async wallet(@CurrentAcademy() ctx: AcademyContext) {
    const tenantId = ctx.academyId;
    const [balanceCents, earnings, payments, payouts, minSetting] = await Promise.all([
      this.ledger.teacherBalance(tenantId),
      this.ledger.teacherEarnings(tenantId),
      this.prisma.payment.findMany({
        where: { tenantId, status: 'PAID' },
        orderBy: { paidAt: 'desc' },
        take: 10,
        include: {
          course: { select: { title: true } },
          student: { include: { user: { select: { fullName: true } } } },
          invoice: { select: { serial: true } },
        },
      }),
      this.prisma.payoutRequest.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      this.prisma.platformSetting.findUnique({ where: { key: 'payout.minimumCents' } }),
    ]);

    return {
      balanceCents,
      ...earnings,
      payoutMinimumCents: Number((minSetting?.value as number) ?? 50000),
      recentPayments: payments.map((p) => ({
        id: p.id,
        amountCents: p.amountCents,
        courseTitle: p.course.title,
        studentName: p.student.user.fullName,
        invoiceSerial: p.invoice?.serial ?? null,
        paidAt: p.paidAt,
      })),
      payouts,
    };
  }
}
