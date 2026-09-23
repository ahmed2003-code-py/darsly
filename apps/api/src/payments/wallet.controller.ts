import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload } from '@darsly/shared-types';
import { AcademyContext, CurrentAcademy } from '../academy/academy-context';
import { AcademyStaff } from '../academy/academy-staff.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from './ledger.service';

/**
 * The workspace wallet (Phase 7: organisation-aware).
 *
 * OWNER / platform admin: the ORGANISATION's money — a Center's own account,
 * or the teacher's for a PERSONAL workspace. A member who is not the owner
 * (a teacher inside a Center) gets THEIR OWN slice instead: their earnings
 * from courses they authored here and their personal balance — never the
 * Center's revenue, never another teacher's.
 */
@ApiTags('wallet')
@AcademyStaff('wallet.read')
@Controller('teacher/wallet')
export class WalletController {
  constructor(
    private readonly ledger: LedgerService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      '[academy] Wallet: balance, earnings, pending cash, recent payments + payouts (owner: the organisation; member: own slice)',
  })
  async wallet(@CurrentUser() user: JwtPayload, @CurrentAcademy() ctx: AcademyContext) {
    const academy = await this.prisma.academy.findUniqueOrThrow({
      where: { id: ctx.academyId },
      select: { id: true, kind: true, teacherSharePercent: true },
    });
    const wholeOrg = ctx.role === 'OWNER' || ctx.isPlatformAdmin;
    if (!wholeOrg) return this.memberSlice(user, ctx, academy);

    const academyId = academy.id;
    const [
      balanceCents,
      cashOwedCents,
      earnings,
      pendingSettlement,
      pendingCash,
      cashCollected,
      fees,
      teacherShares,
      payments,
      payouts,
      minSetting,
    ] = await Promise.all([
      this.ledger.orgBalance(academy),
      // Cash this organisation physically collected but has not yet remitted
      // (platform fee, plus — for a Center — any teacher share it is holding).
      // A DEDICATED account, never inferred from balanceCents: balanceCents is
      // pure earnings and can no longer go negative from a cash collection.
      academy.kind === 'CENTER'
        ? this.ledger.orgCashOwed(academyId)
        : this.ledger.teacherCashOwed(academyId),
      this.ledger.orgEarnings(academy),
      // Verified-but-not-yet-settled earnings: activated for the student, but held
      // (not withdrawable) until a trusted payment-event or an admin settles them.
      this.prisma.payment.aggregate({
        where: { academyId, status: 'PAID', settledAt: null },
        _sum: { netCents: true },
      }),
      // Cash claims waiting for the receiver to confirm them.
      this.prisma.payment.aggregate({
        where: { academyId, status: 'PENDING', method: 'CASH' },
        _sum: { amountCents: true },
        _count: { _all: true },
      }),
      // Cash this organisation has actually collected (gross, confirmed) —
      // the other half of the picture next to cashOwedCents: what came in,
      // vs. how much of it still needs to be remitted.
      this.prisma.payment.aggregate({
        where: {
          academyId,
          status: 'PAID',
          method: 'CASH',
          cashReceiver: academy.kind === 'CENTER' ? 'CENTER' : 'TEACHER',
        },
        _sum: { amountCents: true },
      }),
      // The platform fee on this organisation's payments (a Center sees the
      // fee its students paid; a teacher never needed it before, so it stays
      // out of the PERSONAL response below).
      this.prisma.ledgerEntry.aggregate({
        where: { academyId, account: 'platform:commission', direction: 'CREDIT' },
        _sum: { amountCents: true },
      }),
      // What was credited to teachers out of this Center's sales.
      academy.kind === 'CENTER'
        ? this.prisma.ledgerEntry.aggregate({
            where: { academyId, account: { startsWith: 'teacher:' }, direction: 'CREDIT' },
            _sum: { amountCents: true },
          })
        : Promise.resolve(null),
      this.prisma.payment.findMany({
        where: { academyId, status: 'PAID' },
        orderBy: { paidAt: 'desc' },
        take: 10,
        include: {
          course: { select: { title: true } },
          student: { include: { user: { select: { fullName: true } } } },
          invoice: { select: { serial: true } },
        },
      }),
      this.prisma.payoutRequest.findMany({
        where: { academyId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      this.prisma.platformSetting.findUnique({ where: { key: 'payout.minimumCents' } }),
    ]);

    return {
      scope: 'ORGANISATION' as const,
      kind: academy.kind,
      balanceCents,
      // Money still to remit from cash this organisation has physically
      // collected — never part of balanceCents/available payout (see
      // LedgerService.cashLiabilityAccount). Shown separately so a healthy
      // teacher/Center never reads a confusing negative "balance".
      cashOwedCents,
      cashCollectedCents: cashCollected._sum.amountCents ?? 0,
      ...earnings,
      pendingSettlementCents: pendingSettlement._sum.netCents ?? 0,
      pendingCashCents: pendingCash._sum.amountCents ?? 0,
      pendingCashCount: pendingCash._count._all,
      ...(academy.kind === 'CENTER'
        ? {
            platformFeeCents: fees._sum.amountCents ?? 0,
            teacherSharesCents: teacherShares?._sum.amountCents ?? 0,
            teacherSharePercent: academy.teacherSharePercent,
          }
        : {}),
      payoutMinimumCents: Number((minSetting?.value as number) ?? 50000),
      recentPayments: payments.map((p) => ({
        id: p.id,
        // The academy's earning, not the total the student paid — the difference
        // between the two IS the platform fee, so showing the total leaks it.
        amountCents: p.netCents ?? p.amountCents,
        method: p.method,
        cashReceiver: p.cashReceiver,
        courseTitle: p.course.title,
        studentName: p.student.user.fullName,
        invoiceSerial: p.invoice?.serial ?? null,
        paidAt: p.paidAt,
      })),
      payouts,
    };
  }

  /** A non-owner member's own money in this workspace. */
  private async memberSlice(
    user: JwtPayload,
    ctx: AcademyContext,
    academy: { id: string; kind: 'PERSONAL' | 'CENTER' },
  ) {
    const tenantId = user.tenantId;
    if (!tenantId) {
      return {
        scope: 'MEMBER' as const,
        kind: academy.kind,
        balanceCents: 0,
        cashOwedCents: 0,
        cashCollectedCents: 0,
        netCents: 0,
        earnedHereCents: 0,
        pendingCashCents: 0,
        pendingCashCount: 0,
        recentPayments: [],
        payouts: [],
      };
    }
    const account = `teacher:${tenantId}:balance`;
    const [credits, debits, cashOwedCents, earnedHere, pendingCash, cashCollected, payments] =
      await Promise.all([
        this.prisma.ledgerEntry.aggregate({
          where: { account, direction: 'CREDIT' },
          _sum: { amountCents: true },
        }),
        this.prisma.ledgerEntry.aggregate({
          where: { account, direction: 'DEBIT' },
          _sum: { amountCents: true },
        }),
        // Cash THIS teacher personally collected but has not yet remitted — a
        // separate account from `account` above, never netted into it.
        this.ledger.teacherCashOwed(tenantId),
        this.prisma.ledgerEntry.aggregate({
          where: { account, academyId: academy.id, direction: 'CREDIT' },
          _sum: { amountCents: true },
        }),
        this.prisma.payment.aggregate({
          where: {
            academyId: academy.id,
            tenantId,
            status: 'PENDING',
            method: 'CASH',
            cashReceiver: 'TEACHER',
          },
          _sum: { amountCents: true },
          _count: { _all: true },
        }),
        this.prisma.payment.aggregate({
          where: {
            academyId: academy.id,
            tenantId,
            status: 'PAID',
            method: 'CASH',
            cashReceiver: 'TEACHER',
          },
          _sum: { amountCents: true },
        }),
        this.prisma.payment.findMany({
          where: { academyId: academy.id, tenantId, status: 'PAID' },
          orderBy: { paidAt: 'desc' },
          take: 10,
          include: {
            course: { select: { title: true } },
            student: { include: { user: { select: { fullName: true } } } },
          },
        }),
      ]);
    const balanceCents = (credits._sum.amountCents ?? 0) - (debits._sum.amountCents ?? 0);
    // What THIS teacher was credited per payment (their share, not the course net).
    const mine = await this.prisma.ledgerEntry.findMany({
      where: {
        account,
        direction: 'CREDIT',
        transaction: { paymentId: { in: payments.map((p) => p.id) } },
      },
      select: { amountCents: true, transaction: { select: { paymentId: true } } },
    });
    const shareOf = new Map(mine.map((e) => [e.transaction.paymentId, e.amountCents]));
    return {
      scope: 'MEMBER' as const,
      kind: academy.kind,
      balanceCents,
      cashOwedCents,
      cashCollectedCents: cashCollected._sum.amountCents ?? 0,
      netCents: credits._sum.amountCents ?? 0,
      earnedHereCents: earnedHere._sum.amountCents ?? 0,
      pendingCashCents: pendingCash._sum.amountCents ?? 0,
      pendingCashCount: pendingCash._count._all,
      recentPayments: payments.map((p) => ({
        id: p.id,
        amountCents: shareOf.get(p.id) ?? 0,
        method: p.method,
        cashReceiver: p.cashReceiver,
        courseTitle: p.course.title,
        studentName: p.student.user.fullName,
        paidAt: p.paidAt,
      })),
      payouts: [],
    };
  }
}
